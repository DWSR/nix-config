import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".fabro" / "workflows"
FABRO_NIX = ROOT / "configurations" / "fabro-vm" / "fabro.nix"
LITELLM_NIX = ROOT / "configurations" / "fabro-vm" / "litellm.nix"

# Every workflow with an agent node that uses the runner's default
# gpt-6-luna model.
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
    def test_fabro_default_model_is_gpt_6_luna(self):
        text = FABRO_NIX.read_text()
        self.assertIn('default_model = "gpt-6-luna";', text)

        cli = text.split("cli = {", 1)[1].split("target =", 1)[0]
        self.assertIn('name = "gpt-6-luna";', cli)

        run = text.split("run = {", 1)[1].split("run_branch = {", 1)[0]
        self.assertIn('model.name = "gpt-6-luna";', run)

    def test_gpt_6_luna_falls_back_to_deepseek(self):
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertEqual(
                    model["fallbacks"]["gpt-6-luna"],
                    ["litellm:deepseek-v4.1-flash"],
                )

    def test_no_run_level_controls_are_forced_on_the_fallback(self):
        # Run-level controls also apply to the fallback model, and
        # deepseek-v4.1-flash advertises no reasoning_effort levels, so setting
        # xhigh there would break every failover call. GPT-6 Luna gets its
        # xhigh effort from the litellm deployment instead.
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertNotIn("controls", model)

    def test_gpt_6_luna_deployment_pins_xhigh_effort(self):
        # The effort travels with the default model id, so every workflow gets
        # xhigh thinking without a run-level control.
        text = LITELLM_NIX.read_text()
        _, _, tail = text.partition('model_name = "chatgpt/gpt-6-luna";')
        self.assertTrue(tail, "chatgpt/gpt-6-luna deployment is missing")
        block = tail.split("model_name =", 1)[0]
        self.assertIn('reasoning_effort = "xhigh";', block)


if __name__ == "__main__":
    unittest.main()
