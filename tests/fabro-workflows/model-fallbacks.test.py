import pathlib
import re
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".fabro" / "workflows"
FABRO_NIX = ROOT / "configurations" / "fabro-vm" / "fabro.nix"
LITELLM_NIX = ROOT / "configurations" / "fabro-vm" / "litellm.nix"
CATALOG_NIX = ROOT / "configurations" / "fabro-vm" / "litellm-catalog.nix"
ONESHOT_GRAPH = WORKFLOW_DIR / "oneshot" / "workflow.fabro"
ONESHOT_REVIEW = WORKFLOW_DIR / "oneshot" / "prompts" / "review.md"

# Every workflow whose agent nodes can use the runner's default
# deepseek-v4.1-flash model.
AGENT_WORKFLOWS = (
    "dependabot",
    "failure-triage",
    "kiro-feedback",
    "kiro-impl",
    "kiro-spec",
    "kiro-task",
    "oneshot",
    "security-remediation",
)


def load_workflow(name):
    with (WORKFLOW_DIR / name / "workflow.toml").open("rb") as handle:
        return tomllib.load(handle)


class ModelFallbackTests(unittest.TestCase):
    def test_fabro_default_model_is_deepseek_v4_1_flash(self):
        text = FABRO_NIX.read_text()
        self.assertIn('default_model = "deepseek-v4.1-flash";', text)

        cli = text.split("cli = {", 1)[1].split("target =", 1)[0]
        self.assertIn('name = "deepseek-v4.1-flash";', cli)

        run = text.split("run = {", 1)[1].split("run_branch = {", 1)[0]
        self.assertIn('model.name = "deepseek-v4.1-flash";', run)

    def test_deepseek_default_routes_through_opencode_go(self):
        text = FABRO_NIX.read_text()
        _, _, tail = text.partition('"deepseek-v4.1-flash" = {')
        self.assertTrue(tail, "deepseek-v4.1-flash fabro model is missing")
        block = tail.split('"glm-5.3-flash" = {', 1)[0]
        self.assertIn('api_model = "opencode-go/deepseek-v4.1-flash";', block)

    def test_workflow_nodes_inherit_the_deepseek_default(self):
        for path in sorted(WORKFLOW_DIR.glob("*/workflow.fabro")):
            with self.subTest(workflow=path.parent.name):
                models = re.findall(r'\bmodel="([^"]+)"', path.read_text())
                self.assertEqual(models, [])

    def test_deepseek_falls_back_to_gpt_6_luna(self):
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertEqual(
                    model["fallbacks"]["deepseek-v4.1-flash"],
                    ["litellm:gpt-6-luna"],
                )

    def test_no_run_level_controls_are_forced_on_the_fallback(self):
        # Run-level controls also apply to the fallback model, and
        # gpt-6-luna advertises only xhigh effort, so setting max there would
        # break every failover call. DeepSeek gets its max effort and GPT-6
        # Luna its xhigh effort from their litellm deployments instead.
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertNotIn("controls", model)

    def test_deepseek_deployment_uses_the_wire_default_effort(self):
        text = CATALOG_NIX.read_text()
        _, _, tail = text.partition('"deepseek-v4.1-flash" = {')
        self.assertTrue(tail, "deepseek-v4.1-flash catalog group is missing")
        block = tail.split('"glm-5.3-flash" = {', 1)[0]
        self.assertIn("requestDefaults = { };", block)
        self.assertNotIn("reasoning_effort", block)

    def test_deepseek_model_advertises_max_effort(self):
        text = FABRO_NIX.read_text()
        _, _, tail = text.partition('"deepseek-v4.1-flash" = {')
        self.assertTrue(tail, "deepseek-v4.1-flash fabro model is missing")
        block = tail.split('"glm-5.3-flash" = {', 1)[0]
        self.assertIn("reasoning_effort = {", block)
        self.assertIn("max = true;", block)

    def test_gpt_6_luna_deployments_pin_xhigh_effort(self):
        text = CATALOG_NIX.read_text()
        _, _, tail = text.partition("gpt-6-luna = {")
        self.assertTrue(tail, "gpt-6-luna catalog group is missing")
        block = tail.split("gpt-6-luna-none = {", 1)[0]
        self.assertEqual(block.count('reasoning_effort = "xhigh";'), 2)
        self.assertIn('provider = "chatgpt";', block)
        self.assertIn('provider = "opencode-go";', block)

    def test_oneshot_routes_non_approval_paths_to_salvage(self):
        graph = ONESHOT_GRAPH.read_text()
        expected_edges = (
            'implement -> salvage [condition="outcome=failed && context.impl_status=BLOCKED"]',
            'check -> salvage [condition="outcome=succeeded && context.over_limit=true && context.can_simplify=false"]',
            'review -> salvage [condition="outcome=failed && context.failure_class contains network"]',
            'review -> salvage [condition="outcome=failed && context.failure_class contains environment"]',
            'review -> salvage [condition="outcome=failed && context.verdict=BLOCKED"]',
            'rework -> salvage [condition="outcome=succeeded && context.rework_round > 2"]',
        )

        for edge in expected_edges:
            with self.subTest(edge=edge):
                self.assertIn(edge, graph)
        self.assertIn('stdin_source="stage_failure"', graph)
        self.assertIn('script="python3 .git/oneshot-scripts/tools.py publish --draft"', graph)
        self.assertIn("salvage -> exit", graph)

    def test_oneshot_salvage_publish_has_draft_idempotent_and_empty_diff_guards(self):
        tools = (WORKFLOW_DIR / "oneshot" / "scripts" / "tools.py").read_text()

        self.assertIn('if argv[i] == "--draft":', tools)
        self.assertIn('"draft": draft', tools)
        self.assertIn('gh("PATCH", "/repos/%s/pulls/%s"', tools)
        self.assertIn('body += "\\n\\nCloses #%d\\n" % issue_number', tools)
        self.assertIn("refusing to publish an empty commit", tools)
        self.assertIn('body += "\\n\\n## Salvage reason\\n\\n%s" % failure_reason', tools)

    def test_oneshot_reviewer_records_findings_for_salvage(self):
        review = ONESHOT_REVIEW.read_text()
        implement = (WORKFLOW_DIR / "oneshot" / "prompts" / "implement.md").read_text()

        self.assertIn("Include the complete review findings", review)
        self.assertIn('"stage_failure": "<the same concrete blocker>"', implement)
        self.assertIn("failure_class` to `network`", review)
        self.assertIn("context_updates.stage_failure", review)

    def test_oneshot_reviewer_distinguishes_environment_and_baseline_failures(self):
        review = ONESHOT_REVIEW.read_text()

        self.assertIn("failure_class` to `network`", review)
        self.assertIn("context_updates.stage_failure", review)
        self.assertIn("temporary detached checkout", review)
        self.assertIn("explicitly non-blocking", review)

    def test_oneshot_has_stage_timeouts_below_its_stall_watchdog(self):
        graph = ONESHOT_GRAPH.read_text()
        stall_timeout = 60
        self.assertIn('stall_timeout="%dm"' % stall_timeout, graph)
        expected = {
            "prepare": 10,
            "implement": 45,
            "check": 5,
            "simplify": 30,
            "review": 30,
        }
        for node, minutes in expected.items():
            with self.subTest(node=node):
                block = graph.split("    %s [\n" % node, 1)[1].split("\n    ]", 1)[0]
                self.assertIn('timeout="%dm"' % minutes, block)
                self.assertLess(minutes, stall_timeout)
                self.assertNotIn("goal_gate=true", block)
                self.assertRegex(graph, r"(?m)^    %s -> fail(?: \[|$)" % node)
        publish = graph.split("    publish [\n", 1)[1].split("\n    ]", 1)[0]
        self.assertIn('timeout="15m"', publish)
        self.assertLess(15, stall_timeout)
        self.assertIn('publish -> exit [condition="outcome=succeeded"]', graph)
        self.assertIn("publish -> fail", graph)


if __name__ == "__main__":
    unittest.main()
