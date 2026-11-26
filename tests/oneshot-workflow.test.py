import contextlib
import io
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".fabro/workflows/oneshot/scripts/tools.py"
GRAPH = ROOT / ".fabro/workflows/oneshot/workflow.fabro"
GIT_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Test",
    GIT_AUTHOR_EMAIL="test@example.com",
    GIT_COMMITTER_NAME="Test",
    GIT_COMMITTER_EMAIL="test@example.com",
)


def load_tools():
    namespace = {"__name__": "oneshot_workflow_test", "__file__": str(TOOLS)}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def git(cwd, *args):
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV
    )
    if result.returncode:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


class ProbeTests(unittest.TestCase):
    def test_probe_returns_exact_failing_command_detail(self):
        tools = load_tools()
        with mock.patch.object(tools["subprocess"], "run", return_value=subprocess.CompletedProcess(
                ["fake"], 7, "", "DNS lookup failed")) as run:
            blocker = tools["run_probe"]("GitHub reachability", ["fake"], 15)
        self.assertEqual(blocker, "GitHub reachability probe failed: DNS lookup failed")
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_probe_reports_timeout_and_unavailable_provider_is_optional(self):
        tools = load_tools()
        with mock.patch.object(tools["subprocess"], "run", side_effect=subprocess.TimeoutExpired(["fake"], 3)):
            self.assertEqual(tools["run_probe"]("Nix", ["fake"], 3), "Nix probe timed out after 3 seconds")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(tools["github_rate_limit_blocker"](), "")
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token", "ONESHOT_API_BASE": "http://127.0.0.1:1"}):
            self.assertIn("GitHub rate-limit probe failed", tools["github_rate_limit_blocker"]())

    def test_diagnose_validates_workflow_only_when_issue_scope_suggests_it(self):
        tools = load_tools()
        calls = []
        tools["github_reachability_blocker"] = lambda: ""
        tools["github_rate_limit_blocker"] = lambda: ""
        tools["run_probe"] = lambda label, _cmd, _timeout: calls.append((label, _cmd)) or ""
        self.assertEqual(tools["diagnose_environment_blocker"]("Add a new Nix service"), "")
        self.assertFalse(any(label == "Fabro workflow validation" for label, _command in calls))
        self.assertEqual(tools["diagnose_environment_blocker"]("Update the oneshot workflow"), "")
        fabro_command = [command for label, command in calls if label == "Fabro workflow validation"]
        self.assertEqual(fabro_command, [["fabro", "validate", ".fabro/workflows/oneshot/workflow.fabro"]])

    def test_diagnose_blocks_and_persists_failure_without_starting_implementation(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            pathlib.Path(tmp, ".git", "oneshot-issue.md").write_text("A normal change\n")
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with mock.patch.dict(tools, {"diagnose_environment_blocker": lambda _issue: "GitHub reachability probe failed: Could not resolve host github.com"}):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                        tools["diagnose"](["381"])
                report = json.loads(output.getvalue())
                state = json.loads(pathlib.Path(".git/oneshot-state.json").read_text())
                self.assertEqual(report["context_updates"]["preflight_status"], "BLOCKED")
                self.assertEqual(report["context_updates"]["environment_blocker"],
                                 "GitHub reachability probe failed: Could not resolve host github.com")
                self.assertTrue(state["preflight_only"])
                self.assertEqual(state["environment_blocker"], report["context_updates"]["environment_blocker"])
                self.assertNotIn("baseline_sha", state)
            finally:
                os.chdir(previous)

    def test_diagnose_cli_dispatches_to_handler(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp, "tools.py")
            script.write_text(TOOLS.read_text())
            git_dir = pathlib.Path(tmp, ".git")
            git_dir.mkdir()
            pathlib.Path(git_dir, "oneshot-issue.md").write_text("A normal change\n")
            fake_bin = pathlib.Path(tmp, "bin")
            fake_bin.mkdir()
            for command in ("git", "nix"):
                executable = pathlib.Path(fake_bin, command)
                executable.write_text("#!/bin/sh\nexit 0\n")
                executable.chmod(0o755)
            env = dict(os.environ, PATH=str(fake_bin) + os.pathsep + os.environ["PATH"])
            output = subprocess.run(
                [os.environ.get("PYTHON", "python3"), str(script), "diagnose", "381"],
                cwd=tmp, env=env, capture_output=True, text=True,
            )
        self.assertEqual(output.returncode, 0, output.stderr)
        report = json.loads(output.stdout)
        self.assertEqual(report["context_updates"]["preflight_status"], "READY")
        self.assertNotIn("unknown command 'diagnose'", output.stderr)

    def test_workflow_gates_implement_and_fails_blocked_preflight(self):
        graph = GRAPH.read_text()
        self.assertIn('prepare -> exit [condition="outcome=succeeded && context.skipped=true", weight=10]', graph)
        self.assertIn('prepare -> diagnose [condition="outcome=succeeded && context.skipped!=true && context.preflight_status!=BLOCKED"]', graph)
        blocked_edge = 'prepare -> fail [condition="outcome=succeeded && context.preflight_status=BLOCKED", weight=10]'
        self.assertIn(blocked_edge, graph)
        self.assertIn('diagnose -> baseline [condition="outcome=succeeded && context.preflight_status=READY"]', graph)
        self.assertIn('baseline -> implement [condition="outcome=succeeded"]', graph)
        self.assertIn('diagnose -> fail [condition="outcome=succeeded && context.preflight_status=BLOCKED"]', graph)
        self.assertIn('tools.py fail \\"{{ inputs.issue }}\\"', graph)
        self.assertNotIn('prepare -> implement [condition="outcome=succeeded"]', graph)


class PrepareSkipTests(unittest.TestCase):
    def issue(self, state="open", labels=("fabro-ready", "type/oneshot")):
        return {
            "number": 382,
            "state": state,
            "title": "fix(oneshot): skip cleanly",
            "body": "Skip closed or already-published issues.",
            "html_url": "https://github.com/example/project/issues/382",
            "labels": [{"name": name} for name in labels],
        }

    def prepare_tools(self, issue, open_prs=None, live_runs=()):
        tools = load_tools()
        calls = []
        tools["github_reachability_blocker"] = lambda: ""
        tools["origin_repo"] = lambda: ("example", "project")
        tools["run"] = lambda *_args, **_kwargs: ""
        tools["live_oneshot_runs"] = lambda *_args: list(live_runs)

        def fake_gh(method, path, body=None, expect=(200, 201, 204)):
            calls.append((method, path, body))
            if method == "GET" and path.endswith("/issues/%s" % issue["number"]):
                return 200, issue
            if method == "GET" and "/pulls?" in path:
                return 200, list(open_prs or [])
            return 200, None

        tools["gh"] = fake_gh
        return tools, calls

    def run_prepare(self, tools):
        output = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    tools["prepare"](["382"])
            finally:
                os.chdir(previous)
        return json.loads(output.getvalue().strip().splitlines()[-1])

    def test_closed_issue_skips_and_clears_queue_labels(self):
        tools, calls = self.prepare_tools(
            self.issue(state="closed", labels=("fabro-ready", "fabro-running")))
        report = self.run_prepare(tools)

        self.assertEqual(report["context_updates"]["skipped"], "true")
        self.assertEqual(report["context_updates"]["skip_reason"], "closed")
        self.assertIn(
            ("DELETE", "/repos/example/project/issues/382/labels/fabro-running", None), calls)
        self.assertIn(
            ("DELETE", "/repos/example/project/issues/382/labels/fabro-ready", None), calls)

    def test_open_pull_request_that_closes_the_issue_skips(self):
        tools, calls = self.prepare_tools(self.issue(), open_prs=[{
            "number": 17,
            "body": "This fixes #382.",
            "head": {"ref": "feature", "repo": {"full_name": "example/project"}},
        }])
        report = self.run_prepare(tools)

        self.assertEqual(report["context_updates"]["skip_reason"], "pull_request")
        self.assertIn(
            ("DELETE", "/repos/example/project/issues/382/labels/fabro-running", None), calls)

    def test_oneshot_branch_with_an_open_pull_request_skips(self):
        tools, _calls = self.prepare_tools(self.issue(), open_prs=[{
            "number": 18,
            "body": "",
            "head": {"ref": "oneshot/issue-382", "repo": {"full_name": "example/project"}},
        }])
        report = self.run_prepare(tools)

        self.assertEqual(report["context_updates"]["skip_reason"], "pull_request")

    def test_another_live_run_is_superseded_without_touching_labels(self):
        tools, calls = self.prepare_tools(
            self.issue(), live_runs=[{"id": "first"}, {"id": "second"}])
        report = self.run_prepare(tools)

        self.assertEqual(report["context_updates"]["skip_reason"], "superseded")
        self.assertFalse(any(method == "DELETE" for method, _path, _body in calls))

    def test_resumed_run_is_not_superseded_by_a_duplicate(self):
        issue = self.issue()
        tools, _calls = self.prepare_tools(
            issue, live_runs=[{"id": "first"}, {"id": "second"}])
        tools["load_meta"] = lambda _number: ({
            "fingerprint": tools["issue_fingerprint"](issue["title"], issue["body"]),
            "recorded_at": "2026-01-01T00:00:00Z",
        }, "sha")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            pathlib.Path(tmp, ".git", "oneshot-state.json").write_text(
                json.dumps({"issue": 382, "trunk": "main", "baseline_sha": "abc"}))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                    tools["prepare"](["382"])
            finally:
                os.chdir(previous)

        report = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertNotIn("skipped", report["context_updates"])

    def test_closing_references_detect_supported_forms(self):
        tools = load_tools()
        self.assertTrue(tools["pull_request_closes_issue"]("Fixes owner/project#382", 382))
        self.assertTrue(tools["pull_request_closes_issue"](
            "Closes https://github.com/owner/project/issues/382", 382))
        self.assertFalse(tools["pull_request_closes_issue"](
            "See https://github.com/owner/project/issues/382 for details", 382))
        self.assertFalse(tools["pull_request_closes_issue"]("This mentions #382", 382))
        self.assertFalse(tools["pull_request_closes_issue"]("Fixes #3821", 382))

    def test_live_run_listing_keeps_only_this_oneshot_issue(self):
        tools = load_tools()
        payload = {"data": [
            {"id": "label", "workflow": {"slug": "oneshot"},
             "repository": {"name": "example/project"}, "labels": {"issue": "382"}},
            {"id": "goal", "workflow": {"slug": "oneshot"},
             "repository": {"name": "example/project"},
             "goal": "Implement GitHub issue #382 as a oneshot change"},
            {"id": "other-issue", "workflow": {"slug": "oneshot"},
             "repository": {"name": "example/project"}, "labels": {"issue": "383"}},
            {"id": "other-repo", "workflow": {"slug": "oneshot"},
             "repository": {"name": "example/other"}, "labels": {"issue": "382"}},
            {"id": "other-workflow", "workflow": {"slug": "dispatch"},
             "repository": {"name": "example/project"}, "labels": {"issue": "382"}},
        ]}

        class Response:
            def read(self):
                return json.dumps(payload).encode()

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

        with mock.patch.object(tools["urllib"].request, "urlopen", return_value=Response()):
            runs = tools["live_oneshot_runs"]("example", "project", 382)
        self.assertEqual([run["id"] for run in runs], ["label", "goal"])

        with mock.patch.object(tools["urllib"].request, "urlopen", side_effect=OSError("offline")):
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertIsNone(tools["live_oneshot_runs"]("example", "project", 382))

    def test_changed_issue_still_trips_the_fingerprint_guard(self):
        tools, _calls = self.prepare_tools(self.issue(), live_runs=[{"id": "only"}])
        tools["load_meta"] = lambda _number: (
            {"fingerprint": "000000000000", "recorded_at": "2026-01-01T00:00:00Z"}, "sha")
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            pathlib.Path(tmp, ".git", "oneshot-state.json").write_text(
                json.dumps({"issue": 382}))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as caught:
                        tools["prepare"](["382"])
            finally:
                os.chdir(previous)

        self.assertIn("changed after this oneshot run started", str(caught.exception))

    def test_fail_marks_issue_failed_and_clears_run_labels(self):
        tools = load_tools()
        calls = []
        tools["origin_repo"] = lambda: ("example", "project")

        def fake_gh(method, path, body=None, expect=(200, 201, 204)):
            calls.append((method, path, body))
            return 200, None

        tools["gh"] = fake_gh
        with contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            tools["fail"](["382"])

        self.assertIn(
            ("DELETE", "/repos/example/project/issues/382/labels/fabro-running", None), calls)
        self.assertIn(
            ("DELETE", "/repos/example/project/issues/382/labels/fabro-ready", None), calls)
        self.assertIn(
            ("POST", "/repos/example/project/issues/382/labels", {"labels": ["fabro-failed"]}), calls)


class FailureSummaryTests(unittest.TestCase):
    def run_fail(self, state, stdin_text, review=None, marker=None):
        tools = load_tools()
        calls = []

        def fake_gh(method, path, body=None, expect=(200, 201, 204)):
            calls.append((method, path, body))
            if method == "GET" and "/pulls" in path:
                return 200, [{
                    "number": 17,
                    "draft": True,
                    "head": {"ref": "oneshot/issue-382",
                             "repo": {"full_name": "example/project"}},
                }]
            return 201, {}

        tools["origin_repo"] = lambda: ("example", "project")
        tools["gh"] = fake_gh
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp, ".git")
            git_dir.mkdir()
            if state is not None:
                (git_dir / "oneshot-state.json").write_text(json.dumps(state))
            if review is not None:
                (git_dir / "oneshot-review.json").write_text(json.dumps(review))
            if marker is not None:
                (git_dir / "oneshot-stage-failure.json").write_text(json.dumps(marker))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with mock.patch.object(sys, "stdin", io.StringIO(stdin_text)), \
                        contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["fail"](["382"])
                report = pathlib.Path(".git/oneshot-failure.md").read_text()
            finally:
                os.chdir(previous)
        return report, output.getvalue().strip(), calls

    def state(self):
        return {
            "issue": 382,
            "issue_url": "https://github.com/example/project/issues/382",
            "baseline_sha": "0123456789abcdef",
            "baseline_results": [
                {"command": "python3 tests/dependency-cooldown/cooldown.test.py",
                 "status": "passed", "reason": "exit 0"},
                {"command": "nix flake check --no-build",
                 "status": "unknown", "reason": "nix is not installed"},
            ],
        }

    def test_rejection_writes_and_comments_findings_on_issue_and_draft_pr(self):
        review = {
            "stage": "review",
            "verdict": "REJECTED",
            "stage_failure": "review: tools.py:198 hides the review verdict",
            "review_findings": "1. tools.py:198 posts a generic sentence instead of the reason",
            "review_remediation": "1. include the concrete stage_failure in the comment",
        }

        report, detail, calls = self.run_fail(
            self.state(), "review: tools.py:198 hides the review verdict", review=review)

        self.assertEqual(detail, "review: tools.py:198 hides the review verdict")
        self.assertIn("**Stage:** review", report)
        self.assertIn("**Pull request:** #17 (draft)", report)
        self.assertIn("tools.py:198 posts a generic sentence", report)
        self.assertIn("include the concrete stage_failure", report)
        self.assertIn("1 passed, 0 failed, 1 unknown", report)
        self.assertIn("nix is not installed", report)
        self.assertIn("Healthy: network, Nix inputs", report)

        endpoints = {(method, path) for method, path, _body in calls}
        self.assertIn(("POST", "/repos/example/project/issues/382/comments"), endpoints)
        self.assertIn(("POST", "/repos/example/project/issues/17/comments"), endpoints)
        bodies = [body["body"] for method, path, body in calls if path.endswith("/comments")]
        self.assertEqual(len(bodies), 2)
        for body in bodies:
            self.assertIn("**Stage:** review", body)
            self.assertIn("tools.py:198 hides the review verdict", body)
            self.assertIn("tools.py:198 posts a generic sentence", body)

    def test_scripted_failure_reports_the_recorded_stage_instead_of_a_generic_sentence(self):
        marker = {
            "stage": "baseline",
            "detail": "nix flake check --no-build failed: error: infinite recursion encountered",
        }

        report, detail, calls = self.run_fail(self.state(), "", marker=marker)

        self.assertEqual(detail, marker["detail"])
        self.assertIn("**Stage:** baseline", report)
        self.assertIn("infinite recursion encountered", report)
        self.assertIn("No review findings were recorded", report)
        self.assertIn(
            ("POST", "/repos/example/project/issues/382/comments"),
            {(method, path) for method, path, _body in calls})
        self.assertNotIn("inspect the failing stage output in the run events",
                         [body["body"] for _method, path, body in calls
                          if path.endswith("/comments")][0])

    def test_scripted_marker_wins_over_a_stale_agent_stage_failure(self):
        marker = {"stage": "publish", "detail": "publish: git push failed: lease mismatch"}

        report, detail, _calls = self.run_fail(
            self.state(), "review: stale findings from an earlier round", marker=marker)

        self.assertEqual(detail, marker["detail"])
        self.assertIn("**Stage:** publish", report)
        self.assertNotIn("stale findings from an earlier round", report)

    def test_later_stage_failure_ignores_a_stale_review_record(self):
        review = {
            "stage": "review",
            "verdict": "REJECTED",
            "review_findings": "1. stale finding from the previous round",
            "review_remediation": "1. stale remediation from the previous round",
        }

        report, detail, _calls = self.run_fail(
            self.state(), "check: issue #382 still needs 1200 changed lines", review=review)

        self.assertEqual(detail, "check: issue #382 still needs 1200 changed lines")
        self.assertIn("**Stage:** check", report)
        self.assertNotIn("stale finding from the previous round", report)
        self.assertNotIn("stale remediation from the previous round", report)
        self.assertIn("No review findings were recorded", report)

    def test_cli_records_scripted_failure_and_clears_it_after_success(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp, ".git")
            git_dir.mkdir()
            marker_path = git_dir / "oneshot-stage-failure.json"
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                def boom(_rest):
                    raise SystemExit("check failed: no changes produced")

                tools["check"] = boom
                with mock.patch.object(sys, "argv", ["tools.py", "check"]):
                    with contextlib.redirect_stderr(io.StringIO()):
                        with self.assertRaises(SystemExit):
                            tools["main"]()
                marker = json.loads(marker_path.read_text())
                self.assertEqual(marker["stage"], "check")
                self.assertEqual(marker["detail"], "check failed: no changes produced")

                tools["prepare"] = lambda _rest: None
                with mock.patch.object(sys, "argv", ["tools.py", "prepare"]):
                    tools["main"]()
                self.assertFalse(marker_path.exists())
            finally:
                os.chdir(previous)

    def test_fail_stage_pipes_the_failure_and_every_prompt_records_one(self):
        graph = GRAPH.read_text()
        self.assertIn(
            'printf \'%s\' \\"$MSG\\" | python3 .git/oneshot-scripts/tools.py fail', graph)
        self.assertIn('stdin_source="stage_failure"', graph)
        prompts = ROOT / ".fabro/workflows/oneshot/prompts"
        self.assertIn(".git/oneshot-review.json", (prompts / "review.md").read_text())
        self.assertIn(
            '"stage_failure": "simplify:', (prompts / "simplify.md").read_text())
        self.assertIn(
            '"stage_failure": "implement:', (prompts / "implement.md").read_text())


