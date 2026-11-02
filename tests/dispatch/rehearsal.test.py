"""Rehearse dispatch stages against one seeded security alert.

A scratch repository runs the real scan, matching, remediation filter, normalization,
and dispatch stages against stateful GitHub and Fabro API fakes. A selected finding
must be filtered before dispatch, while the independent remediation publish leg keeps
its pull request open for a human to merge and never writes the alert.
"""

import contextlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
import urllib.request
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
GRAPH = ROOT / ".fabro/workflows/dispatch/workflow.fabro"
WORKFLOW_TOML = ROOT / ".fabro/workflows/dispatch/workflow.toml"
REMEDIATION_TOML = ROOT / ".fabro/workflows/security-remediation/workflow.toml"

REPO = "DWSR/nix-config"
CHILD_ID = "01CHILD1"
TRUNK = "main"
FINDING = "dependabot:12"
ALERT_URL = "https://github.com/%s/security/dependabot/12" % REPO
SEEDED_ALERT = {
    "number": 12,
    "state": "open",
    "html_url": ALERT_URL,
    "security_advisory": {"summary": "Prototype pollution in lodash"},
    "dependency": {"package": {"name": "lodash"}},
}
ACTIVE_STATUSES = ("pending", "runnable", "initializing", "running", "blocked")

VERSIONS = {
    "kiro_spec_workflow_version": "version-kiro",
    "oneshot_workflow_version": "version-oneshot",
    "dependabot_workflow_version": "version-dependabot",
    "security_remediation_workflow_version": "version-security-remediation",
}
INPUTS = {
    "repo": REPO,
    "ready_label": "fabro-ready",
    "running_label": "fabro-running",
    "failed_label": "fabro-failed",
}

API_BASE = "http://api.invalid/api/v1"
GITHUB_BASE = "http://github.invalid"


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


def render(script: str) -> str:
    def replace(match: re.Match[str]) -> str:
        values = INPUTS if match.group(1) == "inputs" else VERSIONS
        return json.dumps(values[match.group(2)])

    return re.sub(r"\{\{\s*(inputs|vars)\.(\w+)\s*\}\}", replace, script)


def graph_script(marker: str) -> str:
    return render(next(source for source in load_scripts() if marker in source))


def scan_script() -> str:
    return graph_script("def fabro_runs")


def stack_scan_script() -> str:
    # The graph node is a runpy shim; the real helper is written by `prepare`.
    return stack_scan_helper()


def match_script() -> str:
    return graph_script("DEPENDABOT_RULE")


def remediation_filter_script() -> str:
    return graph_script("security_remediation_disabled")


def normalize_script() -> str:
    return graph_script("stack_issue_numbers")


def dispatch_script() -> str:
    return graph_script("dispatch-result.json")


def security_scan_helper() -> str:
    text = WORKFLOW_TOML.read_text()
    return text.split("cat > .git/dispatch-security-scan.py <<'DISPATCH_SECURITY_SCAN_PY'\n", 1)[1].split(
        "\nDISPATCH_SECURITY_SCAN_PY", 1,
    )[0]


def stack_scan_helper() -> str:
    text = WORKFLOW_TOML.read_text()
    return text.split("cat > .git/dispatch-stack-scan.py <<'DISPATCH_STACK_SCAN_PY'\n", 1)[1].split(
        "\nDISPATCH_STACK_SCAN_PY", 1,
    )[0]


