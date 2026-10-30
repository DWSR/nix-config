import contextlib
import io
import json
import os
import pathlib
import re
import tempfile
import unittest
import urllib.error
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
GRAPH = ROOT / ".fabro/workflows/dispatch/workflow.fabro"
REPO = "DWSR/nix-config"
ACTIVE_STATUSES = ("pending", "runnable", "initializing", "running", "blocked")


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


def dispatch_script() -> str:
    script = next(source for source in load_scripts() if "RESULT_PATH" in source)

    def replace(match: re.Match[str]) -> str:
        values = {"ready_label": "fabro-ready", "running_label": "fabro-running"}
        return json.dumps(values[match.group(1)])

    return re.sub(r"\{\{\s*inputs\.(\w+)\s*\}\}", replace, script)


class FakeResponse:
    def __init__(self, payload):
        self.status = 200
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class FakeBridge:
    """Stand-in for the Fabro API bridge that records every request."""

    def __init__(self, runs=None, create_payload=None, start_status=None):
        self.runs = runs or []
        self.create_payload = create_payload
        self.start_status = start_status
        self.requests = []
        self.creates = []

    def urlopen(self, request, timeout=None):
        url = request.full_url
        method = request.get_method()
        self.requests.append((method, url))
        if "/runs?" in url:
            return FakeResponse({"data": self.runs})
        if re.search(r"/runs$", url) and method == "POST":
            body = json.loads(request.data or b"{}")
            self.creates.append(body)
            if self.create_payload is not None:
                return FakeResponse(self.create_payload)
            return FakeResponse({"id": "run-%d" % len(self.creates)})
        if re.search(r"/runs/[^/]+/start$", url) and method == "POST":
            if self.start_status is not None:
                raise urllib.error.HTTPError(
                    url, self.start_status, "start failed", {}, io.BytesIO(b"start failed")
                )
            return FakeResponse({})
        raise AssertionError("unexpected request: %s %s" % (method, url))

    def run_list_requests(self):
        return [url for method, url in self.requests if "/runs?" in url]


def finding_entry(source: str, number: int) -> dict:
    return {
        "kind": "finding",
        "number": "%s:%s" % (source, number),
        "alert_source": source,
        "alert_number": number,
        "title": "alert %s" % number,
        "url": "https://example.test/alert/%s" % number,
        "workflow": "security-remediation",
        "workflow_version_id": "version-security-remediation",
        "input_key": "finding",
        "label_swap": "none",
    }


def plan_with(*entries, skipped=None) -> dict:
    return {
        "repo": REPO,
        "default_branch": "main",
        "entries": list(entries),
        "ambiguous": [],
        "skipped": list(skipped or []),
    }


def run_dispatch(plan: dict, bridge: FakeBridge) -> tuple[dict, dict, int]:
    """Run the dispatch stage script and return result, context, exit code."""
    with tempfile.TemporaryDirectory() as tmp:
        git_dir = pathlib.Path(tmp) / ".git"
        git_dir.mkdir()
        (git_dir / "dispatch-plan.json").write_text(json.dumps(plan))
        output = io.StringIO()
        previous = os.getcwd()
        os.chdir(tmp)
        code = 0
        try:
            with mock.patch("urllib.request.urlopen", bridge.urlopen):
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    try:
                        exec(compile(dispatch_script(), str(GRAPH), "exec"), {"__name__": "__main__"})
                    except SystemExit as exc:
                        code = int(exc.code or 0)
            result = json.loads((git_dir / "dispatch-result.json").read_text())
        finally:
            os.chdir(previous)
        context = json.loads(output.getvalue())["context_updates"]
    return result, context, code


def active_run(slug: str, run_id: str) -> dict:
    return {
        "id": run_id,
        "workflow": {"slug": slug},
        "repository": {"name": REPO},
    }


