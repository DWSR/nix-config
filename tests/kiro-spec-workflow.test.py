import contextlib
import io
import json
import os
import pathlib
import tempfile
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".fabro/workflows/kiro-spec/workflow.toml"
PROMPTS = ROOT / ".fabro/workflows/kiro-spec/prompts"
RULE = ROOT / ".kiro/settings/rules/secret-material-handling.md"
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


class PrepareRoutingTests(unittest.TestCase):
    def run_prepare(self, feedback_by_doc):
        tools = load_workflow_tools()
        stack = "\n".join(
            "%040d\trefs/heads/stack/example/%d-%s" % (index, index, doc)
            for index, doc in enumerate(("brief", "requirements", "design", "tasks"), start=1)
        )
        issue = {
            "title": "Install Rex",
            "body": "Body",
            "state": "open",
            "html_url": "https://github.com/owner/repo/issues/130",
            "labels": [{"name": "type/kiro-spec"}],
        }

        def fake_run(cmd, check=True, env=None):
            if cmd[:3] == ["git", "ls-remote", "--heads"]:
                return stack
            return ""

        tools["run"] = fake_run
        tools["origin_repo"] = lambda: ("owner", "repo")
        tools["detect_trunk"] = lambda: "main"
        tools["gh"] = lambda method, path, body=None: (200, issue)
        tools["scan_stack_feedback"] = lambda owner, repo, spec, layers: feedback_by_doc
        fingerprint = tools["issue_fingerprint"]("Install Rex", "Body")
        tools["load_meta"] = lambda spec: (
            {"fingerprint": fingerprint, "recorded_at": "2026-10-30T00:00:00Z"},
            "sha",
        )
        tools["save_state"] = lambda state: None

        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            os.makedirs(os.path.join(tmp, ".kiro"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(io.StringIO()):
                    tools["prepare"](["130", "example"])
            finally:
                os.chdir(previous)

        return json.loads(stdout.getvalue().strip().splitlines()[-1])["context_updates"]

    def test_rerun_routes_to_document_with_feedback(self):
        updates = self.run_prepare(
            {"brief": {"pr": 166, "comments": [{"body": "Revise the scope."}]}}
        )

        self.assertEqual(updates["next_doc"], "brief")
        self.assertEqual(updates["rerun_doc"], "brief")

    def test_rerun_routes_to_publish_when_no_feedback(self):
        updates = self.run_prepare({})

        self.assertEqual(updates["next_doc"], "publish")
        self.assertEqual(updates["rerun_doc"], "")


class KiroSpecSecretMaterialTests(unittest.TestCase):
    def prompt(self, name):
        return " ".join((PROMPTS / name).read_text().split())

    def test_requirements_prompt_reads_the_rule(self):
        text = self.prompt("requirements.md")
        self.assertIn(".kiro/settings/rules/secret-material-handling.md", text)
        self.assertIn("classify every secret surface as wiring, verification", text)
        self.assertIn("Acceptance criteria state observable outcomes", text)
        self.assertIn(
            "do not require the implementer to mint, generate, rotate, or read a secret",
            text,
        )

    def test_design_prompt_requires_operator_provisioning(self):
        text = self.prompt("design.md")
        self.assertIn(".kiro/settings/rules/secret-material-handling.md", text)
        self.assertIn("`## Operator Provisioning`", text)
        self.assertIn("exact provisioning command", text)
        self.assertIn("the verification command, and the owner", text)
        self.assertIn("operator owns provisioning", text)

    def test_tasks_prompt_forbids_provisioning_only_tasks(self):
        text = self.prompt("tasks.md")
        self.assertIn(".kiro/settings/rules/secret-material-handling.md", text)
        self.assertIn("Never write a provisioning-only task", text)
        self.assertIn("`## Operator Provisioning`", text)
        self.assertIn("secret-independent deliverable", text)
        self.assertIn("satisfiable without a secret value", text)

    def test_rule_exists_for_the_spec_prompts_to_reference(self):
        self.assertTrue(RULE.is_file())
        self.assertIn("## Operator Provisioning", RULE.read_text())


if __name__ == "__main__":
    unittest.main()
