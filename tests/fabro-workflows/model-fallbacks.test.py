import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".fabro" / "workflows"
LITELLM_NIX = ROOT / "configurations" / "fabro-vm" / "litellm.nix"

# Every workflow with an agent node that inherits the runner's default
# deepseek-v4.1-flash model.
AGENT_WORKFLOWS = (
    "failure-triage",
    "kiro-feedback",
    "kiro-impl",
    "kiro-spec",
    "kiro-task",
    "oneshot",
)


def load_workflow(name):
    with (WORKFLOW_DIR / name / "workflow.toml").open("rb") as handle:
        return tomllib.load(handle)


class ModelFallbackTests(unittest.TestCase):
    def test_deepseek_falls_back_to_gpt_6_luna(self):
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertEqual(
                    model["fallbacks"]["deepseek-v4.1-flash"],
                    ["litellm:gpt-6-luna"],
                )

    def test_no_run_level_controls_are_forced_on_deepseek(self):
        # Run-level controls also apply to the primary model, and
        # deepseek-v4.1-flash advertises no reasoning_effort levels, so setting
        # xhigh there would break every primary call. The fallback gets its
        # effort from the litellm deployment instead.
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertNotIn("controls", model)

    def test_gpt_6_luna_deployment_pins_xhigh_effort(self):
        # The effort travels with the fallback model id, so the fallback keeps
        # comparable thinking depth without a run-level control.
        text = LITELLM_NIX.read_text()
        _, _, tail = text.partition('model_name = "chatgpt/gpt-6-luna";')
        self.assertTrue(tail, "chatgpt/gpt-6-luna deployment is missing")
        block = tail.split("model_name =", 1)[0]
        self.assertIn('reasoning_effort = "xhigh";', block)


if __name__ == "__main__":
    unittest.main()
