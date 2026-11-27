import contextlib
import io
import json
import os
import pathlib
import re
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot"
TOOLS = WORKFLOW / "scripts" / "tools.py"
GRAPH = WORKFLOW / "workflow.fabro"
PROMPTS = WORKFLOW / "prompts"
STAGES = ("implement", "simplify", "review")


def load_tools():
    namespace = {"__name__": "oneshot_rate_limit_test", "__file__": str(TOOLS)}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def node_block(graph, node):
    match = re.search(r"(?ms)^    %s \[\n.*?^    \]" % re.escape(node), graph)
    if match is None:
        raise AssertionError("node %s is missing" % node)
    return match.group()


def run_visits(tools, reason, stage="implement", expected=None):
    state = {}
    now = 1_000.0
    slept = 0.0
    sleeps = []
    for _ in range(20):
        plan = tools["plan_rate_limit_wait"](reason, stage, state, now)
        if plan["failure"]:
            return plan, slept, sleeps
        sleeps.append(plan["sleep"])
        slept += plan["sleep"]
        now += plan["sleep"]
        if expected is not None and slept >= expected:
            return plan, slept, sleeps
    raise AssertionError("wait plan did not reach the expected sleep total")


class HintParsingTests(unittest.TestCase):
    def test_parses_reset_and_retry_hints_from_common_shapes(self):
        tools = load_tools()
        parse = tools["parse_rate_limit_hint"]
        self.assertEqual(parse("usage_limit_reached resets_in_seconds: 2856"), 2856)
        self.assertEqual(parse('{"resets_in_seconds": 2856}'), 2856)
        self.assertEqual(parse("retry_after=120"), 120)
        self.assertEqual(parse("Retry-After: 45"), 45)
        self.assertEqual(
            parse("resets_in_seconds: 600; retry_after: 900"), 900)

    def test_ignores_non_positive_and_missing_hints(self):
        tools = load_tools()
        parse = tools["parse_rate_limit_hint"]
        self.assertIsNone(parse("provider is busy"))
        self.assertIsNone(parse("resets_in_seconds: 0"))
        self.assertIsNone(parse("retry_after: -5"))


class WaitPlanTests(unittest.TestCase):
    def test_2856_second_reset_is_covered_across_bounded_visits(self):
        tools = load_tools()
        plan, slept, sleeps = run_visits(
            tools, "usage_limit_reached; resets_in_seconds: 2856",
            expected=2856)
        self.assertEqual(plan["failure"], "")
        self.assertEqual(slept, 2856)
        self.assertLessEqual(len(sleeps), 4)
        self.assertTrue(all(0 < value <= 900 for value in sleeps))

    def test_repeated_static_hint_does_not_extend_the_deadline(self):
        tools = load_tools()
        _plan, slept, _sleeps = run_visits(
            tools, "resets_in_seconds: 2856", expected=2856)
        self.assertEqual(slept, 2856)

    def test_reset_beyond_the_wait_cap_fails_with_a_clear_reason(self):
        tools = load_tools()
        plan = tools["plan_rate_limit_wait"](
            "resets_in_seconds: 7200", "review", {}, 1_000.0)
        self.assertEqual(plan["sleep"], 0)
        self.assertIn("provider limit exceeds wait cap", plan["failure"])

    def test_missing_hint_uses_a_five_minute_bounded_backoff(self):
        tools = load_tools()
        plan = tools["plan_rate_limit_wait"](
            "rate limited with no reset header", "simplify", {}, 1_000.0)
        self.assertEqual(plan["failure"], "")
        self.assertEqual(plan["sleep"], 300)

    def test_used_budget_limits_the_next_visit(self):
        tools = load_tools()
        state = {"implement": {"deadline": 4_600.0, "waited": 3_000}}
        plan = tools["plan_rate_limit_wait"](
            "resets_in_seconds: 3600", "implement", state, 1_000.0)
        self.assertEqual(plan["sleep"], 0)
        self.assertIn("provider limit exceeds wait cap", plan["failure"])

    def test_exhausted_budget_fails_clear_after_a_completed_wait(self):
        tools = load_tools()
        state = {"simplify": {"deadline": 1_000.0, "waited": 3_600}}
        plan = tools["plan_rate_limit_wait"](
            "resets_in_seconds: 900", "simplify", state, 1_100.0)
        self.assertEqual(plan["sleep"], 0)
        self.assertIn("provider limit exceeds wait cap", plan["failure"])


