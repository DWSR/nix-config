import contextlib
import io
import json
import os
import pathlib
import re
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
GRAPH = ROOT / ".fabro/workflows/dispatch/workflow.fabro"

VERSIONS = {
    "kiro_spec_workflow_version": "version-kiro",
    "oneshot_workflow_version": "version-oneshot",
    "dependabot_workflow_version": "version-dependabot",
    "security_remediation_workflow_version": "version-security-remediation",
}


def load_scripts() -> list[str]:
    """Return the decoded contents of every script="..." attribute in the graph."""
    text = GRAPH.read_text()
    scripts = []
    index = 0
    while True:
        start = text.find('script="', index)
        if start < 0:
            return scripts
        cursor = start + len('script="')
        chunks = []
        while cursor < len(text):
            char = text[cursor]
            if char == "\\":
                chunks.append(text[cursor : cursor + 2])
                cursor += 2
                continue
            if char == '"':
                break
            chunks.append(char)
            cursor += 1
        scripts.append("".join(chunks).encode().decode("unicode_escape"))
        index = cursor + 1


def match_script() -> str:
    script = next(source for source in load_scripts() if "DEPENDABOT_RULE" in source)

    def replace(match: re.Match[str]) -> str:
        return json.dumps(VERSIONS[match.group(1)])

    return re.sub(r"\{\{\s*vars\.(\w+)\s*\}\}", replace, script)


def normalize_script() -> str:
    return next(source for source in load_scripts() if "stack_issue_numbers" in source)


def remediation_filter_script() -> str:
    return next(source for source in load_scripts() if "security_remediation_disabled" in source)


def run_script(script: str, queue: dict) -> tuple[dict, dict]:
    """Run a plan stage script against a temporary queue file and return plan + context."""
    with tempfile.TemporaryDirectory() as tmp:
        git_dir = pathlib.Path(tmp) / ".git"
        git_dir.mkdir()
        (git_dir / "dispatch-queue.json").write_text(json.dumps(queue))
        output = io.StringIO()
        previous = os.getcwd()
        os.chdir(tmp)
        try:
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                exec(compile(script, str(GRAPH), "exec"), {"__name__": "__main__"})
            plan = json.loads((git_dir / "dispatch-plan.json").read_text())
        finally:
            os.chdir(previous)
        return plan, json.loads(output.getvalue())["context_updates"]


def run_plan_script(script: str, plan: dict) -> tuple[dict, dict]:
    with tempfile.TemporaryDirectory() as tmp:
        git_dir = pathlib.Path(tmp) / ".git"
        git_dir.mkdir()
        (git_dir / "dispatch-plan.json").write_text(json.dumps(plan))
        output = io.StringIO()
        previous = os.getcwd()
        os.chdir(tmp)
        try:
            with contextlib.redirect_stdout(output):
                exec(compile(script, str(GRAPH), "exec"), {"__name__": "__main__"})
            written = json.loads((git_dir / "dispatch-plan.json").read_text())
        finally:
            os.chdir(previous)
        return written, json.loads(output.getvalue())["context_updates"]


def queue_with(remediation: dict, **fields) -> dict:
    queue = {
        "repo": "DWSR/nix-config",
        "default_branch": "main",
        "issues": [],
        "pull_requests": [],
        "findings": [],
        "remediation": remediation,
    }
    queue.update(fields)
    return queue


SELECTED = {
    "source": "dependabot",
    "number": 12,
    "title": "Prototype pollution in lodash",
    "url": "https://github.com/DWSR/nix-config/security/dependabot/12",
}


class MatchFindingRuleTests(unittest.TestCase):
    def test_selected_finding_emits_one_pinned_plan_entry(self):
        plan, context = run_script(
            match_script(),
            queue_with({"selected": SELECTED, "active_run": None}),
        )

        self.assertEqual(len(plan["entries"]), 1)
        entry = plan["entries"][0]
        self.assertEqual(entry["kind"], "finding")
        self.assertEqual(entry["number"], "dependabot:12")
        self.assertEqual(entry["alert_source"], "dependabot")
        self.assertEqual(entry["alert_number"], 12)
        self.assertEqual(entry["title"], SELECTED["title"])
        self.assertEqual(entry["url"], SELECTED["url"])
        self.assertEqual(entry["workflow"], "security-remediation")
        self.assertEqual(entry["workflow_version_id"], "version-security-remediation")
        self.assertEqual(entry["input_key"], "finding")
        self.assertEqual(entry["label_swap"], "none")
        self.assertEqual(context["has_plan"], "true")

    def test_security_remediation_filter_blocks_findings_and_keeps_other_entries(self):
        plan, _context = run_script(
            match_script(),
            queue_with(
                {"selected": SELECTED, "active_run": None},
                issues=[{
                    "number": 7,
                    "title": "spec issue",
                    "url": "",
                    "labels": ["type/kiro-spec"],
                }],
            ),
        )

        filtered, context = run_plan_script(remediation_filter_script(), plan)

        self.assertEqual([entry["number"] for entry in filtered["entries"]], [7])
        self.assertEqual(filtered["entries"][0]["workflow"], "kiro-spec")
        self.assertEqual(filtered["skipped"], [{
            "finding": "dependabot:12",
            "reason": "security_remediation_disabled",
        }])
        self.assertEqual(context["has_plan"], "true")

    def test_security_remediation_only_plan_routes_without_dispatch(self):
        plan, _context = run_script(
            match_script(),
            queue_with({"selected": SELECTED, "active_run": None}),
        )

        filtered, context = run_plan_script(remediation_filter_script(), plan)

        self.assertEqual(filtered["entries"], [])
        self.assertEqual(context["has_plan"], "false")
        self.assertEqual(filtered["skipped"], [{
            "finding": "dependabot:12",
            "reason": "security_remediation_disabled",
        }])

    def test_active_remediation_run_emits_no_finding_entry(self):
        plan, context = run_script(
            match_script(),
            queue_with({"selected": SELECTED, "active_run": "run-1"}),
        )

        self.assertEqual(plan["entries"], [])
        self.assertEqual(context["has_plan"], "false")

    def test_no_selected_finding_emits_no_finding_entry(self):
        plan, context = run_script(
            match_script(),
            queue_with({"selected": None, "active_run": None}),
        )

        self.assertEqual(plan["entries"], [])
        self.assertEqual(context["has_plan"], "false")

    def test_issue_ambiguity_check_is_unchanged(self):
        queue = queue_with(
            {"selected": None, "active_run": None},
            issues=[
                {
                    "number": 7,
                    "title": "ambiguous",
                    "url": "",
                    "labels": ["type/kiro-spec", "type/oneshot"],
                }
            ],
        )
        with self.assertRaises(SystemExit) as caught:
            run_script(match_script(), queue)

        self.assertIn("ambiguous type labels", str(caught.exception.code))

    def test_normalize_leaves_finding_entries_untouched(self):
        queue = queue_with({"selected": None, "active_run": None})
        plan = {
            "repo": queue["repo"],
            "default_branch": "main",
            "entries": [{"kind": "finding", "number": "dependabot:12", "label_swap": "none"}],
            "ambiguous": [],
            "skipped": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            (git_dir / "dispatch-queue.json").write_text(json.dumps(queue))
            (git_dir / "dispatch-plan.json").write_text(json.dumps(plan))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    exec(compile(normalize_script(), str(GRAPH), "exec"), {"__name__": "__main__"})
                written = json.loads((git_dir / "dispatch-plan.json").read_text())
            finally:
                os.chdir(previous)

        self.assertEqual(written["entries"], plan["entries"])


if __name__ == "__main__":
    unittest.main()
