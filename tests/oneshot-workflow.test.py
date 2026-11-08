import contextlib
import io
import json
import os
import pathlib
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOLS = ROOT / ".fabro/workflows/oneshot/scripts/tools.py"
GRAPH = ROOT / ".fabro/workflows/oneshot/workflow.fabro"


def load_tools():
    namespace = {"__name__": "oneshot_workflow_test"}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


class ProbeTests(unittest.TestCase):
    def test_probe_returns_exact_failing_command_detail(self):
        tools = load_tools()
        with mock.patch.object(tools["subprocess"], "run", return_value=subprocess.CompletedProcess(
                ["fake"], 7, "", "DNS lookup failed")) as run:
            blocker = tools["run_probe"]("GitHub reachability", ["fake"], 15)
        self.assertEqual(blocker, "GitHub reachability probe failed: DNS lookup failed")
        self.assertEqual(run.call_args.kwargs["timeout"], 15)

    def test_probe_reports_timeout_and_unavailable_provider_is_optional(self):
        tools = load_tools()
        with mock.patch.object(tools["subprocess"], "run", side_effect=subprocess.TimeoutExpired(["fake"], 3)):
            self.assertEqual(tools["run_probe"]("Nix", ["fake"], 3), "Nix probe timed out after 3 seconds")
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(tools["github_rate_limit_blocker"](), "")
        with mock.patch.dict(os.environ, {"GITHUB_TOKEN": "token", "ONESHOT_API_BASE": "http://127.0.0.1:1"}):
            self.assertIn("GitHub rate-limit probe failed", tools["github_rate_limit_blocker"]())

    def test_diagnose_checks_workflow_preflight_only_when_issue_scope_suggests_it(self):
        tools = load_tools()
        calls = []
        tools["github_reachability_blocker"] = lambda: ""
        tools["github_rate_limit_blocker"] = lambda: ""
        tools["run_probe"] = lambda label, _cmd, _timeout: calls.append((label, _cmd)) or ""
        self.assertEqual(tools["diagnose_environment_blocker"]("Add a new Nix service"), "")
        self.assertFalse(any(label == "Fabro preflight" for label, _command in calls))
        self.assertEqual(tools["diagnose_environment_blocker"]("Update the oneshot workflow"), "")
        fabro_command = [command for label, command in calls if label == "Fabro preflight"]
        self.assertEqual(fabro_command, [["fabro", "preflight", ".fabro/workflows/oneshot/workflow.fabro"]])

    def test_diagnose_blocks_and_persists_failure_without_starting_implementation(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            pathlib.Path(tmp, ".git", "oneshot-issue.md").write_text("A normal change\n")
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                with mock.patch.dict(tools, {"diagnose_environment_blocker": lambda _issue: "GitHub reachability probe failed: Could not resolve host github.com"}):
                    output = io.StringIO()
                    with contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
                        tools["diagnose"](["381"])
                report = json.loads(output.getvalue())
                state = json.loads(pathlib.Path(".git/oneshot-state.json").read_text())
                self.assertEqual(report["context_updates"]["preflight_status"], "BLOCKED")
                self.assertEqual(report["context_updates"]["environment_blocker"],
                                 "GitHub reachability probe failed: Could not resolve host github.com")
                self.assertTrue(state["preflight_only"])
                self.assertEqual(state["environment_blocker"], report["context_updates"]["environment_blocker"])
                self.assertNotIn("baseline_sha", state)
            finally:
                os.chdir(previous)

    def test_workflow_gates_implement_and_fails_blocked_preflight(self):
        graph = GRAPH.read_text()
        self.assertIn('prepare -> diagnose [condition="outcome=succeeded && context.preflight_status!=BLOCKED"]', graph)
        blocked_edge = 'prepare -> fail [condition="outcome=succeeded && context.preflight_status=BLOCKED", weight=10]'
        self.assertIn(blocked_edge, graph)
        self.assertIn('diagnose -> implement [condition="outcome=succeeded && context.preflight_status=READY"]', graph)
        self.assertIn('diagnose -> fail [condition="outcome=succeeded && context.preflight_status=BLOCKED"]', graph)
        self.assertNotIn('prepare -> implement [condition="outcome=succeeded"]', graph)


if __name__ == "__main__":
    unittest.main()
