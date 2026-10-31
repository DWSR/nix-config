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
import urllib.request
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


class FakeResponse:
    def __init__(self, status, payload):
        self.status = status
        self._payload = json.dumps(payload).encode("utf-8") if payload is not None else b""

    def read(self):
        return self._payload

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeHTTP:
    def __init__(self, open_prs=None, create_status=201, create_body=None, create_error=None):
        self.open_prs = list(open_prs or [])
        self.create_status = create_status
        self.create_body = create_body or {
            "number": 34,
            "html_url": "https://github.com/DWSR/nix-config/pull/34",
        }
        self.create_error = create_error
        self.requests = []

    def __call__(self, request, data=None, timeout=None):
        method = request.get_method()
        self.requests.append({
            "method": method,
            "url": request.full_url,
            "body": json.loads(data) if data else None,
        })
        if method == "GET":
            return FakeResponse(200, self.open_prs)
        if self.create_error is not None:
            raise self.create_error
        return FakeResponse(self.create_status, self.create_body)


def run_publish(work, http=None):
    http = http or FakeHTTP()
    output = io.StringIO()
    previous = os.getcwd()
    os.chdir(work)
    try:
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "test-token"}), \
                mock.patch.object(urllib.request, "urlopen", http), \
                mock.patch.object(sys, "argv", ["tools.py", "publish"]), \
                contextlib.redirect_stdout(output), \
                contextlib.redirect_stderr(io.StringIO()):
            load_tools()["main"]()
    finally:
        os.chdir(previous)
    return json.loads(output.getvalue().strip().splitlines()[-1])["context_updates"]


def run_publish_error(testcase, work, http=None):
    with testcase.assertRaises(SystemExit) as caught:
        run_publish(work, http)
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


def push_branch(tmp, origin, branch, content):
    other = pathlib.Path(tmp, "branch-work")
    if not other.exists():
        subprocess.run(["git", "clone", str(origin), str(other)], check=True, capture_output=True)
        git(other, "config", "user.email", "test@example.test")
        git(other, "config", "user.name", "Test")
    git(other, "checkout", "-B", branch)
    (other / "branch.txt").write_text(content)
    git(other, "add", "-A")
    git(other, "commit", "-m", "remote work on %s" % branch)
    git(other, "push", "origin", branch)
    return git(other, "rev-parse", "HEAD")


def posts(http):
    return [request for request in http.requests if request["method"] == "POST"]


