import contextlib
import io
import json
import os
import pathlib
import tempfile
import unittest
from typing import Any
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/dispatch/workflow.toml"
MARKER = "cat > .git/dispatch-stack-scan.py <<'DISPATCH_STACK_SCAN_PY'\n"


def load_stack_scan() -> dict[str, Any]:
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nDISPATCH_STACK_SCAN_PY", 1)[0]
    namespace: dict[str, Any] = {"__name__": "dispatch_stack_scan_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


def run_main(scan: dict[str, Any], queue: dict[str, Any], stacks: list[dict[str, Any]]) -> dict[str, str]:
    """Run the embedded helper's main() against a temporary queue file."""
    with tempfile.TemporaryDirectory() as tmp:
        git_dir = pathlib.Path(tmp) / ".git"
        git_dir.mkdir()
        (git_dir / "dispatch-queue.json").write_text(json.dumps(queue))

        def request(_base, _method, path, _token=None):
            if "/stacks" in path:
                return stacks
            return []

        scan["request"] = request
        scan["active_kiro_issues"] = lambda _repo: set()
        output = io.StringIO()
        cwd = os.getcwd()
        os.chdir(tmp)
        try:
            with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token"}):
                with contextlib.redirect_stdout(output):
                    scan["main"]()
        finally:
            os.chdir(cwd)
        return json.loads(output.getvalue())["context_updates"]


def queue_with(**fields: Any) -> dict[str, Any]:
    queue = {"repo": "DWSR/nix-config", "issues": [], "pull_requests": [], "findings": []}
    queue.update(fields)
    return queue


class KiroSpecStackScanTests(unittest.TestCase):
    def test_review_thread_query_has_balanced_selection_sets(self):
        scan = load_stack_scan()
        captured: dict[str, str] = {}

        def capture_query(_token: str, query: str, _variables: dict[str, Any]) -> dict[str, Any]:
            captured["query"] = query
            return {
                "repository": {
                    "pullRequest": {
                        "reviewThreads": {
                            "nodes": [],
                            "pageInfo": {"hasNextPage": False},
                        }
                    }
                }
            }

        scan["graphql"] = capture_query
        self.assertFalse(scan["unresolved_threads"]("token", "owner", "repo", 17))
        self.assertEqual(captured["query"].count("{"), captured["query"].count("}"))

    def test_only_native_stack_members_with_kiro_branch_and_issue_reference_match(self):
        scan = load_stack_scan()
        pr = {
            "number": 17,
            "head": {"ref": "stack/example-spec/2-requirements"},
            "body": "Part 2/4 of the Kiro spec for issue #241.\n\nRefs #241",
        }

        self.assertEqual(scan["stack_source_issue"](pr, {17}), 241)
        self.assertIsNone(scan["stack_source_issue"](pr, set()))
        self.assertIsNone(
            scan["stack_source_issue"](
                {**pr, "head": {"ref": "dependabot/npm/bump"}}, {17}
            )
        )
        self.assertIsNone(scan["stack_source_issue"]({**pr, "body": "No issue ref"}, {17}))

    def test_feedback_detection_ignores_resolved_threads(self):
        scan = load_stack_scan()
        scan["graphql"] = lambda _token, _query, _variables: {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": [
                            {"isResolved": True, "comments": {"nodes": [{"body": "old"}]}},
                            {"isResolved": False, "comments": {"nodes": [{"body": "   "}]}},
                        ],
                        "pageInfo": {"hasNextPage": False},
                    }
                }
            }
        }

        self.assertFalse(scan["unresolved_threads"]("token", "owner", "repo", 17))

    def test_feedback_detection_accepts_unresolved_nonempty_review_threads(self):
        scan = load_stack_scan()
        scan["graphql"] = lambda _token, _query, _variables: {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": [
                            {"isResolved": False, "comments": {"nodes": [{"body": "Please revise"}]}},
                        ],
                        "pageInfo": {"hasNextPage": False},
                    }
                }
            }
        }

        self.assertTrue(scan["unresolved_threads"]("token", "owner", "repo", 17))


class StackScanFindingsVisibilityTests(unittest.TestCase):
    FINDING = {"source": "dependabot", "number": 7, "title": "Bump lodash", "url": "https://example.test/7"}
    NATIVE_STACK = [{"pull_requests": [{"number": 31}]}]

    def test_findings_only_queue_keeps_the_no_stack_path_open(self):
        updates = run_main(load_stack_scan(), queue_with(findings=[self.FINDING]), [])
        self.assertEqual(updates["has_queue"], "true")

    def test_findings_only_queue_keeps_the_native_stack_path_open(self):
        updates = run_main(load_stack_scan(), queue_with(findings=[self.FINDING]), self.NATIVE_STACK)
        self.assertEqual(updates["has_queue"], "true")

    def test_empty_queue_still_short_circuits_both_paths(self):
        self.assertEqual(run_main(load_stack_scan(), queue_with(), []), {"has_queue": "false"})
        updates = run_main(load_stack_scan(), queue_with(), self.NATIVE_STACK)
        self.assertEqual(updates["has_queue"], "false")

    def test_existing_queues_are_unaffected(self):
        issue = {"number": 4}
        pr = {"number": 9}
        self.assertEqual(run_main(load_stack_scan(), queue_with(issues=[issue]), [])["has_queue"], "true")
        self.assertEqual(run_main(load_stack_scan(), queue_with(pull_requests=[pr]), [])["has_queue"], "true")


if __name__ == "__main__":
    unittest.main()
