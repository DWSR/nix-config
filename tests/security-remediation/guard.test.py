import contextlib
import hashlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/security-remediation/workflow.toml"
MARKER = "cat > .git/security-remediation-scripts/tools.py <<'SECURITY_REMEDIATION_TOOLS_PY'\n"
STATE_PATH = ".git/security-remediation-state.json"
FAILED_STAGE_PATH = ".git/security-remediation-failed-stage"


def load_tools():
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nSECURITY_REMEDIATION_TOOLS_PY", 1)[0]
    namespace = {"__name__": "security_remediation_guard_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def make_repo(tmp):
    work = pathlib.Path(tmp, "work")
    subprocess.run(["git", "init", "-b", "main", str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "test@example.test")
    git(work, "config", "user.name", "Test")
    (work / "flake.nix").write_text("{}\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "init")
    return work


def write_state(work, **overrides):
    state = {
        "finding": "dependabot:12",
        "source": "dependabot",
        "alert_number": 12,
        "title": "Prototype pollution in lodash",
        "url": "https://github.com/DWSR/nix-config/security/dependabot/12",
        "repo": "DWSR/nix-config",
        "trunk": "main",
        "branch": "security/dependabot-12",
        "baseline_sha": git(work, "rev-parse", "HEAD"),
        "remote_branch_sha": None,
        "alert_open": True,
        "verify_baseline": None,
        "fix_round": 0,
        "published": None,
        "created_at": "2026-10-30T00:00:00Z",
    }
    state.update(overrides)
    (work / STATE_PATH).write_text(json.dumps(state, indent=1, sort_keys=True))
    return state


def read_state(work):
    return json.loads((work / STATE_PATH).read_text())


def diff_sha256(work):
    diff = subprocess.run(
        ["git", "diff", "--binary", "HEAD"], cwd=work, capture_output=True, check=True)
    return hashlib.sha256(diff.stdout).hexdigest()


def run_command(tools, cwd, argv):
    output = io.StringIO()
    previous = os.getcwd()
    os.chdir(cwd)
    try:
        with mock.patch.object(sys, "argv", ["tools.py", *argv]), \
                contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(io.StringIO()):
            tools["main"]()
    finally:
        os.chdir(previous)
    return context_from(output.getvalue())


def context_from(stdout):
    return json.loads(stdout.strip().splitlines()[-1])["context_updates"]


class SnapshotTests(unittest.TestCase):
    def test_records_the_head_and_the_tracked_diff_fingerprint(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            (work / "flake.nix").write_text("{\"fixed\": true}\n")
            expected_head = git(work, "rev-parse", "HEAD")
            expected_diff = diff_sha256(work)

            run_command(load_tools(), work, ["snapshot"])

            baseline = read_state(work)["verify_baseline"]
            self.assertEqual(baseline, {"head": expected_head, "diff_sha256": expected_diff})

    def test_fingerprint_ignores_untracked_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            before = diff_sha256(work)
            (work / ".cache").mkdir()
            (work / ".cache/output.json").write_text("{}\n")
            (work / "result.txt").write_text("build output\n")

            run_command(load_tools(), work, ["snapshot"])

            baseline = read_state(work)["verify_baseline"]
            self.assertEqual(baseline["diff_sha256"], before)
            self.assertEqual(git(work, "status", "--porcelain"), "?? .cache/\n?? result.txt")

    def test_snapshot_does_not_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            head = git(work, "rev-parse", "HEAD")

            run_command(load_tools(), work, ["snapshot"])

            self.assertEqual(git(work, "rev-parse", "HEAD"), head)
            self.assertEqual(git(work, "status", "--porcelain"), "")


class VerifyGuardTests(unittest.TestCase):
    def test_unchanged_tracked_tree_reports_tree_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            (work / "flake.nix").write_text("{\"fixed\": true}\n")
            tools = load_tools()
            run_command(tools, work, ["snapshot"])

            context = run_command(tools, work, ["verify_guard"])

            self.assertEqual(context, {"tree_unchanged": "true"})

    def test_untracked_build_output_does_not_break_the_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            (work / "flake.nix").write_text("{\"fixed\": true}\n")
            tools = load_tools()
            run_command(tools, work, ["snapshot"])

            (work / ".cache").mkdir()
            (work / ".cache/output.json").write_text("{}\n")
            (work / "node_modules/left-pad").mkdir(parents=True)
            (work / "node_modules/left-pad/index.js").write_text("\n")

            context = run_command(tools, work, ["verify_guard"])

            self.assertEqual(context["tree_unchanged"], "true")
            self.assertNotIn("stage_failure", context)

    def test_changed_tracked_tree_reports_false_and_a_stage_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            (work / "flake.nix").write_text("{\"fixed\": true}\n")
            tools = load_tools()
            run_command(tools, work, ["snapshot"])

            (work / "flake.nix").write_text("{\"fixed\": false}\n")
            context = run_command(tools, work, ["verify_guard"])

            self.assertEqual(context["tree_unchanged"], "false")
            self.assertIn("tracked", context["stage_failure"])
            self.assertIn("must not modify tracked files", context["stage_failure"])

    def test_staged_tracked_change_reports_false(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            tools = load_tools()
            run_command(tools, work, ["snapshot"])

            (work / "flake.nix").write_text("{\"staged\": true}\n")
            git(work, "add", "-A")
            context = run_command(tools, work, ["verify_guard"])

            self.assertEqual(context["tree_unchanged"], "false")
            self.assertIn("tracked files changed", context["stage_failure"])

    def test_moved_head_reports_false_even_when_the_tree_is_identical(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)
            tools = load_tools()
            run_command(tools, work, ["snapshot"])

            git(work, "commit", "--allow-empty", "-m", "verify stage should never commit")
            context = run_command(tools, work, ["verify_guard"])

            self.assertEqual(context["tree_unchanged"], "false")
            self.assertIn("HEAD moved", context["stage_failure"])

    def test_guard_requires_the_snapshot_first(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)

            with self.assertRaises(SystemExit) as caught:
                run_command(load_tools(), work, ["verify_guard"])

            self.assertIn("snapshot", str(caught.exception.code))


class ReworkTests(unittest.TestCase):
    def test_increments_state_and_reports_the_round(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work)

            context = run_command(load_tools(), work, ["rework"])

            self.assertEqual(context, {"fix_round": "1"})
            self.assertEqual(read_state(work)["fix_round"], 1)

    def test_reports_a_stage_failure_above_the_third_round(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work, fix_round=3)

            context = run_command(load_tools(), work, ["rework"])

            self.assertEqual(context["fix_round"], "4")
            self.assertIn("stage_failure", context)
            self.assertIn("3", context["stage_failure"])
            self.assertIn(".git/security-remediation-test.log", context["stage_failure"])
            self.assertEqual(read_state(work)["fix_round"], 4)

    def test_round_three_still_routes_back_to_fix(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            write_state(work, fix_round=2)

            context = run_command(load_tools(), work, ["rework"])

            self.assertEqual(context, {"fix_round": "3"})


class FailTests(unittest.TestCase):
    def extract_tools(self, work, tmp):
        script = WORKFLOW_TOML.read_text().split(MARKER, 1)[1].split(
            "\nSECURITY_REMEDIATION_TOOLS_PY", 1)[0]
        path = pathlib.Path(tmp, "tools.py")
        path.write_text(script)
        return path

    def test_prefixes_the_recorded_stage_and_exits_non_zero(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            tools_path = self.extract_tools(work, tmp)
            (work / FAILED_STAGE_PATH).write_text("verify (verify fixes)\n")

            result = subprocess.run(
                [sys.executable, str(tools_path), "fail"],
                input="pytest failed",
                capture_output=True,
                text=True,
                cwd=work,
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "security-remediation: verify (verify fixes) failed: pytest failed",
            result.stderr,
        )

    def test_accepts_the_stage_as_an_argument_when_no_marker_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            tools_path = self.extract_tools(work, tmp)

            result = subprocess.run(
                [sys.executable, str(tools_path), "fail", "publish (publish)"],
                input="push_stale",
                capture_output=True,
                text=True,
                cwd=work,
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn(
            "security-remediation: publish (publish) failed: push_stale",
            result.stderr,
        )

    def test_missing_stage_and_detail_names_the_setup_case(self):
        with tempfile.TemporaryDirectory() as tmp:
            work = make_repo(tmp)
            tools_path = self.extract_tools(work, tmp)

            result = subprocess.run(
                [sys.executable, str(tools_path), "fail"],
                input="",
                capture_output=True,
                text=True,
                cwd=work,
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn("did not report itself", result.stderr)
        self.assertIn(".git/security-remediation-state.json", result.stderr)


if __name__ == "__main__":
    unittest.main()
