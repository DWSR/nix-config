import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".fabro" / "workflows"
FABRO_NIX = ROOT / "configurations" / "fabro-vm" / "fabro.nix"
LITELLM_NIX = ROOT / "configurations" / "fabro-vm" / "litellm.nix"
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

    def test_deepseek_deployment_pins_max_effort(self):
        text = LITELLM_NIX.read_text()
        _, _, tail = text.partition('model_name = "opencode-go/deepseek-v4.1-flash";')
        self.assertTrue(tail, "opencode-go/deepseek-v4.1-flash deployment is missing")
        block = tail.split("model_name =", 1)[0]
        self.assertIn('reasoning_effort = "max";', block)

    def test_deepseek_model_advertises_max_effort(self):
        text = FABRO_NIX.read_text()
        _, _, tail = text.partition('"deepseek-v4.1-flash" = {')
        self.assertTrue(tail, "deepseek-v4.1-flash fabro model is missing")
        block = tail.split('"glm-5.3-flash" = {', 1)[0]
        self.assertIn("reasoning_effort = {", block)
        self.assertIn("max = true;", block)

    def test_gpt_6_luna_deployment_pins_xhigh_effort(self):
        # The fallback keeps comparable thinking depth without a run-level
        # control: the effort travels with its deployment.
        text = LITELLM_NIX.read_text()
        _, _, tail = text.partition('model_name = "chatgpt/gpt-6-luna";')
        self.assertTrue(tail, "chatgpt/gpt-6-luna deployment is missing")
        block = tail.split("model_name =", 1)[0]
        self.assertIn('reasoning_effort = "xhigh";', block)

    def test_oneshot_routes_environmental_reviews_directly_to_failure(self):
        graph = ONESHOT_GRAPH.read_text()
        network_edge = 'review -> fail [condition="outcome=failed && context.failure_class contains network"]'
        blocked_edge = 'review -> fail [condition="outcome=failed && context.verdict=BLOCKED"]'
        rework_edge = 'review -> rework [condition="outcome=failed && context.verdict=REJECTED"]'

        self.assertIn(network_edge, graph)
        self.assertIn(blocked_edge, graph)
        self.assertLess(graph.index(network_edge), graph.index(rework_edge))
        self.assertLess(graph.index(blocked_edge), graph.index(rework_edge))
        self.assertNotIn("Review rejected the change after 2 rework rounds", graph)

    def test_oneshot_preflight_runs_only_for_workflow_changes(self):
        review = " ".join(ONESHOT_REVIEW.read_text().split())

        self.assertIn("fabro preflight .fabro/workflows/oneshot/workflow.toml", review)
        self.assertIn("only when the diff touches `.fabro/workflows/**` or any `workflow.toml`", review)
        self.assertIn("Otherwise skip it", review)

    def test_oneshot_server_auth_preflight_failure_is_environment_blocked(self):
        review = " ".join(ONESHOT_REVIEW.read_text().split())

        self.assertIn("server configuration or authentication", review)
        self.assertIn("record `environment-blocked: fabro preflight", review)
        self.assertIn("must not trigger rejection or rework", review)
        self.assertIn("overall verdict `BLOCKED`", review)
        self.assertIn("set `stage_failure` to the concrete startup reason", review)
        self.assertIn("Continue the remaining checks", review)

    def test_fabro_server_auth_has_an_allowed_github_username(self):
        text = FABRO_NIX.read_text()
        self.assertIn('auth.github.allowed_usernames = [ "DWSR" ];', text)

    def test_oneshot_reviewer_distinguishes_environment_and_baseline_failures(self):
        review = ONESHOT_REVIEW.read_text()

        self.assertIn("failure_class` to `network`", review)
        self.assertIn("context_updates.stage_failure", review)
        self.assertIn("temporary detached checkout", review)
        self.assertIn("explicitly non-blocking", review)


if __name__ == "__main__":
    unittest.main()
