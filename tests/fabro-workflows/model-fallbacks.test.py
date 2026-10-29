import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / ".fabro" / "workflows"

# Every workflow with an agent node that inherits the runner's default
# deepseek-v4.1-flash model.
AGENT_WORKFLOWS = (
    "failure-triage",
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

    def test_fallback_requests_the_gpt_6_luna_thinking_level(self):
        for name in AGENT_WORKFLOWS:
            with self.subTest(workflow=name):
                model = load_workflow(name)["run"]["model"]
                self.assertEqual(model["controls"]["reasoning_effort"], "xhigh")


if __name__ == "__main__":
    unittest.main()
