"""The failure path must name the dispatch stage and the underlying error."""

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
import urllib.error
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
GRAPH = ROOT / ".fabro/workflows/dispatch/workflow.fabro"
HELPER = ROOT / ".fabro/workflows/dispatch/scripts/dispatch_stage.py"

REPO = "DWSR/nix-config"
STAGE = "dispatch (dispatch child runs)"

STAGE_BOOTSTRAPS = [
    "scan (scan ready issues and dependabot pull requests)",
    "match (match dispatch rules)",
    "disable_remediation (disable security remediation dispatch)",
    "stack_scan (scan open Kiro spec stacks for review feedback)",
    "normalize (mark stack reruns as label-neutral)",
    "dispatch (dispatch child runs)",
    "prune (archive previous successful dispatch runs)",
]


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
    values = {"repo": REPO, "ready_label": "fabro-ready", "running_label": "fabro-running"}
    return re.sub(r"\{\{\s*inputs\.(\w+)\s*\}\}", lambda m: json.dumps(values[m.group(1)]), script)


def dispatch_script() -> str:
    return render(next(
        source for source in load_scripts()
        if "dispatch-result.json" in source and "_dispatch_stage.begin" in source
    ))


def prune_script() -> str:
    return render(next(
        source for source in load_scripts()
        if "dispatch-archive.json" in source and "_dispatch_stage.begin" in source
    ))


class FakeResponse:
    status = 200

    def __init__(self, payload):
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def install_helper(git_dir: pathlib.Path) -> None:
    (git_dir / "dispatch_stage.py").write_text(HELPER.read_text())


def run_stage(git_dir: pathlib.Path, body: str) -> subprocess.CompletedProcess:
    script = (
        "import sys\n"
        "sys.path.insert(0, '.git')\n"
        "import dispatch_stage\n"
        "dispatch_stage.begin(%r)\n" % STAGE
    ) + body
    return subprocess.run(
        [sys.executable, "-c", script],
        cwd=git_dir.parent,
        capture_output=True,
        text=True,
    )