class WaitCliTests(unittest.TestCase):
    def run_wait(self, stage, reason):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(pathlib.Path(tmp, ".git"))
            previous = os.getcwd()
            sleeps = []
            output = io.StringIO()
            os.chdir(tmp)
            try:
                with contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["wait_rate_limit"](
                        [stage], stdin=io.StringIO(reason),
                        sleep=sleeps.append)
                state_path = pathlib.Path(tmp, ".git", "oneshot-rate-limit-wait.json")
                state = json.loads(state_path.read_text()) if state_path.exists() else {}
            finally:
                os.chdir(previous)
        return json.loads(output.getvalue().strip().splitlines()[-1]), sleeps, state

    def test_fake_stdin_sleeps_for_the_matching_stage(self):
        report, sleeps, state = self.run_wait(
            "implement", "usage_limit_reached; resets_in_seconds: 2856")
        self.assertEqual(report["outcome"], "succeeded")
        self.assertEqual(sleeps, [900])
        self.assertEqual(state["implement"]["waited"], 900)

    def test_cap_failure_is_routed_with_the_clear_stage_failure(self):
        report, sleeps, _state = self.run_wait(
            "review", "resets_in_seconds: 7200")
        self.assertEqual(report["outcome"], "failed")
        self.assertEqual(sleeps, [])
        self.assertIn("provider limit exceeds wait cap",
                      report["context_updates"]["stage_failure"])


class NormalizeHandoffTests(unittest.TestCase):
    def test_rate_limit_result_populates_failure_reason_for_stdin(self):
        tools = load_tools()
        payload = {
            "verdict": "BLOCKED",
            "failure_class": "rate_limit",
            "check_results": {},
            "stage_failure": "implement: usage_limit_reached resets_in_seconds: 2856",
        }
        updates = tools["normalize_stage_result"]("implement", payload)
        self.assertEqual(updates["failure_reason"], payload["stage_failure"])

    def test_non_rate_limit_result_clears_stale_failure_reason_and_wait_state(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            git_dir = pathlib.Path(tmp, ".git")
            git_dir.mkdir()
            state_path = git_dir / "oneshot-rate-limit-wait.json"
            state_path.write_text(json.dumps({
                "implement": {"deadline": 4_000.0, "waited": 600}}))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                updates = tools["normalize_stage_result"]("implement", {
                    "verdict": "REJECTED",
                    "failure_class": "code",
                    "check_results": {},
                })
                remaining = json.loads(state_path.read_text())
            finally:
                os.chdir(previous)
        self.assertEqual(updates["failure_reason"], "")
        self.assertEqual(remaining, {})


class GraphWiringTests(unittest.TestCase):
    def test_wait_nodes_read_failure_reason_and_stay_within_the_stall_timeout(self):
        graph = GRAPH.read_text()
        tools = load_tools()
        stall_minutes = int(re.search(r'stall_timeout="(\d+)m"', graph).group(1))
        for stage in STAGES:
            with self.subTest(stage=stage):
                block = node_block(graph, "wait_%s_rate_limit" % stage)
                self.assertIn('stdin_source="failure_reason"', block)
                self.assertIn('max_retries=0', block)
                self.assertIn("tools.py wait %s" % stage, block)
                timeout = int(re.search(r'timeout="(\d+)m"', block).group(1))
                visits = int(re.search(r"max_visits=(\d+)", block).group(1))
                self.assertLess(timeout * 60, stall_minutes * 60)
                self.assertGreaterEqual(
                    min(tools["RATE_LIMIT_WAIT_CHUNK"], timeout * 60) * visits,
                    tools["RATE_LIMIT_WAIT_CAP"])

    def test_prompts_keep_provider_reset_hints_in_stage_failure(self):
        for name in STAGES:
            with self.subTest(prompt=name):
                text = (PROMPTS / (name + ".md")).read_text()
                self.assertIn("resets_in_seconds", text)
                self.assertIn("retry_after", text)

    def test_every_stage_can_retry_once_after_covering_the_reported_reset(self):
        graph = GRAPH.read_text()
        tools = load_tools()
        visits = -(-2856 // tools["RATE_LIMIT_WAIT_CHUNK"])
        for stage in STAGES:
            with self.subTest(stage=stage):
                block = node_block(graph, stage)
                attempts = int(re.search(r"max_visits=(\d+)", block).group(1))
                self.assertGreater(attempts, visits)


if __name__ == "__main__":
    unittest.main()