class ResumeStateTests(unittest.TestCase):
    ISSUE_NUMBER = 383
    ISSUE = {
        "number": 383,
        "state": "open",
        "title": "feat(oneshot): persist run state",
        "body": "Persist state so a fresh sandbox can resume.",
        "html_url": "https://github.com/example/project/issues/383",
        "labels": [{"name": "fabro-ready"}, {"name": "type/oneshot"}],
    }

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.origin = root / "origin.git"
        self.work = root / "work"
        subprocess.run(["git", "init", "--bare", "-b", "main", str(self.origin)],
                       check=True, capture_output=True)
        subprocess.run(["git", "init", "-b", "main", str(self.work)],
                       check=True, capture_output=True)
        git(self.work, "config", "user.email", "test@example.com")
        git(self.work, "config", "user.name", "Test")
        (self.work / "fixture.txt").write_text("baseline\n")
        git(self.work, "add", "fixture.txt")
        git(self.work, "commit", "-m", "baseline")
        git(self.work, "remote", "add", "origin", str(self.origin))
        git(self.work, "push", "origin", "main")
        self.baseline = git(self.work, "rev-parse", "HEAD")
        self.tools = load_tools()

    def fingerprint(self):
        return self.tools["issue_fingerprint"](self.ISSUE["title"], self.ISSUE["body"])

    def state(self):
        return {
            "issue": self.ISSUE_NUMBER,
            "issue_title": self.ISSUE["title"],
            "issue_url": self.ISSUE["html_url"],
            "repo": "example/project",
            "trunk": "main",
            "baseline_sha": self.baseline,
            "simplify_round": 0,
            "created_at": "2026-01-01T00:00:00Z",
            "fingerprint": self.fingerprint(),
        }

    def chdir(self):
        previous = os.getcwd()
        os.chdir(self.work)
        self.addCleanup(os.chdir, previous)

    def write_meta(self, state, issue_text):
        previous = os.getcwd()
        os.chdir(self.work)
        try:
            self.tools["write_meta_commit"](
                self.ISSUE_NUMBER,
                self.tools["meta_files"](
                    self.ISSUE_NUMBER, state["fingerprint"], state, issue_text),
                "",
                "test meta",
            )
        finally:
            os.chdir(previous)

    def fake_gh(self, method, path, body=None, expect=(200, 201, 204)):
        if method == "GET" and path.endswith("/issues/%d" % self.ISSUE_NUMBER):
            return 200, dict(self.ISSUE)
        if method == "GET" and "/pulls?" in path:
            return 200, []
        return 200, None

    def prepare_with_fakes(self):
        tools = self.tools
        tools["github_reachability_blocker"] = lambda: ""
        tools["origin_repo"] = lambda: ("example", "project")
        tools["detect_trunk"] = lambda: "main"
        tools["live_oneshot_runs"] = lambda *_args: []
        tools["gh"] = self.fake_gh
        self.chdir()
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            tools["prepare"]([str(self.ISSUE_NUMBER)])
        return json.loads(output.getvalue().strip().splitlines()[-1])["context_updates"]

    def test_prepare_restores_state_and_helper_after_a_fresh_sandbox(self):
        issue_text = "# GitHub issue #383: feat(oneshot): persist run state\n\nbody\n"
        state = self.state()
        state["simplify_round"] = 2
        state["baseline_results"] = [
            {"command": "baseline", "status": "passed", "reason": "exit 0"},
        ]
        self.write_meta(state, issue_text)
        scripts = self.work / ".git/oneshot-scripts"
        shutil.rmtree(scripts, ignore_errors=True)
        (self.work / ".git/oneshot-state.json").unlink(missing_ok=True)
        (self.work / ".git/oneshot-issue.md").unlink(missing_ok=True)

        context = self.prepare_with_fakes()

        self.assertEqual(context["issue_number"], "383")
        self.assertEqual(context["baseline_sha"], self.baseline)
        restored = json.loads((self.work / ".git/oneshot-state.json").read_text())
        self.assertEqual(restored["baseline_sha"], self.baseline)
        self.assertEqual(restored["fingerprint"], self.fingerprint())
        # These only survive when prepare restores the persisted state instead
        # of starting a new run with a fresh baseline.
        self.assertEqual(restored["simplify_round"], 2)
        self.assertEqual(restored["created_at"], "2026-01-01T00:00:00Z")
        self.assertTrue((scripts / "tools.py").exists())
        self.assertIn("# GitHub issue #383", (self.work / ".git/oneshot-issue.md").read_text())

    def test_prepare_persists_state_and_issue_snapshot_on_the_meta_branch(self):
        context = self.prepare_with_fakes()

        self.assertEqual(context["baseline_sha"], self.baseline)
        state = json.loads(git(self.origin, "show", "oneshot-meta/issue-383:oneshot-state.json"))
        self.assertEqual(state["baseline_sha"], self.baseline)
        self.assertEqual(state["fingerprint"], self.fingerprint())
        fingerprint = json.loads(git(self.origin, "show", "oneshot-meta/issue-383:fingerprint.json"))
        self.assertEqual(fingerprint["fingerprint"], self.fingerprint())
        snapshot = git(self.origin, "show", "oneshot-meta/issue-383:oneshot-issue.md")
        self.assertIn("# GitHub issue #383", snapshot)

    def test_failed_run_pushes_the_checkpoint_branch(self):
        (self.work / "fixture.txt").write_text("implemented\n")
        (self.work / ".git/oneshot-state.json").write_text(json.dumps(self.state()))
        tools = self.tools
        tools["origin_repo"] = lambda: ("example", "project")
        tools["gh"] = self.fake_gh
        self.chdir()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            tools["fail"]([str(self.ISSUE_NUMBER)])

        refs = git(self.origin, "for-each-ref", "--format=%(refname)", "refs/heads")
        self.assertIn("refs/heads/oneshot/issue-383", refs)
        self.assertEqual(git(self.origin, "show", "oneshot/issue-383:fixture.txt"), "implemented")


if __name__ == "__main__":
    unittest.main()
