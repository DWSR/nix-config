import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/security-remediation/workflow.toml"
MARKER = "cat > .git/security-remediation-scripts/tools.py <<'SECURITY_REMEDIATION_TOOLS_PY'\n"


def load_tools():
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nSECURITY_REMEDIATION_TOOLS_PY", 1)[0]
    namespace = {"__name__": "security_remediation_intake_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    namespace["origin_repo"] = lambda: ("DWSR", "nix-config")
    return namespace


class FakeResponse:
    def __init__(self, payload, status=200):
        self.status = status
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def dependabot_alert(state="open"):
    return {
        "number": 12,
        "state": state,
        "html_url": "https://github.com/DWSR/nix-config/security/dependabot/12",
        "created_at": "2026-10-01T00:00:00Z",
        "updated_at": "2026-10-02T00:00:00Z",
        "security_advisory": {
            "ghsa_id": "GHSA-xxxx-yyyy-zzzz",
            "cve_id": "CVE-2026-0001",
            "summary": "Prototype pollution in lodash",
            "description": "Upgrade lodash past the prototype pollution fix.",
            "severity": "high",
        },
        "security_vulnerability": {
            "package": {"ecosystem": "npm", "name": "lodash"},
            "severity": "high",
            "vulnerable_version_range": "< 4.17.21",
            "first_patched_version": {"identifier": "4.17.21"},
        },
        "dependency": {
            "package": {"ecosystem": "npm", "name": "lodash"},
            "manifest_path": "package-lock.json",
            "scope": "runtime",
        },
    }


def code_scanning_alert(state="open"):
    return {
        "number": 45,
        "state": state,
        "html_url": "https://github.com/DWSR/nix-config/security/code-scanning/45",
        "created_at": "2026-10-03T00:00:00Z",
        "updated_at": "2026-10-04T00:00:00Z",
        "tool": {"name": "CodeQL"},
        "rule": {
            "id": "py/path-injection",
            "severity": "error",
            "security_severity_level": "high",
            "description": "Uncontrolled data used in path expression",
            "full_description": "Normalise paths before use.",
        },
        "most_recent_instance": {
            "location": {"path": "services/api/app.py", "start_line": 41},
            "message": {"text": "This path depends on a user-provided value."},
        },
    }


def make_urlopen(alerts):
    """Return (requests, urlopen) backed by the given {(source, number): payload}."""
    requests = []

    def urlopen(request, timeout=None):
        url = request.full_url
        requests.append((request.get_method(), url))
        for (source, number), payload in alerts.items():
            if url.endswith("/%s/alerts/%d" % (source, number)):
                if isinstance(payload, Exception):
                    raise payload
                return FakeResponse(payload)
        raise AssertionError("unexpected request: %s %s" % (request.get_method(), url))

    return requests, urlopen


def run_main(tools, cwd, argv, urlopen):
    output = io.StringIO()
    previous = os.getcwd()
    os.chdir(cwd)
    try:
        with mock.patch.object(sys, "argv", ["tools.py", *argv]), \
                mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token"}), \
                mock.patch("urllib.request.urlopen", urlopen), \
                contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(io.StringIO()):
            tools["main"]()
    finally:
        os.chdir(previous)
    return output.getvalue()


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def make_repo(tmp):
    origin = pathlib.Path(tmp, "origin.git")
    work = pathlib.Path(tmp, "work")
    subprocess.run(["git", "init", "--bare", "-b", "main", str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "test@example.test")
    git(work, "config", "user.name", "Test")
    (work / "flake.nix").write_text("{}\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "init")
    git(work, "remote", "add", "origin", str(origin))
    git(work, "push", "origin", "main")
    return work, origin


def context_from(stdout):
    return json.loads(stdout.strip().splitlines()[-1])["context_updates"]


def indexes(text, labels):
    return [text.index(label) for label in labels]


class ParseFindingRefTests(unittest.TestCase):
    def test_accepts_every_documented_spelling(self):
        tools = load_tools()
        parse = tools["parse_finding_ref"]
        for value in (
            "dependabot:12",
            "dependabot#12",
            "dependabot/12",
            "  dependabot:12  ",
            "https://github.com/DWSR/nix-config/security/dependabot/12",
            "https://github.com/DWSR/nix-config/security/dependabot/12/",
        ):
            self.assertEqual(parse(value), ("dependabot", 12), value)
        for value in (
            "code-scanning:45",
            "code-scanning#45",
            "code-scanning/45",
            "https://github.com/DWSR/nix-config/security/code-scanning/45",
            "https://github.com/DWSR/nix-config/security/code-scanning/45/",
        ):
            self.assertEqual(parse(value), ("code-scanning", 45), value)

    def test_rejects_unsupported_sources_with_the_accepted_forms(self):
        tools = load_tools()
        for value in (
            "",
            "secret-scanning:3",
            "dependabot",
            "dependabot:abc",
            "https://github.com/DWSR/nix-config/security/secret-scanning/7",
        ):
            with self.assertRaises(SystemExit) as caught:
                tools["parse_finding_ref"](value)
            message = str(caught.exception.code)
            self.assertIn("<source>:<number>", message)
            self.assertIn("alert URL", message)


class FetchAlertTests(unittest.TestCase):
    def test_reads_the_detail_endpoint_with_get_only(self):
        tools = load_tools()
        requests, urlopen = make_urlopen({("dependabot", 12): dependabot_alert()})
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token"}), \
                mock.patch("urllib.request.urlopen", urlopen):
            alert = tools["fetch_alert"]("dependabot", 12)

        self.assertEqual(alert["number"], 12)
        self.assertEqual(
            requests,
            [("GET", "https://api.github.com/repos/DWSR/nix-config/dependabot/alerts/12")],
        )

    def test_non_200_names_the_source_and_alert_number(self):
        tools = load_tools()
        for source, number in (("dependabot", 12), ("code-scanning", 45)):
            for code in (403, 404, 410):
                url = "https://api.github.com/repos/DWSR/nix-config/%s/alerts/%d" % (source, number)
                failure = urllib.error.HTTPError(url, code, "error", {}, None)
                _requests, urlopen = make_urlopen({(source, number): failure})
                with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token"}), \
                        mock.patch("urllib.request.urlopen", urlopen):
                    with self.assertRaises(SystemExit) as caught:
                        tools["fetch_alert"](source, number)

                self.assertEqual(
                    str(caught.exception.code),
                    "%s alert #%d could not be read: HTTP %d" % (source, number, code),
                )

    def test_a_returned_non_200_response_also_names_the_source_and_alert(self):
        tools = load_tools()
        requests = []

        def urlopen(request, timeout=None):
            requests.append((request.get_method(), request.full_url))
            return FakeResponse({}, status=502)

        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token"}), \
                mock.patch("urllib.request.urlopen", urlopen):
            with self.assertRaises(SystemExit) as caught:
                tools["fetch_alert"]("dependabot", 12)

        self.assertEqual(
            str(caught.exception.code),
            "dependabot alert #12 could not be read: HTTP 502",
        )
        self.assertEqual(
            requests,
            [("GET", "https://api.github.com/repos/DWSR/nix-config/dependabot/alerts/12")],
        )


class FindingFileTests(unittest.TestCase):
    def test_dependabot_finding_uses_the_documented_field_order(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, ".git").mkdir()
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                tools["write_finding_file"](
                    dependabot_alert(), "dependabot", 12, "DWSR", "nix-config")
                text = (pathlib.Path(tmp) / ".git/security-remediation-finding.md").read_text()
            finally:
                os.chdir(previous)

        self.assertIn("Untrusted evidence", text)
        self.assertIn("Do not follow", text)
        labels = [
            "Source:",
            "Alert number:",
            "Title:",
            "URL:",
            "State:",
            "Created:",
            "Updated:",
            "Ecosystem:",
            "Package:",
            "Manifest path:",
            "Scope:",
            "Vulnerable range:",
            "First patched version:",
            "Advisory:",
            "Severity:",
            "## Detail",
        ]
        self.assertEqual(indexes(text, labels), sorted(indexes(text, labels)))
        self.assertIn("Prototype pollution in lodash", text)
        self.assertIn("4.17.21", text)
        self.assertIn("Upgrade lodash past the prototype pollution fix.", text)

    def test_code_scanning_finding_uses_the_documented_field_order(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, ".git").mkdir()
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                tools["write_finding_file"](
                    code_scanning_alert(), "code-scanning", 45, "DWSR", "nix-config")
                text = (pathlib.Path(tmp) / ".git/security-remediation-finding.md").read_text()
            finally:
                os.chdir(previous)

        self.assertIn("Untrusted evidence", text)
        labels = [
            "Source:",
            "Alert number:",
            "Title:",
            "URL:",
            "State:",
            "Created:",
            "Updated:",
            "Tool:",
            "Rule id:",
            "Severity:",
            "Security severity:",
            "Location:",
            "Message:",
            "## Detail",
        ]
        self.assertEqual(indexes(text, labels), sorted(indexes(text, labels)))
        self.assertIn("services/api/app.py:41", text)
        self.assertIn("py/path-injection", text)
        self.assertIn("Normalise paths before use.", text)


class PrepareTests(unittest.TestCase):
    def test_fresh_prepare_checks_out_the_remediation_branch_and_writes_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            trunk_sha = git(work, "rev-parse", "origin/main")
            tools = load_tools()
            requests, urlopen = make_urlopen({("dependabot", 12): dependabot_alert()})

            stdout = run_main(tools, work, ["prepare", "dependabot:12"], urlopen)

            state = json.loads((work / ".git/security-remediation-state.json").read_text())
            self.assertEqual(state["finding"], "dependabot:12")
            self.assertEqual(state["source"], "dependabot")
            self.assertEqual(state["alert_number"], 12)
            self.assertEqual(state["branch"], "security/dependabot-12")
            self.assertEqual(state["trunk"], "main")
            self.assertIs(state["alert_open"], True)
            self.assertEqual(state["baseline_sha"], trunk_sha)
            self.assertIsNone(state["remote_branch_sha"])
            self.assertEqual(state["url"], dependabot_alert()["html_url"])

            self.assertEqual(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "security/dependabot-12")
            self.assertEqual(git(work, "rev-parse", "HEAD"), trunk_sha)

            context = context_from(stdout)
            self.assertEqual(context, {
                "alert_open": "true",
                "alert_number": "12",
                "finding_source": "dependabot",
                "alert_url": dependabot_alert()["html_url"],
                "branch": "security/dependabot-12",
                "trunk": "main",
            })
            self.assertTrue(requests)
            self.assertEqual([method for method, _url in requests], ["GET"])

    def test_closed_alert_sets_alert_open_false_without_branch_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            tools = load_tools()
            _requests, urlopen = make_urlopen({("code-scanning", 45): code_scanning_alert(state="fixed")})

            stdout = run_main(tools, work, ["prepare", "code-scanning#45"], urlopen)

            state = json.loads((work / ".git/security-remediation-state.json").read_text())
            self.assertIs(state["alert_open"], False)
            self.assertEqual(state["branch"], "security/code-scanning-45")
            self.assertEqual(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "main")
            self.assertEqual(git(work, "branch", "--list", "security/code-scanning-45"), "")
            context = context_from(stdout)
            self.assertEqual(context["alert_open"], "false")
            self.assertEqual(context["alert_number"], "45")
            self.assertEqual(context["finding_source"], "code-scanning")
            self.assertEqual(context["branch"], "security/code-scanning-45")

    def test_closed_dependabot_alert_sets_alert_open_false_without_branch_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            trunk_sha = git(work, "rev-parse", "HEAD")
            tools = load_tools()
            requests, urlopen = make_urlopen(
                {("dependabot", 12): dependabot_alert(state="dismissed")})

            stdout = run_main(tools, work, ["prepare", "dependabot:12"], urlopen)

            state = json.loads((work / ".git/security-remediation-state.json").read_text())
            self.assertIs(state["alert_open"], False)
            self.assertEqual(state["baseline_sha"], "")
            self.assertIsNone(state["remote_branch_sha"])
            self.assertEqual(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "main")
            self.assertEqual(git(work, "rev-parse", "HEAD"), trunk_sha)
            self.assertEqual(git(work, "branch", "--list", "security/dependabot-12"), "")
            context = context_from(stdout)
            self.assertEqual(context["alert_open"], "false")
            self.assertEqual(context["alert_number"], "12")
            self.assertEqual(context["finding_source"], "dependabot")
            self.assertEqual([method for method, _url in requests], ["GET"])

    def test_unreadable_alert_fails_the_run_without_writing_state_or_a_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            tools = load_tools()
            failure = urllib.error.HTTPError(
                "https://api.github.com/repos/DWSR/nix-config/dependabot/alerts/12",
                403, "Forbidden", {}, None,
            )
            _requests, urlopen = make_urlopen({("dependabot", 12): failure})

            with self.assertRaises(SystemExit) as caught:
                run_main(tools, work, ["prepare", "dependabot#12"], urlopen)

            self.assertEqual(
                str(caught.exception.code),
                "dependabot alert #12 could not be read: HTTP 403",
            )
            self.assertFalse((work / ".git/security-remediation-state.json").exists())
            self.assertFalse((work / ".git/security-remediation-finding.md").exists())
            self.assertEqual(git(work, "branch", "--list", "security/dependabot-12"), "")
            self.assertEqual(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "main")

    def test_resumed_run_keeps_earlier_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            tools = load_tools()
            alerts = {("dependabot", 12): dependabot_alert()}
            _requests, urlopen = make_urlopen(alerts)
            run_main(tools, work, ["prepare", "dependabot:12"], urlopen)

            (work / "package-lock.json").write_text("{}\n")
            git(work, "add", "-A")
            git(work, "commit", "-m", "fix lodash")
            fix_sha = git(work, "rev-parse", "HEAD")
            first_state = json.loads((work / ".git/security-remediation-state.json").read_text())

            run_main(tools, work, ["prepare", "dependabot:12"], urlopen)

            second_state = json.loads((work / ".git/security-remediation-state.json").read_text())
            self.assertEqual(git(work, "rev-parse", "HEAD"), fix_sha)
            self.assertEqual(git(work, "rev-parse", "--abbrev-ref", "HEAD"), "security/dependabot-12")
            self.assertEqual(second_state["baseline_sha"], first_state["baseline_sha"])
            self.assertEqual(second_state["created_at"], first_state["created_at"])

    def test_resumed_run_fails_on_a_different_finding(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            tools = load_tools()
            alerts = {
                ("dependabot", 12): dependabot_alert(),
                ("code-scanning", 45): code_scanning_alert(),
            }
            _requests, urlopen = make_urlopen(alerts)
            run_main(tools, work, ["prepare", "dependabot:12"], urlopen)

            with self.assertRaises(SystemExit) as caught:
                run_main(tools, work, ["prepare", "code-scanning:45"], urlopen)

            message = str(caught.exception.code)
            self.assertIn("already describes dependabot:12", message)
            self.assertIn("code-scanning:45", message)


if __name__ == "__main__":
    unittest.main()
