import pathlib
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".fabro/workflows/kiro-spec/workflow.toml"
MARKER = "cat > .git/kiro-spec-scripts/tools.py <<'KIRO_SPEC_TOOLS_PY'\n"


def load_workflow_tools():
    text = WORKFLOW.read_text()
    source = text.split(MARKER, 1)[1].split("\nKIRO_SPEC_TOOLS_PY", 1)[0]
    namespace: dict[str, Any] = {"__name__": "kiro_spec_workflow_test"}
    exec(compile(source, str(WORKFLOW), "exec"), namespace)
    return namespace


class ReviewFeedbackTests(unittest.TestCase):
    def test_scan_ignores_resolved_threads_and_uses_latest_comment(self):
        tools = load_workflow_tools()
        threads = [
            {
                "id": "resolved",
                "isResolved": True,
                "comments": {"nodes": [{"databaseId": 1, "body": "Resolved"}]},
            },
            {
                "id": "unresolved",
                "isResolved": False,
                "comments": {
                    "nodes": [
                        {"databaseId": 2, "body": "Earlier comment"},
                        {
                            "databaseId": 3,
                            "body": "Please clarify this requirement.",
                            "path": ".kiro/specs/example/requirements.md",
                            "line": 12,
                            "author": {"login": "reviewer"},
                        },
                    ]
                },
            },
        ]
        tools["graphql"] = lambda _query, _variables: {
            "repository": {
                "pullRequest": {
                    "reviewThreads": {
                        "nodes": threads,
                        "pageInfo": {"hasNextPage": False},
                    }
                }
            }
        }

        feedback = tools["review_feedback"]("owner", "repo", 42)

        self.assertEqual(len(feedback), 1)
        self.assertEqual(feedback[0]["thread_id"], "unresolved")
        self.assertEqual(feedback[0]["comment_id"], 3)
        self.assertEqual(feedback[0]["body"], "Please clarify this requirement.")

    def test_stack_scan_finds_open_pr_feedback_by_layer(self):
        tools = load_workflow_tools()
        requests = []
        tools["gh"] = lambda _method, path, _body=None: (
            requests.append(path)
            or (
                200,
                [{"number": 20}] if "head=owner%3Astack%2Fexample%2F1-brief" in path else [],
            )
        )
        tools["review_feedback"] = lambda _owner, _repo, _number: [
            {"thread_id": "thread-1", "comment_id": 99, "body": "Revise the scope."}
        ]
        layers = [
            {"doc": "brief", "branch": "stack/example/1-brief"},
            {"doc": "requirements", "branch": "stack/example/2-requirements"},
        ]

        result = tools["scan_stack_feedback"]("owner", "repo", "example", layers)

        self.assertEqual(result["brief"]["pr"], 20)
        self.assertNotIn("requirements", result)
        self.assertEqual(len(requests), 2)


if __name__ == "__main__":
    unittest.main()
