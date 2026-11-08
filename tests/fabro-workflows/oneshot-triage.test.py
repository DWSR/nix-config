import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOLS_PATH = ROOT / ".fabro" / "workflows" / "oneshot" / "scripts" / "tools.py"
FIXTURES_PATH = ROOT / "tests" / "fabro-workflows" / "fixtures" / "oneshot-triage-issues.json"
GRAPH_PATH = ROOT / ".fabro" / "workflows" / "oneshot" / "workflow.fabro"
PROMPT_PATH = ROOT / ".fabro" / "workflows" / "oneshot" / "prompts" / "implement.md"

spec = importlib.util.spec_from_file_location("oneshot_tools", TOOLS_PATH)
tools = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tools)


class OneshotTriageTests(unittest.TestCase):
    def test_issue_fixtures_classify_triage_and_standard_modes(self):
        fixtures = json.loads(FIXTURES_PATH.read_text())
        for fixture in fixtures:
            with self.subTest(fixture=fixture["name"]):
                self.assertEqual(
                    tools.classify_issue(
                        {"title": fixture["title"], "body": fixture["body"]},
                        set(fixture["labels"]),
                    ),
                    fixture["mode"],
                )

    def test_triage_detection_is_case_insensitive_and_marker_specific(self):
        self.assertEqual(
            tools.classify_issue({"title": "[FABRO-FAILURE-TRIAGE] case"}, set()), "triage"
        )
        self.assertEqual(
            tools.classify_issue({"body": "<!-- fabro-failure-triage-update:abc -->"}, set()),
            "standard",
        )
        self.assertEqual(tools.classify_issue({"body": "<!-- fabro-failure-triage:"}, set()), "triage")

    def test_prepare_persists_and_emits_issue_mode(self):
        fixture = json.loads(FIXTURES_PATH.read_text())[0]
        issue = {
            "number": 377,
            "title": fixture["title"],
            "body": fixture["body"],
            "labels": [{"name": label} for label in fixture["labels"]],
            "state": "open",
            "html_url": "https://example.test/issues/377",
        }
        fingerprint = tools.issue_fingerprint(issue["title"], issue["body"])
        api_calls = []

        def fake_run(command, check=True, env=None):
            if command == ["git", "symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"]:
                return "origin/main"
            if command == ["git", "rev-parse", "HEAD"]:
                return "baseline"
            return ""

        def fake_gh(method, path, body=None, expect=(200, 201, 204)):
            api_calls.append((method, path, body))
            return 200, issue

        with tempfile.TemporaryDirectory() as tmp:
            state_path = pathlib.Path(tmp) / "state.json"
            issue_path = pathlib.Path(tmp) / "issue.md"
            output = io.StringIO()
            with (mock.patch.object(tools, "STATE_PATH", str(state_path)),
                  mock.patch.object(tools, "ISSUE_PATH", str(issue_path)),
                  mock.patch.object(tools, "origin_repo", return_value=("owner", "repo")),
                  mock.patch.object(tools, "load_meta", return_value=({"fingerprint": fingerprint}, "meta-sha")),
                  mock.patch.object(tools, "run", side_effect=fake_run),
                  mock.patch.object(tools, "gh", side_effect=fake_gh),
                  contextlib.redirect_stdout(output)):
                tools.prepare(["377"])

            self.assertEqual(json.loads(state_path.read_text())["issue_mode"], "triage")
            self.assertEqual(json.loads(output.getvalue())["context_updates"]["issue_mode"], "triage")

    def test_blocked_triage_routes_to_recovery_or_salvage_and_other_blocked_issues_fail(self):
        graph = GRAPH_PATH.read_text()
        self.assertIn(
            'implement -> triage_recover [condition="outcome=failed && context.impl_status=BLOCKED && context.issue_mode=triage"]',
            graph,
        )
        self.assertIn(
            'triage_recover -> check [condition="outcome=succeeded && context.impl_status=READY"]',
            graph,
        )
        self.assertIn(
            'triage_recover -> salvage [condition="outcome=failed && context.impl_status=BLOCKED"]',
            graph,
        )
        self.assertLess(graph.index("implement -> triage_recover"), graph.index("implement -> fail"))
        self.assertLess(graph.index("triage_recover -> salvage"), graph.index("triage_recover -> fail"))
        self.assertLess(graph.index("implement -> triage_recover"), graph.index("implement -> fail"))
        self.assertLess(graph.index("triage_recover -> salvage"), graph.index("triage_recover -> fail"))
        self.assertIn(
            'review -> salvage [condition="outcome=failed && context.failure_class contains network && context.issue_mode=triage"]',
            graph,
        )
        self.assertIn(
            'review -> fail [condition="outcome=failed && context.failure_class contains network && context.issue_mode!=triage"]',
            graph,
        )
        self.assertIn(
            'review -> salvage [condition="outcome=failed && context.verdict=BLOCKED && context.issue_mode=triage"]',
            graph,
        )
        self.assertIn(
            'review -> fail [condition="outcome=failed && context.failure_class contains network && context.issue_mode!=triage"]',
            graph,
        )
        self.assertIn(
            'review -> fail [condition="outcome=failed && context.verdict=BLOCKED && context.issue_mode!=triage"]',
            graph,
        )
        self.assertIn('script="python3 .git/oneshot-scripts/tools.py publish salvage"', graph)
        self.assertIn(
            'salvage -> salvage_publish [condition="outcome=succeeded"]', graph
        )
        salvage_prompt = (ROOT / ".fabro/workflows/oneshot/prompts/salvage.md").read_text()
        self.assertIn("no safe mitigation", salvage_prompt)
        self.assertIn("mitigation", (ROOT / ".fabro/workflows/oneshot/prompts/triage-recover.md").read_text())

    def test_triage_prompt_requires_run_investigation_and_findings(self):
        prompt = PROMPT_PATH.read_text()
        for requirement in (
            "investigate",
            "cited run and evidence link",
            "narrowest safe change",
            "Findings",
            "Remaining external work",
            "Triage BLOCKED outcomes route through a recovery stage",
            "Return BLOCKED only if",
        ):
            with self.subTest(requirement=requirement):
                self.assertIn(requirement, prompt)

    def test_triage_publish_summary_requires_findings_and_external_work(self):
        self.assertTrue(tools.triage_summary_complete(
            "## Findings\nInvestigated run.\n## Remaining external work\nCancel job."
        ))
        self.assertTrue(tools.triage_summary_complete(
            "Findings\nInvestigated run.\nRemaining external work\nNone identified."
        ))
        self.assertFalse(tools.triage_summary_complete("## Findings\nNo external work."))
        self.assertFalse(tools.triage_summary_complete("No sections."))
        self.assertFalse(tools.triage_summary_complete("Findings and remaining external work are vague prose."))

    def test_triage_salvage_refuses_to_publish_without_an_in_repo_change(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = pathlib.Path(tmp) / "state.json"
            state_path.write_text(json.dumps({
                "issue": 377,
                "issue_mode": "triage",
                "baseline_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "trunk": "main",
            }))
            with (mock.patch.object(tools, "STATE_PATH", str(state_path)),
                  mock.patch.object(tools, "load_publish_meta", return_value=(
                      "fix(oneshot): mitigation", "## Findings\nEvidence.\n## Remaining external work\nNone."
                  )),
                  mock.patch.object(tools, "origin_repo", return_value=("owner", "repo")),
                  mock.patch.object(tools, "run", return_value=""),
                  mock.patch.object(tools, "gh") as gh):
                with self.assertRaisesRegex(SystemExit, "requires an in-repo mitigation"):
                    tools.publish(["salvage"])
            gh.assert_not_called()

    def test_triage_salvage_creates_draft_with_closing_issue_and_metadata(self):
        with tempfile.TemporaryDirectory() as tmp:
            state_path = pathlib.Path(tmp) / "state.json"
            state_path.write_text(json.dumps({
                "issue": 377,
                "issue_mode": "triage",
                "baseline_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "trunk": "main",
            }))
            summary = "## Findings\nRun evidence checked.\n## Remaining external work\nCancel the run."
            api_calls = []

            def fake_run(command, check=True, env=None):
                if command == ["git", "diff", "--cached", "--numstat", "a" * 40]:
                    return "1\t0\tmitigation.py"
                if command == ["git", "rev-parse", "FETCH_HEAD"]:
                    return "trunk-sha"
                if command == ["git", "write-tree"]:
                    return "tree"
                if command[:3] == ["git", "config", "user.name"] or command[:3] == ["git", "config", "user.email"]:
                    return "Fabro"
                if command[:3] == ["git", "commit-tree", "tree"]:
                    return "commit"
                if command[:2] == ["git", "config"]:
                    return "Fabro"
                return ""

            def fake_gh(method, path, body=None, expect=(200, 201, 204)):
                api_calls.append((method, path, body))
                if path.startswith("/repos/owner/repo/pulls?"):
                    return 200, []
                if path == "/repos/owner/repo/pulls":
                    return 201, {"number": 9, "html_url": "https://example.test/pr/9", "draft": False}
                if method == "PATCH" and path == "/repos/owner/repo/pulls/9":
                    self.assertIn("Closes #377", body["body"])
                    return 200, {"number": 9, "html_url": "https://example.test/pr/9", "draft": None, "node_id": "node-9"}
                if method == "POST" and path == "/graphql":
                    return 200, {"data": {"convertPullRequestToDraft": {"pullRequest": {"isDraft": True}}}}
                raise AssertionError("unexpected GitHub call: %s %s" % (method, path))

            with (mock.patch.object(tools, "STATE_PATH", str(state_path)),
                  mock.patch.object(tools, "PUBLISH_PATH", str(pathlib.Path(tmp) / "publish.json")),
                  mock.patch.object(tools, "load_publish_meta", return_value=("fix(oneshot): mitigate run", summary)),
                  mock.patch.object(tools, "origin_repo", return_value=("owner", "repo")),
                  mock.patch.object(tools, "run", side_effect=fake_run),
                  mock.patch.object(tools, "gh", side_effect=fake_gh),
                  mock.patch.object(tools.subprocess, "run", return_value=mock.Mock(returncode=1)),
                  contextlib.redirect_stdout(io.StringIO())):
                tools.publish(["salvage"])

            create = next(call for call in api_calls if call[1] == "/repos/owner/repo/pulls")
            self.assertTrue(create[2]["draft"])
            self.assertEqual(create[2]["draft"], True)
            patch = next(call for call in api_calls if call[0] == "PATCH")
            self.assertIn("Closes #377", patch[2]["body"])
            self.assertIn("## Findings", patch[2]["body"])
            self.assertIn("## Remaining external work", patch[2]["body"])
            graphql = next(call for call in api_calls if call[1] == "/graphql")
            self.assertEqual(graphql[2]["variables"], {"id": "node-9"})
            self.assertIn("convertPullRequestToDraft", graphql[2]["query"])


if __name__ == "__main__":
    unittest.main()
