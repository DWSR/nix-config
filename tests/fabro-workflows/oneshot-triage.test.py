import contextlib
import io
import json
import os
import pathlib
import re
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot"
TOOLS = WORKFLOW / "scripts" / "tools.py"
GRAPH = WORKFLOW / "workflow.fabro"
IMPLEMENT = WORKFLOW / "prompts" / "implement.md"
STATE_PATH = ".git/oneshot-state.json"
ISSUE_NUMBER = 377
EDGE = re.compile(
    r'^\s*(\w+)\s*->\s*(\w+)'
    r'(?:\s*\[(?:condition="([^"]+)")?(?:,\s*weight=(\d+))?\])?\s*$')


def load_tools():
    namespace = {"__name__": "oneshot_triage_test", "__file__": str(TOOLS)}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def issue(title, body, labels=("fabro-ready", "type/oneshot")):
    return {
        "number": ISSUE_NUMBER,
        "state": "open",
        "title": title,
        "body": body,
        "html_url": "https://github.com/example/project/issues/377",
        "labels": [{"name": name} for name in labels],
    }


def condition_matches(condition, context):
    for clause in condition.split(" && "):
        key, sep, value = clause.strip().partition("!=")
        if sep:
            if context.get(key[len("context."):], "") == value:
                return False
            continue
        key, _sep, value = clause.strip().partition("=")
        if key == "outcome":
            continue
        if context.get(key[len("context."):], "") != value:
            return False
    return True


def route(graph, source, context):
    selected = None
    for line in graph.splitlines():
        match = EDGE.match(line)
        if match is None or match.group(1) != source:
            continue
        condition = match.group(3) or ""
        if condition_matches(condition, context):
            candidate = (int(match.group(4) or 0), match.group(2), condition)
            if selected is None or candidate[0] > selected[0]:
                selected = candidate
    return selected


class IssueModeClassificationTests(unittest.TestCase):
    def test_each_triage_marker_selects_triage(self):
        tools = load_tools()
        self.assertEqual(
            tools["issue_mode"]("Investigate the failure", "body",
                                {"fabro-failure-triage"}),
            "triage")
        self.assertEqual(
            tools["issue_mode"]("Investigate the failure",
                                "body\n\n<!-- fabro-failure-triage:abc123 -->",
                                set()),
            "triage")
        self.assertEqual(
            tools["issue_mode"]("[FABRO-FAILURE-TRIAGE] Investigate the failure",
                                "body", set()),
            "triage")

    def test_prose_mentions_and_unrelated_labels_stay_standard(self):
        tools = load_tools()
        self.assertEqual(
            tools["issue_mode"]("Investigate the failure",
                                "This is not a <!-- comment --> triage issue.", set()),
            "standard")
        self.assertEqual(
            tools["issue_mode"]("fabro-failure-triage: not a prefix", "body",
                                {"type/oneshot"}),
            "standard")


class PrepareModeTests(unittest.TestCase):
    def run_prepare(self, issue_object):
        tools = load_tools()
        tools["github_reachability_blocker"] = lambda: ""
        tools["origin_repo"] = lambda: ("example", "project")
        tools["detect_trunk"] = lambda: "main"
        tools["live_oneshot_runs"] = lambda *_args: []
        tools["load_meta"] = lambda _number: (None, None)
        tools["record_fingerprint"] = lambda *_args, **_kwargs: None
        tools["persist_meta_state"] = lambda *_args, **_kwargs: ""

        def fake_run(command, check=True, env=None):
            if command[-2:] == ["rev-parse", "HEAD"]:
                return "f" * 40
            return ""

        def fake_gh(method, path, body=None, expect=(200, 201, 204)):
            if method == "GET" and path.endswith("/issues/%d" % ISSUE_NUMBER):
                return 200, issue_object
            return 200, None

        tools["run"] = fake_run
        tools["gh"] = fake_gh
        with tempfile.TemporaryDirectory() as tmp:
            work = pathlib.Path(tmp)
            (work / ".git").mkdir()
            previous = os.getcwd()
            os.chdir(work)
            try:
                output = io.StringIO()
                with contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["prepare"]([str(ISSUE_NUMBER)])
                report = json.loads(output.getvalue().strip().splitlines()[-1])
                state = json.loads((work / STATE_PATH).read_text())
            finally:
                os.chdir(previous)
        return report["context_updates"], state

    def test_prepare_records_triage_mode_for_a_label(self):
        context, state = self.run_prepare(issue(
            "Investigate the failure", "body",
            labels=("fabro-ready", "type/oneshot", "fabro-failure-triage")))

        self.assertEqual(context["issue_mode"], "triage")
        self.assertEqual(state["issue_mode"], "triage")

    def test_prepare_records_triage_mode_for_a_body_marker(self):
        context, state = self.run_prepare(issue(
            "Investigate the failure",
            "Cited runs:\n\n<!-- fabro-failure-triage:abc123 -->\n"))

        self.assertEqual(context["issue_mode"], "triage")
        self.assertEqual(state["issue_mode"], "triage")

    def test_prepare_records_triage_mode_for_a_title_prefix(self):
        context, state = self.run_prepare(issue(
            "[fabro-failure-triage] Investigate the failure", "body"))

        self.assertEqual(context["issue_mode"], "triage")
        self.assertEqual(state["issue_mode"], "triage")

    def test_prepare_keeps_non_triage_issues_standard(self):
        context, state = self.run_prepare(issue(
            "feat(oneshot): handle investigation issues", "Normal change."))

        self.assertEqual(context["issue_mode"], "standard")
        self.assertEqual(state["issue_mode"], "standard")


