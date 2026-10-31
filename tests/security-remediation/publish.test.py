import contextlib
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
PUBLISH_PATH = ".git/security-remediation-publish.json"
TRUNK = "main"
BRANCH = "security/dependabot-12"


def load_tools():
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nSECURITY_REMEDIATION_TOOLS_PY", 1)[0]
    namespace = {"__name__": "security_remediation_publish_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


def git(cwd, *args, check=True):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if check and result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def make_repo(tmp):
    origin = pathlib.Path(tmp, "origin.git")
    work = pathlib.Path(tmp, "work")
    subprocess.run(["git", "init", "--bare", "-b", TRUNK, str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", TRUNK, str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "test@example.test")
    git(work, "config", "user.name", "Test")
    (work / "flake.nix").write_text("{}\n")
    (work / "package-lock.json").write_text('{"lodash": "4.17.20"}\n')
    (work / "README.md").write_text("readme\n")
    git(work, "add", "-A")
    git(work, "commit", "-m", "init")
    git(work, "remote", "add", "origin", str(origin))
    git(work, "push", "origin", TRUNK)
    return work, origin


def write_state(work, **overrides):
    state = {
        "finding": "dependabot:12",
        "source": "dependabot",
        "alert_number": 12,
        "title": "Prototype pollution in lodash",
        "url": "https://github.com/DWSR/nix-config/security/dependabot/12",
        "repo": "DWSR/nix-config",
        "trunk": TRUNK,
        "branch": BRANCH,
        "baseline_sha": git(work, "rev-parse", "origin/%s" % TRUNK),
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


def commit_onto_origin(tmp, origin, files, message="trunk moved"):
    other = pathlib.Path(tmp, "other")
    subprocess.run(["git", "clone", str(origin), str(other)], check=True, capture_output=True)
    git(other, "config", "user.email", "test@example.test")
    git(other, "config", "user.name", "Test")
    for name, text in files.items():
        (other / name).write_text(text)
    git(other, "add", "-A")
    git(other, "commit", "-m", message)
    git(other, "push", "origin", TRUNK)
    return git(other, "rev-parse", "HEAD")


def run_publish(work):
    output = io.StringIO()
    previous = os.getcwd()
    os.chdir(work)
    try:
        with mock.patch.object(sys, "argv", ["tools.py", "publish"]), \
                contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(io.StringIO()):
            load_tools()["main"]()
    finally:
        os.chdir(previous)
    return json.loads(output.getvalue().strip().splitlines()[-1])["context_updates"]


def run_publish_error(testcase, work):
    with testcase.assertRaises(SystemExit) as caught:
        run_publish(work)
    return str(caught.exception.code)


def read_state(work):
    return json.loads((work / STATE_PATH).read_text())


class PublishCommitTests(unittest.TestCase):
    def test_creates_exactly_one_commit_parented_on_the_fetched_trunk_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            context = run_publish(work)

            base = git(work, "rev-parse", "origin/%s" % TRUNK)
            head = context["commit_sha"]
            self.assertEqual(git(work, "rev-parse", "%s^" % head), base)
            self.assertEqual(git(work, "rev-list", "--count", head, "^%s" % base), "1")
            self.assertEqual(git(work, "rev-parse", "%s^{tree}" % head),
                             git(work, "write-tree"))
            self.assertIn("4.17.21", git(work, "show", "%s:package-lock.json" % head))

    def test_uses_the_documented_fallback_title_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            head = run_publish(work)["commit_sha"]

            self.assertEqual(
                git(work, "show", "-s", "--format=%s", head),
                "fix(security): remediate dependabot alert #12",
            )
            self.assertEqual(
                git(work, "show", "-s", "--format=%b", head).strip(),
                "Remediates dependabot alert #12.",
            )

    def test_prefers_a_valid_publish_meta_title_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / PUBLISH_PATH).write_text(json.dumps({
                "title": "chore(deps): bump lodash to 4.17.21",
                "summary": "Bumps lodash past the prototype pollution advisory.",
            }))
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            head = run_publish(work)["commit_sha"]

            self.assertEqual(
                git(work, "show", "-s", "--format=%s", head),
                "chore(deps): bump lodash to 4.17.21",
            )
            self.assertEqual(
                git(work, "show", "-s", "--format=%b", head).strip(),
                "Bumps lodash past the prototype pollution advisory.",
            )

    def test_ignores_an_invalid_publish_meta_title(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / PUBLISH_PATH).write_text(json.dumps({
                "title": "fixed the thing",
                "summary": "Bumps lodash past the prototype pollution advisory.",
            }))
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            head = run_publish(work)["commit_sha"]

            self.assertEqual(
                git(work, "show", "-s", "--format=%s", head),
                "fix(security): remediate dependabot alert #12",
            )
            self.assertEqual(
                git(work, "show", "-s", "--format=%b", head).strip(),
                "Bumps lodash past the prototype pollution advisory.",
            )


class TrunkMovedTests(unittest.TestCase):
    def test_replays_a_disjoint_fix_onto_a_moved_trunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            new_base = commit_onto_origin(tmp, origin, {"flake.nix": "{ moved = true; }\n"})

            context = run_publish(work)

            head = context["commit_sha"]
            self.assertEqual(git(work, "rev-parse", "%s^" % head), new_base)
            self.assertEqual(git(work, "rev-list", "--count", head, "^%s" % new_base), "1")
            self.assertIn("4.17.21", git(work, "show", "%s:package-lock.json" % head))
            self.assertEqual(git(work, "show", "%s:flake.nix" % head), "{ moved = true; }")

    def test_replays_a_new_fix_file_onto_a_moved_trunk(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            (work / "tests").mkdir()
            (work / "tests/lodash.test.js").write_text("test('patched')\n")
            new_base = commit_onto_origin(tmp, origin, {"flake.nix": "{ moved = true; }\n"})

            context = run_publish(work)

            head = context["commit_sha"]
            self.assertEqual(git(work, "rev-parse", "%s^" % head), new_base)
            self.assertEqual(git(work, "show", "%s:tests/lodash.test.js" % head), "test('patched')")

    def test_fails_base_moved_when_the_trunk_touched_the_fix_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            commit_onto_origin(tmp, origin, {"package-lock.json": '{"lodash": "4.17.22"}\n'})

            message = run_publish_error(self, work)

            self.assertIn("base_moved", message)
            self.assertIn("package-lock.json", message)
            self.assertNotIn("commit_sha", message)


class RejectedPayloadTests(unittest.TestCase):
    def test_an_empty_diff_fails_instead_of_publishing_an_empty_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)

            message = run_publish_error(self, work)

            self.assertIn("no change", message)
            self.assertIn("empty commit", message)

    def test_rejects_artifact_paths_and_lists_the_offenders(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            (work / "node_modules/left-pad").mkdir(parents=True)
            (work / "node_modules/left-pad/index.js").write_text("\n")
            (work / "dist").mkdir()
            (work / "dist/bundle.js").write_text("\n")

            message = run_publish_error(self, work)

            self.assertIn("artifact", message)
            self.assertIn("node_modules/left-pad/index.js", message)
            self.assertIn("dist/bundle.js", message)

    def test_rejects_a_branch_that_does_not_match_the_finding(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work, branch="security/other-99")
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            message = run_publish_error(self, work)

            self.assertIn("security/dependabot-12", message)
            self.assertIn("security/other-99", message)


if __name__ == "__main__":
    unittest.main()