def load_tools():
    text = REMEDIATION_TOML.read_text()
    script = text.split(
        "cat > .git/security-remediation-scripts/tools.py <<'SECURITY_REMEDIATION_TOOLS_PY'\n", 1,
    )[1].split("\nSECURITY_REMEDIATION_TOOLS_PY", 1)[0]
    namespace = {"__name__": "security_remediation_rehearsal_test"}
    exec(compile(script, str(REMEDIATION_TOML), "exec"), namespace)
    return namespace


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def make_scratch(tmp):
    """A scratch repository with a bare origin, ready for a rehearsal cycle."""
    origin = pathlib.Path(tmp, "origin.git")
    work = pathlib.Path(tmp, "scratch")
    subprocess.run(["git", "init", "--bare", "-b", TRUNK, str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", TRUNK, str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "rehearsal@example.test")
    git(work, "config", "user.name", "Rehearsal")
    (work / "flake.nix").write_text("{}\n")
    (work / "package-lock.json").write_text('{"lodash": "4.17.20"}\n')
    (work / "README.md").write_text("readme\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "init")
    git(work, "remote", "add", "origin", str(origin))
    git(work, "push", "origin", TRUNK)
    (work / ".git/dispatch-security-scan.py").write_text(security_scan_helper())
    (work / ".git/dispatch-stack-scan.py").write_text(stack_scan_helper())
    return work, origin


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self.headers = {}
        self._payload = json.dumps(payload).encode("utf-8") if payload is not None else b""

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class RehearsalServices:
    """Stateful fake for the GitHub and Fabro APIs used by the dispatch cycle."""

    def __init__(self):
        self.alerts = {"dependabot": [dict(SEEDED_ALERT)], "code-scanning": []}
        self.pull_requests = []
        self.created_pull_requests = []
        self.runs = []
        self.requests = []
        self.creates = []
        self.starts = []

    def __call__(self, request, data=None, timeout=None):
        method = request.get_method()
        url = request.full_url
        raw = request.data if request.data is not None else data
        body = json.loads(raw) if raw else None
        self.requests.append({"method": method, "url": url, "body": body})
        if url.startswith(API_BASE):
            return self.api(method, url, body)
        if url.startswith(GITHUB_BASE):
            return self.github(method, url, body)
        raise AssertionError("unexpected request: %s %s" % (method, url))

    def api(self, method, url, body):
        parsed = urllib.parse.urlparse(url)
        query = urllib.parse.parse_qs(parsed.query)
        if method == "GET" and parsed.path.endswith("/runs"):
            statuses = set(query.get("status") or ACTIVE_STATUSES)
            return FakeResponse(200, {"data": [
                run for run in self.runs if run["status"] in statuses
            ]})
        if method == "POST" and parsed.path.endswith("/runs"):
            self.creates.append(body)
            versions = {"version-security-remediation": "security-remediation"}
            slug = versions.get(body.get("workflow_version_id") or "", "unknown")
            run = {
                "id": "%s%d" % (CHILD_ID[:-1], len(self.creates)),
                "title": body.get("title") or "",
                "status": "pending",
                "workflow": {"slug": slug},
                "repository": {"name": body.get("target", {}).get("repo") or REPO},
                "labels": body.get("args", {}).get("labels", {}),
            }
            self.runs.append(run)
            return FakeResponse(201, {"id": run["id"]})
        if method == "POST" and parsed.path.endswith("/start"):
            run_id = parsed.path.split("/")[-2]
            self.starts.append(run_id)
            for run in self.runs:
                if run["id"] == run_id:
                    run["status"] = "runnable"
            return FakeResponse(200, {})
        raise AssertionError("unexpected API request: %s %s" % (method, url))

    def github(self, method, url, body):
        parsed = urllib.parse.urlparse(url)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)
        if method == "GET" and path == "/repos/%s" % REPO:
            return FakeResponse(200, {"default_branch": TRUNK})
        if method == "GET" and path == "/repos/%s/issues" % REPO:
            return FakeResponse(200, [])
        if method == "GET" and path == "/repos/%s/stacks" % REPO:
            return FakeResponse(200, [])
        if method == "GET" and path == "/repos/%s/dependabot/alerts" % REPO:
            return FakeResponse(200, list(self.alerts["dependabot"]))
        if method == "GET" and path == "/repos/%s/code-scanning/alerts" % REPO:
            return FakeResponse(200, list(self.alerts["code-scanning"]))
        if method == "GET" and path == "/repos/%s/pulls" % REPO:
            if "head" in query:
                head = query["head"][0]
                return FakeResponse(200, [
                    pr for pr in self.created_pull_requests if pr.get("head_ref") == head.split(":", 1)[-1]
                ])
            return FakeResponse(200, list(self.pull_requests))
        if method == "POST" and path == "/repos/%s/pulls" % REPO:
            pr = {
                "number": 34,
                "html_url": "https://github.com/%s/pull/34" % REPO,
                "head_ref": body.get("head") or "",
                "draft": body.get("draft"),
                "body": body.get("body") or "",
            }
            self.created_pull_requests.append(pr)
            return FakeResponse(201, pr)
        raise AssertionError("unexpected GitHub request: %s %s" % (method, url))


class Rehearsal:
    """Runs the real dispatch stages against a scratch repository."""

    def __init__(self, work, services):
        self.work = work
        self.services = services

    def stage(self, script: str):
        output, error = io.StringIO(), io.StringIO()
        previous = os.getcwd()
        os.chdir(self.work)
        try:
            with mock.patch.dict(os.environ, {
                "GITHUB_TOKEN": "rehearsal-token",
                "DISPATCH_API_BASE": API_BASE,
                "DISPATCH_GITHUB_API_BASE": GITHUB_BASE,
                "SECURITY_REMEDIATION_API_BASE": GITHUB_BASE,
            }), mock.patch("urllib.request.urlopen", self.services), \
                    contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
                exec(compile(script, "rehearsal", "exec"), {"__name__": "__main__"})
        finally:
            os.chdir(previous)
        last = output.getvalue().strip().splitlines()[-1]
        context = json.loads(last)["context_updates"] if last else {}
        return context, error.getvalue()

    def read(self, name):
        return json.loads((self.work / ".git" / name).read_text())

    def cycle(self):
        """Run scan -> stack_scan -> match -> filter -> normalize."""
        scan_context, scan_error = self.stage(scan_script())
        queue = self.read("dispatch-queue.json")
        self.stage(stack_scan_script())
        queue = self.read("dispatch-queue.json")
        self.stage(match_script())
        filter_context, _ = self.stage(remediation_filter_script())
        self.stage(normalize_script())
        plan = self.read("dispatch-plan.json")
        return queue, scan_context, scan_error, filter_context, plan

    def dispatch(self):
        context, error = self.stage(dispatch_script())
        return self.read("dispatch-result.json"), context, error


class SeededAlertRehearsalTests(unittest.TestCase):
    def test_selected_finding_is_filtered_before_dispatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            services = RehearsalServices()
            work, _origin = make_scratch(tmp)
            rehearsal = Rehearsal(work, services)

            queue, scan_context, scan_error, match_context, plan = rehearsal.cycle()

        # The seeded alert remains visible in scan diagnostics but is not dispatchable.
        self.assertEqual(queue["findings"], [{
            "source": "dependabot",
            "number": 12,
            "title": "Prototype pollution in lodash",
            "url": ALERT_URL,
            "package": "lodash",
        }])
        self.assertEqual(queue["remediation"]["selected"]["number"], 12)
        self.assertIn("selected=dependabot:12", scan_error)
        self.assertEqual(scan_context["finding_source"], "dependabot")
        self.assertEqual(scan_context["finding_number"], "12")
        self.assertEqual(scan_context["has_queue"], "true")
        self.assertIn("selected=dependabot:12", scan_error)
        self.assertEqual(plan["entries"], [])
        self.assertEqual(plan["skipped"], [{
            "finding": FINDING,
            "reason": "security_remediation_disabled",
        }])
        self.assertEqual(match_context["has_plan"], "false")
        self.assertEqual(services.creates, [])
        self.assertEqual(services.starts, [])
        self.assertEqual(services.runs, [])

    def test_repeated_scans_never_dispatch_selected_findings(self):
        with tempfile.TemporaryDirectory() as tmp:
            services = RehearsalServices()
            work, _origin = make_scratch(tmp)
            rehearsal = Rehearsal(work, services)

            for _ in range(2):
                queue, _scan_context, _scan_error, filter_context, plan = rehearsal.cycle()
                self.assertEqual(queue["remediation"]["selected"]["number"], 12)
                self.assertEqual(plan["entries"], [])
                self.assertEqual(filter_context["has_plan"], "false")
                self.assertEqual(services.creates, [])

    def test_closed_alert_leaves_the_scan_without_a_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            services = RehearsalServices()
            work, _origin = make_scratch(tmp)
            rehearsal = Rehearsal(work, services)
            services.alerts["dependabot"] = []

            queue, scan_context, _scan_error, match_context, plan = rehearsal.cycle()
            result, _dispatch_context, _error = rehearsal.dispatch()

        self.assertEqual(queue["findings"], [])
        self.assertIsNone(queue["remediation"]["selected"])
        self.assertEqual(scan_context["finding_count"], "0")
        self.assertEqual(match_context["has_plan"], "false")
        self.assertEqual(plan["entries"], [])
        self.assertEqual(services.creates, [])
        self.assertEqual(result["dispatched"], [])

    def test_published_pull_request_is_left_open_and_alerts_are_never_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            services = RehearsalServices()
            work, origin = make_scratch(tmp)
            rehearsal = Rehearsal(work, services)
            rehearsal.cycle()
            rehearsal.dispatch()

            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            (work / ".git/security-remediation-state.json").write_text(json.dumps({
                "finding": FINDING,
                "source": "dependabot",
                "alert_number": 12,
                "title": "Prototype pollution in lodash",
                "url": ALERT_URL,
                "repo": REPO,
                "trunk": TRUNK,
                "branch": "security/dependabot-12",
                "baseline_sha": git(work, "rev-parse", "origin/%s" % TRUNK),
                "remote_branch_sha": None,
                "alert_open": True,
                "verify_baseline": None,
                "fix_round": 0,
                "published": None,
                "created_at": "2026-10-31T00:00:00Z",
            }, indent=1, sort_keys=True))

            output = io.StringIO()
            previous = os.getcwd()
            os.chdir(work)
            try:
                with mock.patch.dict(os.environ, {
                    "GITHUB_TOKEN": "rehearsal-token",
                    "SECURITY_REMEDIATION_API_BASE": GITHUB_BASE,
                }), mock.patch.object(urllib.request, "urlopen", services), \
                        mock.patch.object(sys, "argv", ["tools.py", "publish"]), \
                        contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    load_tools()["main"]()
            finally:
                os.chdir(previous)
            publish_context = json.loads(output.getvalue().strip().splitlines()[-1])["context_updates"]
            remote_head = git(origin, "rev-parse", "refs/heads/security/dependabot-12")
            trunk_head = git(origin, "rev-parse", "refs/heads/%s" % TRUNK)
            commit_count = git(origin, "rev-list", "--count", remote_head, "^%s" % trunk_head)

        created = [request for request in services.requests
                   if request["method"] == "POST" and request["url"].endswith("/pulls")]
        self.assertEqual(len(created), 1)
        payload = created[0]["body"]
        self.assertFalse(payload["draft"])
        self.assertEqual(payload["base"], TRUNK)
        self.assertEqual(payload["head"], "security/dependabot-12")
        self.assertIn("Alert: %s (dependabot alert #12)" % ALERT_URL, payload["body"])
        self.assertEqual(publish_context["pr_number"], "34")
        self.assertNotIn("clos", json.dumps(publish_context).lower())
        self.assertEqual(commit_count, "1")

        # Left for a human: no merge, no auto-merge, and no alert write.
        for request in services.requests:
            self.assertNotIn("/merge", request["url"])
            if "/alerts" in request["url"]:
                self.assertEqual(request["method"], "GET")
            if request["body"]:
                self.assertNotIn("auto_merge", request["body"])
        self.assertEqual(len(services.created_pull_requests), 1)
        self.assertEqual(services.alerts["dependabot"][0]["state"], "open")


if __name__ == "__main__":
    unittest.main()
