import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
DISPATCH = ROOT / ".fabro/workflows/dispatch/workflow.fabro"
TEST_PROMPT = ROOT / ".fabro/workflows/dependabot/prompts/test.md"
FIX_PROMPT = ROOT / ".fabro/workflows/dependabot/prompts/fix.md"


def load_scripts():
    """Return the decoded contents of every script="..." attribute in the graph."""
    text = DISPATCH.read_text()
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


class FakeResponse:
    def __init__(self, payload):
        self.status = 200
        self._raw = json.dumps(payload).encode()

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


class DependabotDispatchTests(unittest.TestCase):
    def test_dependabot_rule_claims_the_pull_request_before_creating_the_child(self):
        text = DISPATCH.read_text()
        match = re.search(r"DEPENDABOT_RULE = \{(?P<body>.*?)\n\}", text, re.S)
        self.assertIsNotNone(match, "workflow.fabro must define DEPENDABOT_RULE")
        body = match.group("body")
        self.assertIn(r"\"workflow\": \"dependabot\"", body)
        # The dispatcher, not the child, marks the PR running. A second dispatch
        # scan then skips it instead of creating a duplicate child run.
        self.assertIn(r"\"label_swap\": \"dispatcher\"", body)

    def test_dispatch_marks_the_pull_request_running_without_touching_ready(self):
        script = next(
            source for source in load_scripts() if "def active_dependabot_run" in source
        )
        script = re.sub(r"\{\{.*?\}\}", '"fabro-running"', script)
        requests = []

        def urlopen(request, timeout=None):
            body = json.loads(request.data) if request.data else None
            url = request.full_url
            requests.append((request.get_method(), url, body))
            if "/runs?" in url:
                return FakeResponse({"data": []})
            if url.endswith("/runs"):
                return FakeResponse({"id": "01CHILD"})
            if url.endswith("/start"):
                return FakeResponse({})
            if "/labels" in url:
                return FakeResponse({"labels": []})
            raise AssertionError("unexpected request: %s %s" % (request.get_method(), url))

        plan = {
            "repo": "DWSR/nix-config",
            "default_branch": "main",
            "entries": [
                {
                    "kind": "pr",
                    "number": 99,
                    "workflow": "dependabot",
                    "workflow_version_id": "version",
                    "input_key": "pr",
                    "label_swap": "dispatcher",
                    "ci_failures": "[]",
                    "reason": "ci_failure",
                }
            ],
            "skipped": [],
        }
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, ".git").mkdir()
            pathlib.Path(tmp, ".git/dispatch-plan.json").write_text(json.dumps(plan))
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
                ), mock.patch("urllib.request.urlopen", urlopen):
                    exec(compile(script, "dispatch", "exec"), {"__name__": "__main__"})
            finally:
                os.chdir(previous)

        label_calls = [
            (method, url, body)
            for method, url, body in requests
            if "/repos/DWSR/nix-config/issues/99/labels" in url
        ]
        self.assertEqual(
            label_calls,
            [("POST", "http://github.invalid/repos/DWSR/nix-config/issues/99/labels", {"labels": ["fabro-running"]})],
        )
        self.assertFalse([request for request in requests if request[0] == "DELETE"])


class DependabotTestGateTests(unittest.TestCase):
    def test_test_prompt_excludes_darwin_only_checks(self):
        text = TEST_PROMPT.read_text()
        for needle in (
            "nix flake check --all-systems",
            "devShells.aarch64-linux",
            "platform mismatch",
            "Required system: 'aarch64-darwin'",
            "tests/lima-vm/",
            "tests/hammerspoon-",
        ):
            self.assertIn(needle, text)
        self.assertIn("excluded: <command> (<environment cause>)", text)
        self.assertIn("report `tests_passed=true`", text)

    def test_fix_prompt_does_not_treat_environmental_failures_as_regressions(self):
        text = FIX_PROMPT.read_text()
        self.assertIn("platform mismatch", text)
        self.assertIn("aarch64-darwin", text)
        self.assertIn("fix_status=READY", text)


if __name__ == "__main__":
    unittest.main()
