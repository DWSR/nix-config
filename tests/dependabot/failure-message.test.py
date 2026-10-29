import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW_TOML = ROOT / ".fabro/workflows/dependabot/workflow.toml"
WORKFLOW_DOT = ROOT / ".fabro/workflows/dependabot/workflow.fabro"
MARKER = "cat > .git/dependabot-scripts/tools.py <<'DEPENDABOT_TOOLS_PY'\n"
EDGE = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*->\s*([A-Za-z_][A-Za-z0-9_]*)")
MARKER_NODE = re.compile(r"(?m)^\s*(mark_[A-Za-z0-9_]+)\s*\[")


def load_tools() -> dict[str, Any]:
    text = WORKFLOW_TOML.read_text()
    script = text.split(MARKER, 1)[1].split("\nDEPENDABOT_TOOLS_PY", 1)[0]
    namespace: dict[str, Any] = {"__name__": "dependabot_tools_test"}
    exec(compile(script, str(WORKFLOW_TOML), "exec"), namespace)
    return namespace


class DependabotFailureMessageTests(unittest.TestCase):
    def test_stage_and_detail_are_reported(self):
        tools = load_tools()
        self.assertEqual(
            tools["failure_message"]("test (verify tests)", "pytest failed"),
            "test (verify tests) failed: pytest failed",
        )

    def test_stage_without_detail_still_names_the_stage(self):
        tools = load_tools()
        message = tools["failure_message"]("prepare (validate PR and rebase)", "")
        self.assertIn("prepare (validate PR and rebase) failed", message)
        self.assertIn(".git/dependabot-state.json", message)

    def test_detail_without_stage_is_preserved(self):
        tools = load_tools()
        self.assertEqual(tools["failure_message"]("", "the sandbox is unavailable"), "the sandbox is unavailable")

    def test_missing_stage_and_detail_names_the_setup_case(self):
        tools = load_tools()
        message = tools["failure_message"]("", "")
        self.assertIn("did not report itself", message)
        self.assertIn("sandbox setup", message)

    def test_values_are_rendered_on_one_line(self):
        tools = load_tools()
        self.assertEqual(
            tools["failure_message"](" fix \n (fix failures) ", " two\nlines "),
            "fix (fix failures) failed: two lines",
        )

    def test_fail_command_exits_one_with_the_stage_and_detail(self):
        text = WORKFLOW_TOML.read_text()
        script = text.split(MARKER, 1)[1].split("\nDEPENDABOT_TOOLS_PY", 1)[0]
        with tempfile.TemporaryDirectory() as workdir:
            tools_path = pathlib.Path(workdir) / "tools.py"
            tools_path.write_text(script)
            result = subprocess.run(
                [sys.executable, str(tools_path), "fail", "test (verify tests)"],
                input="pytest failed",
                capture_output=True,
                text=True,
                cwd=workdir,
            )

        self.assertEqual(result.returncode, 1)
        self.assertIn("dependabot: test (verify tests) failed: pytest failed", result.stderr)


class DependabotFailureRoutingTests(unittest.TestCase):
    def test_every_failure_reaches_fail_through_a_stage_marker(self):
        graph = WORKFLOW_DOT.read_text()
        edges = EDGE.findall(graph)
        marker_nodes = set(MARKER_NODE.findall(graph))
        incoming = {source for source, target in edges if target == "fail"}

        self.assertTrue(marker_nodes)
        self.assertEqual(incoming, marker_nodes)

    def test_each_stage_marker_records_its_stage(self):
        graph = WORKFLOW_DOT.read_text()
        for marker in MARKER_NODE.findall(graph):
            block = graph.split("%s [" % marker, 1)[1].split("]", 1)[0]
            self.assertIn(".git/dependabot-failed-stage", block, marker)

    def test_fail_node_reports_the_recorded_stage(self):
        graph = WORKFLOW_DOT.read_text()
        block = graph.split("    fail [", 1)[1].split("\n    ]", 1)[0]
        self.assertIn(".git/dependabot-failed-stage", block)
        self.assertIn("tools.py fail", block)


if __name__ == "__main__":
    unittest.main()
