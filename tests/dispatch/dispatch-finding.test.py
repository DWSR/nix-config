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
FINDING_TITLE = "security-remediation for %s dependabot #12" % REPO


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
    script = next(source for source in load_scripts() if "dispatch-result.json" in source)
    values = {
        "repo": REPO,
        "ready_label": "fabro-ready",
        "running_label": "fabro-running",
    }

    def replace(match: re.Match[str]) -> str:
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


def finding(number: str, source: str, alert_number: int) -> dict:
    return {
        "kind": "finding",
        "number": number,
        "alert_source": source,
        "alert_number": alert_number,
        "title": "title for %s" % number,
        "url": "https://github.com/%s/security/%s/%d" % (REPO, source, alert_number),
        "workflow": "security-remediation",
        "workflow_version_id": "version-security-remediation",
        "input_key": "finding",
        "label_swap": "none",
    }


def issue(number: int) -> dict:
    return {
        "kind": "issue",
        "number": number,
        "title": "issue",
        "url": "",
        "workflow": "kiro-spec",
        "workflow_version_id": "version-kiro",
        "input_key": "issue",
        "label_swap": "dispatcher",
    }


def pull_request(number: int) -> dict:
    return {
        "kind": "pr",
        "number": number,
        "title": "pr",
        "url": "",
        "workflow": "dependabot",
        "workflow_version_id": "version-dependabot",
        "input_key": "pr",
        "label_swap": "dispatcher",
        "ci_failures": "[]",
        "reason": "ci_failure",
    }


def plan_with(entries: list[dict]) -> dict:
    return {
        "repo": REPO,
        "default_branch": "main",
        "entries": entries,
        "ambiguous": [],
        "skipped": [],
    }


def run_dispatch(
    plan: dict,
    runs: list[dict] | None = None,
    create_responses: list[dict] | None = None,
    fail_start: bool = False,
):
    with tempfile.TemporaryDirectory() as tmp:
        git_dir = pathlib.Path(tmp) / ".git"
        git_dir.mkdir()
        (git_dir / "dispatch-plan.json").write_text(json.dumps(plan))

        requests = []
        creates = []
        responses = list(create_responses or [])
        start_failures = [1 if fail_start else 0]

        def urlopen(request, timeout=None):
            method = request.get_method()
            url = request.full_url
            body = json.loads(request.data) if request.data else None
            requests.append((method, url, body))
            if "/runs?" in url:
                return FakeResponse({"data": runs or []})
            if method == "POST" and url.endswith("/runs"):
                creates.append(body)
                return FakeResponse(responses.pop(0) if responses else {"id": "01CHILD%d" % len(creates)})
            if url.endswith("/start"):
                if start_failures[0]:
                    start_failures[0] -= 1
                    raise urllib.error.HTTPError(
                        url, 500, "Internal Server Error", {}, io.BytesIO(b'{"error":"start failed"}')
                    )
                return FakeResponse({})
            if "/labels" in url:
                return FakeResponse({})
            raise AssertionError("unexpected request: %s %s" % (method, url))

        output = io.StringIO()
        exit_code = None
        previous = os.getcwd()
        os.chdir(tmp)
        try:
            with mock.patch.dict(
                os.environ,
                {
                    "GITHUB_TOKEN": "token",
                    "DISPATCH_API_BASE": "http://api.invalid/api/v1",
                    "DISPATCH_GITHUB_API_BASE": "http://github.invalid",
                },
            ), mock.patch("urllib.request.urlopen", urlopen), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                try:
                    exec(compile(dispatch_script(), "dispatch", "exec"), {"__name__": "__main__"})
                except SystemExit as exc:
                    exit_code = exc.code
            result = json.loads((git_dir / "dispatch-result.json").read_text())
        finally:
            os.chdir(previous)
        return result, requests, creates, exit_code, output.getvalue()