class PushTests(unittest.TestCase):
    def test_pushes_the_commit_and_records_the_remote_head(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            context = run_publish(work)

            head = context["commit_sha"]
            self.assertEqual(git(origin, "rev-parse", "refs/heads/%s" % BRANCH), head)
            state = read_state(work)
            self.assertEqual(state["remote_branch_sha"], head)
            self.assertEqual(state["published"]["commit"], head)
            self.assertEqual(state["published"]["pr"], 34)

    def test_updates_an_existing_remote_branch_with_force_with_lease(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            existing = push_branch(tmp, origin, BRANCH, "first attempt\n")
            write_state(work, remote_branch_sha=existing)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            context = run_publish(work)

            head = context["commit_sha"]
            self.assertNotEqual(head, existing)
            self.assertEqual(git(origin, "rev-parse", "refs/heads/%s" % BRANCH), head)
            self.assertEqual(read_state(work)["remote_branch_sha"], head)

    def test_fails_push_stale_when_the_remote_head_moved(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            intake = push_branch(tmp, origin, BRANCH, "intake\n")
            moved = push_branch(tmp, origin, BRANCH, "someone else\n")
            write_state(work, remote_branch_sha=intake)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            message = run_publish_error(self, work)

            self.assertIn("push_stale", message)
            self.assertIn(BRANCH, message)
            self.assertNotIn("commit_sha", message)
            self.assertEqual(git(origin, "rev-parse", "refs/heads/%s" % BRANCH), moved)

    def test_fails_push_stale_when_the_branch_appeared_after_intake(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            appeared = push_branch(tmp, origin, BRANCH, "created by another actor\n")
            write_state(work, remote_branch_sha=None)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')

            message = run_publish_error(self, work)

            self.assertIn("push_stale", message)
            self.assertIn(BRANCH, message)
            self.assertEqual(git(origin, "rev-parse", "refs/heads/%s" % BRANCH), appeared)


class PullRequestTests(unittest.TestCase):
    def test_opens_a_non_draft_pull_request_that_links_the_alert(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            http = FakeHTTP()

            context = run_publish(work, http)

            created = posts(http)
            self.assertEqual(len(created), 1)
            payload = created[0]["body"]
            self.assertEqual(payload["head"], BRANCH)
            self.assertEqual(payload["base"], TRUNK)
            self.assertFalse(payload["draft"])
            self.assertEqual(payload["title"], "fix(security): remediate dependabot alert #12")
            self.assertIn(
                "Alert: https://github.com/DWSR/nix-config/security/dependabot/12 "
                "(dependabot alert #12)",
                payload["body"],
            )
            self.assertEqual(context["commit_sha"], git(origin, "rev-parse", "refs/heads/%s" % BRANCH))
            self.assertEqual(context["pr_number"], "34")
            self.assertEqual(context["pr_url"], "https://github.com/DWSR/nix-config/pull/34")
            self.assertNotIn("clos", json.dumps(context).lower())

    def test_reuses_the_single_open_pull_request_on_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            http = FakeHTTP()

            first = run_publish(work, http)
            http.open_prs.append(http.create_body)
            second = run_publish(work, http)

            self.assertEqual(len(posts(http)), 1)
            self.assertEqual(second["pr_number"], first["pr_number"])
            self.assertEqual(second["pr_url"], first["pr_url"])

    def test_reuses_an_existing_open_pull_request_without_creating_another(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            http = FakeHTTP(open_prs=[{
                "number": 7,
                "html_url": "https://github.com/DWSR/nix-config/pull/7",
            }])

            context = run_publish(work, http)

            self.assertEqual(posts(http), [])
            self.assertEqual(context["pr_number"], "7")
            self.assertEqual(context["pr_url"], "https://github.com/DWSR/nix-config/pull/7")

    def test_fails_when_several_open_pull_requests_match(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            http = FakeHTTP(open_prs=[
                {"number": 7, "html_url": "https://github.com/DWSR/nix-config/pull/7"},
                {"number": 8, "html_url": "https://github.com/DWSR/nix-config/pull/8"},
            ])

            message = run_publish_error(self, work, http)

            self.assertIn("multiple open pull requests", message)
            self.assertEqual(posts(http), [])

    def test_fails_with_the_api_error_on_422_when_no_open_pull_request_exists(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            body = io.BytesIO(json.dumps({
                "message": "Validation Failed",
                "errors": [{"resource": "PullRequest", "code": "custom"}],
            }).encode("utf-8"))
            error = urllib.error.HTTPError(
                "https://api.github.com/repos/DWSR/nix-config/pulls",
                422,
                "Unprocessable Entity",
                {},
                body,
            )
            http = FakeHTTP(create_error=error)

            message = run_publish_error(self, work, http)

            self.assertIn("422", message)
            self.assertIn("Validation Failed", message)
            self.assertEqual(len(posts(http)), 1)

    def test_never_writes_to_alert_endpoints_or_merges(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            write_state(work)
            (work / "package-lock.json").write_text('{"lodash": "4.17.21"}\n')
            http = FakeHTTP()

            run_publish(work, http)

            for request in http.requests:
                self.assertIn("/pulls", request["url"])
                self.assertNotIn("/alerts", request["url"])
                self.assertNotIn("/merge", request["url"])
                if request["body"]:
                    self.assertNotIn("auto_merge", request["body"])


if __name__ == "__main__":
    unittest.main()
