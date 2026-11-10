import contextlib
import io
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLS = ROOT / ".fabro/workflows/oneshot/scripts/tools.py"
STATE_PATH = ".git/oneshot-state.json"


def load_tools():
    namespace = {"__name__": "oneshot_salvage_test"}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    namespace["origin_repo"] = lambda: ("example", "project")
    return namespace


def git(cwd, *args):
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if result.returncode:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


def make_repo(tmp):
    origin = pathlib.Path(tmp, "origin.git")
    work = pathlib.Path(tmp, "work")
    subprocess.run(["git", "init", "--bare", "-b", "main", str(origin)], check=True, capture_output=True)
    subprocess.run(["git", "init", "-b", "main", str(work)], check=True, capture_output=True)
    git(work, "config", "user.email", "test@example.test")
    git(work, "config", "user.name", "Test")
    (work / "fixture.txt").write_text("baseline\n")
    git(work, "add", "fixture.txt")
    git(work, "commit", "-m", "baseline")
    git(work, "remote", "add", "origin", str(origin))
    git(work, "push", "origin", "main")
    baseline = git(work, "rev-parse", "HEAD")
    (work / STATE_PATH).write_text(json.dumps({
        "issue": 372,
        "trunk": "main",
        "baseline_sha": baseline,
    }))
    return work, origin


class FakeResponse:
    def __init__(self, payload, status=200):
        self.payload = json.dumps(payload).encode()
        self.status = status

    def read(self):
        return self.payload

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


class FakeGitHub:
    def __init__(self, open_prs=None):
        self.open_prs = list(open_prs or [])
        self.requests = []

    def __call__(self, request, data=None, timeout=None):
        method = request.get_method()
        path = request.full_url.split(".com", 1)[-1]
        body = json.loads(data) if data else None
        self.requests.append((method, path, body))
        if path.startswith("/repos/example/project/pulls?"):
            return FakeResponse(self.open_prs)
        if path == "/repos/example/project/pulls" and method == "POST":
            created = {"number": 17, "node_id": "PR_node", "html_url": "https://github.com/example/project/pull/17",
                       "draft": body["draft"]}
            self.open_prs = [created]
            return FakeResponse(created, status=201)
        if path == "/repos/example/project/pulls/17" and method == "PATCH":
            self.open_prs[0].update(body)
            return FakeResponse(self.open_prs[0])
        if path == "/graphql":
            mutation = "convertPullRequestToDraft" if "convertPullRequestToDraft" in body["query"] else "convertPullRequestToReadyForReview"
            draft = mutation == "convertPullRequestToDraft"
            self.open_prs[0]["draft"] = draft
            return FakeResponse({"data": {mutation: {"pullRequest": {"isDraft": draft}}}})
        raise AssertionError("unexpected GitHub request: %s %s" % (method, path))


def run_publish(work, github, reason, draft=True):
    output = io.StringIO()
    namespace = load_tools()
    args = ["tools.py", "publish"] + (["--draft"] if draft else [])
    previous = os.getcwd()
    os.chdir(work)
    try:
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "test-token"}), \
                mock.patch.object(urllib.request, "urlopen", github), \
                mock.patch.object(sys, "argv", args), \
                mock.patch.object(sys, "stdin", io.StringIO(reason)), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            namespace["main"]()
    finally:
        os.chdir(previous)
    return json.loads(output.getvalue().strip().splitlines()[-1])["context_updates"]


class OneshotSalvageTests(unittest.TestCase):
    def test_creates_draft_pr_with_blocker_and_issue_closure(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, origin = make_repo(tmp)
            (work / "fixture.txt").write_text("salvaged implementation\n")
            github = FakeGitHub()

            context = run_publish(work, github, "Review blocked: network unavailable.")

            self.assertEqual(context["pr_number"], "17")
            create = next(req[2] for req in github.requests if req[:2] == ("POST", "/repos/example/project/pulls"))
            self.assertTrue(create["draft"])
            self.assertIn("Review blocked: network unavailable.", create["body"])
            self.assertIn("Closes #372", create["body"])
            self.assertIn("refs/heads/oneshot/issue-372", git(origin, "for-each-ref", "--format=%(refname)", "refs/heads"))

    def test_updates_existing_open_pr_and_converts_it_to_draft(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            (work / "fixture.txt").write_text("salvaged implementation\n")
            github = FakeGitHub([{
                "number": 17,
                "node_id": "PR_node",
                "html_url": "https://github.com/example/project/pull/17",
                "draft": False,
                "title": "old title",
                "body": "old body",
            }])

            run_publish(work, github, "Review findings: baseline check unavailable.")

            self.assertEqual(sum(req[0] == "POST" and req[1] == "/repos/example/project/pulls" for req in github.requests), 0)
            update = next(req[2] for req in github.requests if req[:2] == ("PATCH", "/repos/example/project/pulls/17"))
            self.assertIn("Review findings: baseline check unavailable.", update["body"])
            self.assertIn("Closes #372", update["body"])
            self.assertTrue(github.open_prs[0]["draft"])
            self.assertTrue(any(req[1] == "/graphql" for req in github.requests))

    def test_existing_draft_pr_is_promoted_for_approved_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            (work / "fixture.txt").write_text("approved implementation\\n")
            github = FakeGitHub([{
                "number": 17,
                "node_id": "PR_node",
                "html_url": "https://github.com/example/project/pull/17",
                "draft": True,
            }])

            run_publish(work, github, "", draft=False)

            self.assertFalse(github.open_prs[0]["draft"])
            self.assertTrue(any("convertPullRequestToReadyForReview" in req[2]["query"]
                                for req in github.requests if req[1] == "/graphql"))

    def test_empty_diff_fails_with_blocker_without_github_publish(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            github = FakeGitHub()
            namespace = load_tools()
            previous = os.getcwd()
            os.chdir(work)
            try:
                with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "test-token"}), \
                        mock.patch.object(sys, "stdin", io.StringIO("review service unavailable")), \
                        contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as caught:
                        namespace["publish"](["--draft"])
            finally:
                os.chdir(previous)

            self.assertIn("no changes relative to baseline", str(caught.exception))
            self.assertIn("review service unavailable", str(caught.exception))
            self.assertEqual(github.requests, [])

    def test_missing_salvage_reason_fails_before_publishing(self):
        with tempfile.TemporaryDirectory() as tmp:
            work, _origin = make_repo(tmp)
            (work / "fixture.txt").write_text("salvaged implementation\n")
            namespace = load_tools()
            previous = os.getcwd()
            os.chdir(work)
            try:
                with mock.patch.object(sys, "stdin", io.StringIO("\n")):
                    with self.assertRaises(SystemExit) as caught:
                        namespace["publish"](["--draft"])
            finally:
                os.chdir(previous)

            self.assertIn("requires a concrete failure reason", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
