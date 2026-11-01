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
WORKFLOW_TOML = ROOT / ".fabro/workflows/dispatch/workflow.toml"
HELPER_MARKER = "cat > .git/dispatch-security-scan.py <<'DISPATCH_SECURITY_SCAN_PY'\n"

QUEUE_KEYS = {
    "repo",
    "ready_label",
    "running_label",
    "failed_label",
    "default_branch",
    "issues",
    "pull_requests",
    "findings",
    "remediation",
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


def scan_script() -> str:
    return next(source for source in load_scripts() if "def fabro_runs" in source)


def template(script: str) -> str:
    values = {
        "repo": "DWSR/nix-config",
        "ready_label": "fabro-ready",
        "running_label": "fabro-running",
        "failed_label": "fabro-failed",
    }

    def replace(match: re.Match[str]) -> str:
        return json.dumps(values[match.group(1)])

    return re.sub(r"\{\{\s*inputs\.(\w+)\s*\}\}", replace, script)


def helper_script() -> str:
    text = WORKFLOW_TOML.read_text()
    return text.split(HELPER_MARKER, 1)[1].split("\nDISPATCH_SECURITY_SCAN_PY", 1)[0]


class FakeResponse:
    def __init__(self, payload):
        self.status = 200
        self.headers = {}
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def make_urlopen(requests, runs=None, alert_failure=False):
    dependabot = [{"number": 12, "html_url": "https://example.test/alert/12",
                   "security_advisory": {"summary": "Prototype pollution in lodash"},
                   "dependency": {"package": {"name": "lodash"}}}]

    def urlopen(request, timeout=None):
        url = request.full_url
        requests.append((request.get_method(), url))
        if "/runs?" in url:
            return FakeResponse({"data": runs or []})
        if re.search(r"/repos/[^/]+/[^/]+$", url):
            return FakeResponse({"default_branch": "main"})
        if "/dependabot/alerts" in url:
            if alert_failure:
                raise urllib.error.HTTPError(url, 500, "boom", {}, None)
            return FakeResponse(dependabot)
        if "/code-scanning/alerts" in url:
            return FakeResponse([])
        if "/issues?" in url or "/pulls?" in url:
            return FakeResponse([])
        raise AssertionError("unexpected request: %s %s" % (request.get_method(), url))

    return urlopen


class ScanMergeTests(unittest.TestCase):
    def run_scan(self, tmp, runs=None, write_helper=True, alert_failure=False):
        pathlib.Path(tmp, ".git").mkdir()
        if write_helper:
            pathlib.Path(tmp, ".git/dispatch-security-scan.py").write_text(helper_script())
        requests = []
        output = io.StringIO()
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
            ), mock.patch("urllib.request.urlopen", make_urlopen(requests, runs=runs, alert_failure=alert_failure)), \
                    contextlib.redirect_stdout(output):
                exec(
                    compile(template(scan_script()), "scan", "exec"),
                    {"__name__": "__main__"},
                )
        finally:
            os.chdir(previous)
        queue = json.loads(pathlib.Path(tmp, ".git/dispatch-queue.json").read_text())
        return queue, requests, output.getvalue()

    def test_scan_merges_findings_and_remediation_into_the_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            queue, _requests, _output = self.run_scan(tmp)

        self.assertEqual(set(queue), QUEUE_KEYS)
        self.assertEqual(
            queue["findings"],
            [
                {
                    "source": "dependabot",
                    "number": 12,
                    "title": "Prototype pollution in lodash",
                    "url": "https://example.test/alert/12",
                    "package": "lodash",
                }
            ],
        )
        remediation = queue["remediation"]
        self.assertIsNone(remediation["active_run"])
        self.assertEqual(remediation["eligible"], ["dependabot:12"])
        self.assertEqual(remediation["excluded"], [])
        self.assertEqual(remediation["selected"]["source"], "dependabot")
        self.assertEqual(remediation["selected"]["number"], 12)

    def test_scan_reports_finding_context_and_findings_keep_the_queue(self):
        with tempfile.TemporaryDirectory() as tmp:
            _queue, _requests, output = self.run_scan(tmp)

        context = json.loads(output.strip().splitlines()[-1])["context_updates"]
        self.assertEqual(context["finding_count"], "1")
        self.assertEqual(context["finding_source"], "dependabot")
        self.assertEqual(context["finding_number"], "12")
        self.assertEqual(context["active_security_remediation_run"], "")
        # A findings-only queue must not short-circuit the run before `match`.
        self.assertEqual(context["has_queue"], "true")
        self.assertEqual(context["has_issues"], "false")
        self.assertEqual(context["has_pull_requests"], "false")

    def test_scan_reuses_the_single_runs_listing_for_the_security_gate(self):
        runs = [{
            "id": "01SECURITY",
            "workflow": {"slug": "security-remediation"},
            "repository": {"name": "DWSR/nix-config"},
        }]
        with tempfile.TemporaryDirectory() as tmp:
            queue, requests, output = self.run_scan(tmp, runs=runs)

        self.assertEqual(len([url for _method, url in requests if "/runs?" in url]), 1)
        self.assertEqual(queue["remediation"]["active_run"], "01SECURITY")
        context = json.loads(output.strip().splitlines()[-1])["context_updates"]
        self.assertEqual(context["active_security_remediation_run"], "01SECURITY")

    def test_unreadable_alert_source_fails_before_any_queue_is_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as caught:
                self.run_scan(tmp, alert_failure=True)
            self.assertIn("dependabot alerts could not be read", str(caught.exception.code))
            self.assertFalse(pathlib.Path(tmp, ".git/dispatch-queue.json").exists())

    def test_missing_helper_fails_with_a_resume_hint(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(SystemExit) as caught:
                self.run_scan(tmp, write_helper=False)

        self.assertIn("fresh sandbox on resume?", str(caught.exception.code))


if __name__ == "__main__":
    unittest.main()
