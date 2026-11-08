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


sys.dont_write_bytecode = True
ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLS = ROOT / ".fabro/workflows/oneshot/scripts/tools.py"
WORKFLOW = ROOT / ".fabro/workflows/oneshot/workflow.fabro"
REVIEW = ROOT / ".fabro/workflows/oneshot/prompts/review.md"
GIT_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Test",
    GIT_AUTHOR_EMAIL="test@example.com",
    GIT_COMMITTER_NAME="Test",
    GIT_COMMITTER_EMAIL="test@example.com",
)


def load_tools():
    namespace = {"__name__": "oneshot_tools_test"}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def git(cwd, *args):
    result = subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV
    )
    if result.returncode:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


class BaselineWiringTests(unittest.TestCase):
    def test_workflow_runs_baseline_between_prepare_and_implementation(self):
        text = WORKFLOW.read_text()
        self.assertIn('label="Precompute baseline checks"', text)
        self.assertIn('timeout="10m"', text)
        self.assertIn("tools.py baseline", text)
        self.assertIn("prepare -> baseline [condition=\"outcome=succeeded\"]", text)
        self.assertIn("baseline -> implement [condition=\"outcome=succeeded\"]", text)

    def test_review_uses_baseline_results_and_keeps_missing_result_fallback(self):
        text = " ".join(REVIEW.read_text().split())
        self.assertIn("read `baseline_results`", text)
        self.assertIn("status is `unknown`", text)
        self.assertIn("baseline result is missing or lacks a status", text)
        self.assertIn("baseline_results` is missing or malformed", text)
        self.assertIn("explicitly non-blocking evidence", text)


class BaselineCommandTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / "repo"
        self.root.mkdir()
        git(self.root, "init", "--quiet", "--initial-branch=main")
        git(self.root, "config", "user.name", "Test")
        git(self.root, "config", "user.email", "test@example.com")
        for path, text in {
            "tests/dependency-cooldown/cooldown.test.py": "raise SystemExit(1)\n",
            "tests/fabro-workflows/model-fallbacks.test.py": "raise SystemExit(0)\n",
            "tests/oneshot/baseline.test.py": "raise SystemExit(0)\n",
            ".fabro/workflows/oneshot/workflow.fabro": "baseline workflow\n",
        }.items():
            target = self.root / path
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text)
        git(self.root, "add", "--all")
        git(self.root, "commit", "--quiet", "-m", "baseline")
        self.baseline = git(self.root, "rev-parse", "HEAD")
        self.tools = load_tools()
        state_path = self.root / ".git/oneshot-state.json"
        state_path.write_text(json.dumps({"baseline_sha": self.baseline}))

        self.bin = pathlib.Path(self.temp.name) / "bin"
        self.bin.mkdir()
        self.fabro_log = pathlib.Path(self.temp.name) / "fabro.log"
        fabro = self.bin / "fabro"
        fabro.write_text('#!/bin/sh\nprintf "%s\\n" "$*" >> "$BASELINE_FABRO_LOG"\n')
        fabro.chmod(0o755)

    def run_baseline(self):
        previous = os.getcwd()
        os.chdir(self.root)
        try:
            with mock.patch.dict(os.environ, {
                "BASELINE_FABRO_LOG": str(self.fabro_log),
                "PATH": str(self.bin) + os.pathsep + os.environ.get("PATH", ""),
            }):
                with mock.patch.object(
                    self.tools["shutil"],
                    "which",
                    side_effect=lambda name: str(self.bin / name) if name == "fabro" else None,
                ):
                    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                        io.StringIO()
                    ):
                        self.tools["baseline"]([])
        finally:
            os.chdir(previous)
            shutil.rmtree(TOOLS.parent / "__pycache__", ignore_errors=True)

    def test_records_baseline_results_without_touching_review_worktree(self):
        # A workflow added after the baseline must not be treated as a baseline check.
        current_workflow = self.root / ".fabro/workflows/new/workflow.fabro"
        current_workflow.parent.mkdir(parents=True)
        current_workflow.write_text("not present at baseline\n")
        status_before = git(self.root, "status", "--porcelain")

        self.run_baseline()

        state = json.loads((self.root / ".git/oneshot-state.json").read_text())
        results = state["baseline_results"]
        by_command = {result["command"]: result for result in results}
        self.assertEqual(
            by_command["python3 tests/dependency-cooldown/cooldown.test.py"]["status"],
            "failed",
        )
        self.assertEqual(
            by_command["python3 tests/fabro-workflows/model-fallbacks.test.py"]["status"],
            "passed",
        )
        self.assertEqual(
            by_command[
                "fabro validate --quiet --no-upgrade-check .fabro/workflows/oneshot/workflow.fabro"
            ]["status"],
            "passed",
        )
        self.assertEqual(
            by_command[
                "git diff --check %s %s" % (
                    git(self.root, "hash-object", "-t", "tree", "/dev/null"),
                    self.baseline,
                )
            ]["status"],
            "passed",
        )
        self.assertIn(by_command["nix flake check --no-build"]["status"], ("passed", "unknown"))
        self.assertEqual(by_command["nix flake check --no-build"]["status"], "unknown")
        self.assertTrue(
            all(set(result) == {"command", "status", "reason"} for result in results)
        )
        self.assertEqual(
            self.fabro_log.read_text().splitlines(),
            ["validate --quiet --no-upgrade-check .fabro/workflows/oneshot/workflow.fabro"],
        )
        self.assertEqual(git(self.root, "status", "--porcelain"), status_before)
        self.assertEqual(git(self.root, "worktree", "list", "--porcelain").count("worktree "), 1)

    def test_unknown_result_for_missing_command_includes_reason(self):
        result = self.tools["baseline_command"](
            ["missing-baseline-command"], str(self.root), 10**9, 1
        )

        self.assertEqual(result["status"], "unknown")
        self.assertIn("missing-baseline-command", result["reason"])


if __name__ == "__main__":
    unittest.main()