class StageRecorderTests(unittest.TestCase):
    def test_sys_exit_records_the_stage_and_message(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            install_helper(git_dir)

            result = run_stage(git_dir, "sys.exit('GitHub API GET /runs failed: HTTP 500')\n")
            failure = json.loads((git_dir / "dispatch-failure.json").read_text())
            marker = (git_dir / "dispatch-failed-stage").read_text()

        self.assertEqual(result.returncode, 1)
        self.assertEqual(marker, STAGE)
        self.assertEqual(failure["stage"], STAGE)
        self.assertIn("GitHub API GET /runs failed: HTTP 500", failure["error"])

    def test_uncaught_exception_records_the_error_and_keeps_the_traceback(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            install_helper(git_dir)

            result = run_stage(git_dir, "raise RuntimeError('queue file is corrupt')\n")
            failure = json.loads((git_dir / "dispatch-failure.json").read_text())

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("RuntimeError: queue file is corrupt", failure["error"])
        self.assertIn("RuntimeError: queue file is corrupt", result.stderr)

    def test_successful_exit_records_no_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            install_helper(git_dir)

            result = run_stage(git_dir, "sys.exit(0)\n")
            failure = json.loads((git_dir / "dispatch-failure.json").read_text())

        self.assertEqual(result.returncode, 0)
        self.assertEqual(failure, {"stage": STAGE, "error": ""})


class FailCommandTests(unittest.TestCase):
    def run_fail(self, tmp, *args, stdin=""):
        return subprocess.run(
            [sys.executable, str(HELPER), "fail", *args],
            cwd=tmp,
            input=stdin,
            capture_output=True,
            text=True,
        )

    def test_names_the_stage_and_the_recorded_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            (git_dir / "dispatch-failed-stage").write_text(STAGE)
            (git_dir / "dispatch-failure.json").write_text(
                json.dumps({"stage": STAGE, "error": "GitHub GraphQL failed: HTTP 502"})
            )

            result = self.run_fail(tmp)

        self.assertEqual(result.returncode, 1)
        self.assertEqual(
            result.stderr.strip(),
            "dispatch: %s failed: GitHub GraphQL failed: HTTP 502" % STAGE,
        )

    def test_prefers_the_stage_failure_piped_on_stdin(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            (git_dir / "dispatch-failed-stage").write_text(STAGE)
            (git_dir / "dispatch-failure.json").write_text(
                json.dumps({"stage": STAGE, "error": "stale error"})
            )

            result = self.run_fail(tmp, stdin="run create returned no run id")

        self.assertIn("%s failed: run create returned no run id" % STAGE, result.stderr)
        self.assertNotIn("stale error", result.stderr)

    def test_ignores_a_recorded_error_from_another_stage(self):
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            (git_dir / "dispatch-failed-stage").write_text("prune (archive previous successful dispatch runs)")
            (git_dir / "dispatch-failure.json").write_text(
                json.dumps({"stage": STAGE, "error": "old error"})
            )

            result = self.run_fail(tmp)

        self.assertIn("dispatch: prune (archive previous successful dispatch runs) failed; inspect", result.stderr)
        self.assertNotIn("old error", result.stderr)

    def test_missing_marker_and_error_names_the_setup_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            (pathlib.Path(tmp) / ".git").mkdir()

            result = self.run_fail(tmp)

        self.assertEqual(result.returncode, 1)
        self.assertIn("did not report itself", result.stderr)
        self.assertIn(".git/dispatch-result.json", result.stderr)


class DispatchItemFailureTests(unittest.TestCase):
    def run_dispatch(self, plan, failed_numbers):
        creates = []

        def urlopen(request, timeout=None):
            url = request.full_url
            if "/runs?" in url:
                return FakeResponse({"data": []})
            if request.get_method() == "POST" and url.endswith("/runs"):
                creates.append(json.loads(request.data)["args"]["inputs"]["issue"])
                return FakeResponse({"id": "01CHILD%d" % len(creates)})
            if url.endswith("/start"):
                number = creates[-1]
                if number in failed_numbers:
                    raise urllib.error.HTTPError(
                        url, 500, "Internal Server Error", {}, io.BytesIO(b'{"error":"start failed"}')
                    )
                return FakeResponse({})
            raise AssertionError("unexpected request: %s %s" % (request.get_method(), url))

        git_dir = pathlib.Path(self.tmp) / ".git"
        git_dir.mkdir()
        install_helper(git_dir)
        (git_dir / "dispatch-plan.json").write_text(json.dumps(plan))
        previous = os.getcwd()
        os.chdir(self.tmp)
        try:
            with mock.patch.dict(os.environ, {
                "GITHUB_TOKEN": "token",
                "DISPATCH_API_BASE": "http://api.invalid/api/v1",
                "DISPATCH_GITHUB_API_BASE": "http://github.invalid",
            }), mock.patch("urllib.request.urlopen", urlopen), \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                exit_code = None
                try:
                    exec(compile(dispatch_script(), "dispatch", "exec"), {"__name__": "__main__"})
                except SystemExit as exc:
                    exit_code = exc.code
        finally:
            os.chdir(previous)
        return (
            json.loads((git_dir / "dispatch-result.json").read_text()),
            json.loads((git_dir / "dispatch-failure.json").read_text()),
            exit_code,
        )

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self):
        self._tmp.cleanup()

    def plan(self, *numbers):
        return {
            "repo": REPO,
            "default_branch": "main",
            "entries": [{
                "kind": "issue",
                "number": number,
                "title": "issue",
                "url": "",
                "workflow": "kiro-spec",
                "workflow_version_id": "version-kiro",
                "input_key": "issue",
                "label_swap": "none",
            } for number in numbers],
            "ambiguous": [],
            "skipped": [],
        }

    def test_a_failed_queue_item_is_recorded_with_its_error(self):
        result, failure, exit_code = self.run_dispatch(self.plan(7), {"7"})

        self.assertEqual(exit_code, 1)
        self.assertEqual(failure["stage"], STAGE)
        self.assertIn("issue#7", failure["error"])
        self.assertIn("start failed", failure["error"])
        self.assertEqual(result["failed"][0]["issue"], "7")

    def test_one_bad_queue_item_does_not_abort_the_rest_of_the_batch(self):
        result, failure, exit_code = self.run_dispatch(self.plan(7, 8), {"7"})

        self.assertEqual(exit_code, 1)
        self.assertEqual([item["issue"] for item in result["dispatched"]], ["8"])
        self.assertIn("issue#7", failure["error"])
        self.assertNotIn("issue#8", failure["error"])


class PruneFailureTests(unittest.TestCase):
    def test_archive_failures_are_recorded_with_the_run_ids(self):
        def urlopen(request, timeout=None):
            url = request.full_url
            if request.get_method() == "GET" and "/runs?" in url:
                return FakeResponse({"data": [{
                    "id": "01OLDRUN",
                    "workflow": {"slug": "dispatch"},
                    "repository": {"name": REPO},
                }]})
            if request.get_method() == "POST" and url.endswith("/archive"):
                raise urllib.error.HTTPError(
                    url, 500, "Internal Server Error", {}, io.BytesIO(b'{"error":"archive failed"}')
                )
            raise AssertionError("unexpected request: %s %s" % (request.get_method(), url))

        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp) / ".git"
            git_dir.mkdir()
            install_helper(git_dir)
            (git_dir / "dispatch-queue.json").write_text(json.dumps({"repo": REPO}))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with mock.patch.dict(os.environ, {
                    "DISPATCH_API_BASE": "http://api.invalid/api/v1",
                }), mock.patch("urllib.request.urlopen", urlopen), \
                        contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    exit_code = None
                    try:
                        exec(compile(prune_script(), "prune", "exec"), {"__name__": "__main__"})
                    except SystemExit as exc:
                        exit_code = exc.code
            finally:
                os.chdir(previous)
            failure = json.loads((git_dir / "dispatch-failure.json").read_text())

        self.assertEqual(exit_code, 1)
        self.assertEqual(failure["stage"], "prune (archive previous successful dispatch runs)")
        self.assertIn("01OLDRUN", failure["error"])
        self.assertIn("archive failed", failure["error"])


class GraphStageTests(unittest.TestCase):
    def test_every_python_stage_announces_itself_before_running(self):
        scripts = load_scripts()
        for stage in STAGE_BOOTSTRAPS:
            with self.subTest(stage=stage):
                self.assertTrue(
                    any('_dispatch_stage.begin("%s")' % stage in source for source in scripts),
                    "no stage script calls dispatch_stage.begin(%r)" % stage,
                )

    def test_prepare_installs_the_stage_helper(self):
        scripts = load_scripts()
        setup = next(source for source in scripts if "dispatch-stack-scan.py .git/dispatch-stack-scan.py" in source)
        self.assertIn("dispatch_stage.py .git/dispatch_stage.py", setup)
        self.assertIn("py_compile.compile('.git/dispatch_stage.py', doraise=True)", setup)

    def test_fail_stage_reports_through_the_helper(self):
        scripts = load_scripts()
        fail = next(source for source in scripts if source.startswith("set -eu") and "MSG=$(cat || true)" in source)
        self.assertIn("dispatch_stage.py fail", fail)
        self.assertIn("dispatch-failed-stage", fail)


if __name__ == "__main__":
    unittest.main()