class DispatchFindingGateTests(unittest.TestCase):
    def test_two_findings_create_one_child_with_finding_payload(self):
        bridge = FakeBridge()
        result, context, code = run_dispatch(
            plan_with(finding_entry("dependabot", 12), finding_entry("dependabot", 7)),
            bridge,
        )

        self.assertEqual(code, 0)
        self.assertEqual(context["dispatch_result"], "success")
        self.assertIsInstance(context["dispatched_count"], str)
        self.assertIsInstance(context["failed_count"], str)
        self.assertEqual(len(bridge.creates), 1)
        payload = bridge.creates[0]
        self.assertEqual(payload["workflow_version_id"], "version-security-remediation")
        self.assertEqual(payload["title"], "security-remediation for %s dependabot #12" % REPO)
        self.assertEqual(payload["target"], {"kind": "git", "repo": REPO, "branch": "main"})
        self.assertEqual(payload["args"]["inputs"], {"finding": "dependabot:12"})
        self.assertEqual(
            payload["args"]["labels"],
            {"source": "dispatch", "repo": REPO, "finding": "dependabot:12"},
        )
        self.assertTrue(payload["args"]["auto_approve"])
        self.assertEqual(
            result["dispatched"],
            [{"finding": "dependabot:12", "workflow": "security-remediation", "run_id": "run-1"}],
        )
        self.assertEqual(result["selected_finding"], "dependabot:12")
        self.assertNotIn("active_security_remediation_run", result)
        self.assertIn({"finding": "dependabot:7", "reason": "serialized"}, result["skipped"])

    def test_code_scanning_finding_uses_its_source_in_title(self):
        bridge = FakeBridge()
        result, _context, code = run_dispatch(plan_with(finding_entry("code-scanning", 4)), bridge)

        self.assertEqual(code, 0)
        self.assertEqual(len(bridge.creates), 1)
        payload = bridge.creates[0]
        self.assertEqual(payload["title"], "security-remediation for %s code-scanning #4" % REPO)
        self.assertEqual(payload["args"]["inputs"], {"finding": "code-scanning:4"})
        self.assertEqual(payload["args"]["labels"]["finding"], "code-scanning:4")
        self.assertEqual(result["selected_finding"], "code-scanning:4")

    def test_active_remediation_run_skips_every_finding(self):
        bridge = FakeBridge(runs=[active_run("security-remediation", "run-active")])
        result, _context, code = run_dispatch(plan_with(finding_entry("code-scanning", 4)), bridge)

        self.assertEqual(code, 0)
        self.assertEqual(bridge.creates, [])
        self.assertEqual(result["active_security_remediation_run"], "run-active")
        self.assertIn(
            {"finding": "code-scanning:4", "reason": "active_security_remediation_run"},
            result["skipped"],
        )
        self.assertNotIn("selected_finding", result)

    def test_one_runs_request_feeds_dependabot_and_security_gates(self):
        bridge = FakeBridge(runs=[active_run("dependabot", "run-dep")])
        result, _context, code = run_dispatch(plan_with(finding_entry("dependabot", 3)), bridge)

        self.assertEqual(code, 0)
        self.assertEqual(result["active_dependabot_run"], "run-dep")
        self.assertNotIn("active_security_remediation_run", result)
        self.assertEqual(len(bridge.run_list_requests()), 1)
        query = bridge.run_list_requests()[0]
        for status in ACTIVE_STATUSES:
            self.assertIn("status=%s" % status, query)
        # An active dependabot run does not serialize security-remediation work.
        self.assertEqual(len(bridge.creates), 1)
        self.assertEqual(result["selected_finding"], "dependabot:3")

    def test_issue_and_dependabot_dispatch_unchanged(self):
        bridge = FakeBridge(runs=[active_run("dependabot", "run-dep")])
        issue = {
            "kind": "issue",
            "number": 5,
            "title": "fix the thing",
            "url": "https://example.test/issues/5",
            "workflow": "oneshot",
            "workflow_version_id": "version-oneshot",
            "input_key": "issue",
            "label_swap": "dispatcher",
        }
        pr = {
            "kind": "pr",
            "number": 9,
            "title": "bump",
            "url": "https://example.test/pulls/9",
            "workflow": "dependabot",
            "workflow_version_id": "version-dependabot",
            "input_key": "pr",
            "label_swap": "dispatcher",
            "ci_failures": "[]",
            "reason": "ci_failure",
        }
        result, _context, code = run_dispatch(plan_with(issue, pr), bridge)

        self.assertEqual(code, 0)
        self.assertEqual(len(bridge.creates), 1)
        payload = bridge.creates[0]
        self.assertEqual(payload["title"], "oneshot for %s#5" % REPO)
        self.assertEqual(payload["args"]["inputs"], {"issue": "5"})
        self.assertEqual(
            payload["args"]["labels"], {"source": "dispatch", "repo": REPO, "issue": "5"}
        )
        self.assertIn({"pr": "9", "reason": "active_dependabot_run"}, result["skipped"])
        self.assertEqual(result["dispatched"][0]["issue"], "5")

    def test_create_without_run_id_fails_the_stage(self):
        bridge = FakeBridge(create_payload={})
        result, context, code = run_dispatch(plan_with(finding_entry("dependabot", 12)), bridge)

        self.assertEqual(code, 1)
        self.assertEqual(context["dispatch_result"], "failed")
        self.assertEqual(result["dispatched"], [])
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["finding"], "dependabot:12")
        self.assertIn("no run id", result["failed"][0]["error"])

    def test_two_findings_without_run_id_create_only_one_child(self):
        bridge = FakeBridge(create_payload={})
        result, context, code = run_dispatch(
            plan_with(finding_entry("dependabot", 12), finding_entry("dependabot", 7)),
            bridge,
        )

        self.assertEqual(code, 1)
        self.assertEqual(context["dispatch_result"], "failed")
        self.assertEqual(len(bridge.creates), 1)
        self.assertEqual(result["dispatched"], [])
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["finding"], "dependabot:12")
        self.assertIn("no run id", result["failed"][0]["error"])
        self.assertIn({"finding": "dependabot:7", "reason": "serialized"}, result["skipped"])

    def test_selected_finding_is_reported_even_when_the_create_fails(self):
        bridge = FakeBridge(create_payload={})
        result, context, code = run_dispatch(plan_with(finding_entry("code-scanning", 4)), bridge)

        self.assertEqual(code, 1)
        self.assertEqual(context["dispatch_result"], "failed")
        self.assertEqual(result["dispatched"], [])
        # Selection is reported at reservation time so a failed create still
        # leaves a truthful record of the finding this scan chose.
        self.assertEqual(result["selected_finding"], "code-scanning:4")
        self.assertEqual(result["failed"][0]["finding"], "code-scanning:4")

    def test_two_findings_with_start_failure_create_only_one_child(self):
        bridge = FakeBridge(start_status=500)
        result, context, code = run_dispatch(
            plan_with(finding_entry("dependabot", 12), finding_entry("dependabot", 7)),
            bridge,
        )

        self.assertEqual(code, 1)
        self.assertEqual(context["dispatch_result"], "failed")
        self.assertEqual(len(bridge.creates), 1)
        self.assertEqual(result["dispatched"], [])
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["finding"], "dependabot:12")
        self.assertIn("HTTP 500", result["failed"][0]["error"])
        self.assertIn({"finding": "dependabot:7", "reason": "serialized"}, result["skipped"])


if __name__ == "__main__":
    unittest.main()
