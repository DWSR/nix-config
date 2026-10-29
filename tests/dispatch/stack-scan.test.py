import pathlib
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/dispatch/workflow.toml"
MARKER = "cat > .git/dispatch-stack-scan.py <<'DISPATCH_STACK_SCAN_PY'\n"


def load_stack_scan() -> dict[str, Any]:
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nDISPATCH_STACK_SCAN_PY", 1)[0]
    namespace: dict[str, Any] = {"__name__": "dispatch_stack_scan_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


class KiroSpecStackScanTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