class TriagePromptTests(unittest.TestCase):
    def test_implement_prompt_carries_the_triage_contract(self):
        text = " ".join(IMPLEMENT.read_text().split())

        for phrase in (
                "`issue_mode`",
                "`triage`",
                "Investigate the cited runs and evidence",
                "narrowest safe in-repo mitigation",
                "## Findings",
                "## Remaining external work",
                "Return `BLOCKED` only when no safe in-repo mitigation exists",
                "stage_failure",
                "impl_concerns",
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)


class TriageRoutingTests(unittest.TestCase):
    def test_blocked_triage_routes_to_salvage_distinctly_from_standard(self):
        graph = GRAPH.read_text()
        triage = route(graph, "normalize_implement",
                       {"impl_status": "BLOCKED", "issue_mode": "triage"})
        standard = route(graph, "normalize_implement",
                         {"impl_status": "BLOCKED", "issue_mode": "standard"})

        self.assertEqual(triage, (10, "salvage",
                                  "context.impl_status=BLOCKED && context.issue_mode=triage"))
        self.assertEqual(standard, (0, "salvage", "context.impl_status=BLOCKED"))

    def test_approved_triage_still_routes_to_check(self):
        graph = GRAPH.read_text()
        selected = route(graph, "normalize_implement", {
            "impl_status": "READY",
            "failure_class_ok": "true",
            "failure_class": "none",
            "issue_mode": "triage",
        })

        self.assertEqual(selected[1], "check")


class TriageSalvageFindingsTests(unittest.TestCase):
    def normalize(self, mode, payload):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp, ".git")
            git_dir.mkdir()
            (git_dir / "oneshot-state.json").write_text(
                json.dumps({"issue": ISSUE_NUMBER, "issue_mode": mode}))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                return tools["normalize_stage_result"]("implement", payload)
            finally:
                os.chdir(previous)

    def test_blocked_triage_findings_reach_the_salvage_reason(self):
        payload = {
            "verdict": "BLOCKED",
            "failure_class": "code",
            "check_results": {},
            "stage_failure": "implement: no safe in-repo mitigation",
            "impl_concerns": "Findings: the cancel source is external. "
                             "Remaining external work: re-dispatch after the fix.",
        }

        updates = self.normalize("triage", payload)

        self.assertIn("no safe in-repo mitigation", updates["stage_failure"])
        self.assertIn("Findings: the cancel source is external", updates["stage_failure"])
        self.assertIn("Remaining external work: re-dispatch after the fix",
                      updates["stage_failure"])

    def test_standard_blocked_issues_keep_their_failure_reason(self):
        payload = {
            "verdict": "BLOCKED",
            "failure_class": "code",
            "check_results": {},
            "stage_failure": "implement: no safe in-repo mitigation",
            "impl_concerns": "Findings: unrelated",
        }

        updates = self.normalize("standard", payload)

        self.assertEqual(updates["stage_failure"],
                         "implement: no safe in-repo mitigation")


if __name__ == "__main__":
    unittest.main()