class DispatchFindingTests(unittest.TestCase):
    def test_two_findings_create_exactly_one_child(self):
        plan = plan_with([finding("dependabot:12", "dependabot", 12), finding("code-scanning:45", "code-scanning", 45)])

        result, _requests, creates, exit_code, _output = run_dispatch(plan)

        self.assertIsNone(exit_code)
        self.assertEqual(len(creates), 1)
        self.assertEqual(result["dispatched"], [
            {"finding": "dependabot:12", "workflow": "security-remediation", "run_id": "01CHILD1"},
        ])
        self.assertEqual(result["selected_finding"], "dependabot:12")
        self.assertIn({"finding": "code-scanning:45", "reason": "serialized"}, result["skipped"])
        self.assertEqual(result["failed"], [])

    def test_finding_child_payload_matches_the_documented_contract(self):
        plan = plan_with([finding("dependabot:12", "dependabot", 12)])

        _result, requests, creates, _exit_code, _output = run_dispatch(plan)

        self.assertEqual(creates, [{
            "workflow_version_id": "version-security-remediation",
            "title": FINDING_TITLE,
            "target": {"kind": "git", "repo": REPO, "branch": "main"},
            "args": {
                "inputs": {"finding": "dependabot:12"},
                "labels": {"source": "dispatch", "repo": REPO, "finding": "dependabot:12"},
                "auto_approve": True,
            },
        }])
        self.assertEqual(
            [(method, url) for method, url, _body in requests if url.endswith("/start")],
            [("POST", "http://api.invalid/api/v1/runs/01CHILD1/start")],
        )

    def test_code_scanning_finding_uses_its_source_in_the_title(self):
        plan = plan_with([finding("code-scanning:45", "code-scanning", 45)])

        _result, _requests, creates, exit_code, _output = run_dispatch(plan)

        self.assertIsNone(exit_code)
        self.assertEqual(creates[0]["title"], "security-remediation for %s code-scanning #45" % REPO)
        self.assertEqual(creates[0]["args"]["labels"]["finding"], "code-scanning:45")

    def test_active_security_remediation_run_skips_the_finding(self):
        plan = plan_with([finding("dependabot:12", "dependabot", 12)])
        runs = [{
            "id": "01SECURITY",
            "workflow": {"slug": "security-remediation"},
            "repository": {"name": REPO},
        }]

        result, requests, creates, exit_code, _output = run_dispatch(plan, runs=runs)

        self.assertIsNone(exit_code)
        self.assertEqual(creates, [])
        self.assertEqual(len([url for _method, url, _body in requests if "/runs?" in url]), 1)
        self.assertEqual(result["skipped"], [
            {"finding": "dependabot:12", "reason": "active_security_remediation_run"},
        ])
        self.assertEqual(result["active_security_remediation_run"], "01SECURITY")
        self.assertEqual(result["dispatched"], [])

    def test_one_runs_listing_feeds_both_active_run_gates(self):
        plan = plan_with([pull_request(99), finding("dependabot:12", "dependabot", 12)])
        runs = [
            {"id": "01DEP", "workflow": {"slug": "dependabot"}, "repository": {"name": REPO}},
            {"id": "01SECURITY", "workflow": {"slug": "security-remediation"}, "repository": {"name": REPO}},
        ]

        result, requests, creates, exit_code, _output = run_dispatch(plan, runs=runs)

        self.assertIsNone(exit_code)
        self.assertEqual(len([url for _method, url, _body in requests if "/runs?" in url]), 1)
        self.assertEqual(creates, [])
        self.assertEqual(result["active_dependabot_run"], "01DEP")
        self.assertEqual(result["active_security_remediation_run"], "01SECURITY")
        self.assertIn({"pr": "99", "reason": "active_dependabot_run"}, result["skipped"])
        self.assertIn({"finding": "dependabot:12", "reason": "active_security_remediation_run"}, result["skipped"])

    def test_existing_issue_and_dependabot_dispatch_is_unchanged(self):
        plan = plan_with([issue(7), pull_request(99)])

        result, requests, creates, exit_code, _output = run_dispatch(plan)

        self.assertIsNone(exit_code)
        self.assertEqual([create["title"] for create in creates], [
            "kiro-spec for %s#7" % REPO,
            "dependabot for %s#99" % REPO,
        ])
        self.assertEqual(creates[0]["args"]["inputs"], {"issue": "7"})
        self.assertEqual(creates[1]["args"]["inputs"], {
            "pr": "99",
            "ci_failures": "[]",
            "reason": "ci_failure",
        })
        self.assertEqual(result["dispatched"], [
            {"issue": "7", "workflow": "kiro-spec", "run_id": "01CHILD1"},
            {"pr": "99", "workflow": "dependabot", "run_id": "01CHILD2"},
        ])
        self.assertEqual(result["selected_finding"], "")
        self.assertEqual(
            [(method, url) for method, url, _body in requests if "/repos/%s/issues/7/labels" % REPO in url],
            [
                ("POST", "http://github.invalid/repos/%s/issues/7/labels" % REPO),
                ("DELETE", "http://github.invalid/repos/%s/issues/7/labels/fabro-ready" % REPO),
            ],
        )

    def test_create_without_a_run_id_fails_the_stage(self):
        plan = plan_with([finding("dependabot:12", "dependabot", 12)])

        result, _requests, creates, exit_code, _output = run_dispatch(plan, create_responses=[{}])

        self.assertEqual(len(creates), 1)
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["dispatched"], [])
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["finding"], "dependabot:12")
        self.assertIn("no run id", result["failed"][0]["error"])

    def test_start_failure_after_create_does_not_create_a_second_child(self):
        plan = plan_with([finding("dependabot:12", "dependabot", 12), finding("code-scanning:45", "code-scanning", 45)])

        result, _requests, creates, exit_code, _output = run_dispatch(plan, fail_start=True)

        self.assertEqual(len(creates), 1)
        self.assertEqual(exit_code, 1)
        self.assertEqual(result["dispatched"], [])
        self.assertEqual(len(result["failed"]), 1)
        self.assertEqual(result["failed"][0]["finding"], "dependabot:12")
        self.assertIn("start", result["failed"][0]["error"])
        self.assertIn({"finding": "code-scanning:45", "reason": "serialized"}, result["skipped"])


if __name__ == "__main__":
    unittest.main()
