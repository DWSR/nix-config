import contextlib
import importlib.util
import os
import io
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / ".fabro/workflows/oneshot/scripts/wait_rate_limit.py"
GRAPH = ROOT / ".fabro/workflows/oneshot/workflow.fabro"
SPEC = importlib.util.spec_from_file_location("oneshot_wait_rate_limit", SCRIPT)
wait_rate_limit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(wait_rate_limit)


class WaitRateLimitTests(unittest.TestCase):
    def test_retry_with_same_reset_hint_is_covered_in_bounded_visits(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            while not sleeps or sum(sleeps) < 2856:
                wait_rate_limit.wait(
                    "implement", '{"resets_in_seconds": 2856}', state_path, sleeps.append
                )
            self.assertEqual(sum(sleeps), 2856)
            self.assertEqual(sleeps, [300] * 9 + [156])
            self.assertLessEqual(max(sleeps), 300)
            self.assertEqual(
                json.loads(state_path.read_text()),
                {"implement": {"waited": 2856, "hinted_total": 2856, "last_hint": 2856}},
            )

    def test_retry_after_and_default_backoff(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            self.assertEqual(
                wait_rate_limit.wait("review", "retry_after: 600", state_path, sleeps.append),
                300,
            )
            self.assertEqual(
                wait_rate_limit.wait("simplify", "provider is busy", state_path, sleeps.append),
                300,
            )
            self.assertEqual(sleeps, [300, 300])

    def test_provider_limit_beyond_cap_fails_clearly(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            for _ in range(12):
                wait_rate_limit.wait(
                    "review", '"retry_after": 5000', state_path, sleeps.append
                )
            with self.assertRaisesRegex(
                wait_rate_limit.WaitCapExceeded, "provider limit exceeds wait cap"
            ):
                wait_rate_limit.wait(
                    "review", '"retry_after": 5000', state_path, sleeps.append
                )
            self.assertEqual(sum(sleeps), 3600)
            self.assertEqual(len(sleeps), 12)

    def test_new_retry_hint_starts_after_elapsed_wait(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            wait_rate_limit.wait("implement", '"retry_after": 1200', state_path, sleeps.append)
            self.assertEqual(
                wait_rate_limit.wait("implement", '"retry_after": 900', state_path, sleeps.append),
                300,
            )
            self.assertEqual(sleeps, [300, 300])
            self.assertEqual(
                json.loads(state_path.read_text()),
                {"implement": {"waited": 600, "hinted_total": 1200, "last_hint": 900}},
            )

    def test_updated_retry_hint_replaces_an_expired_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            wait_rate_limit.wait("review", '"retry_after": 30', state_path, sleeps.append)
            self.assertEqual(
                wait_rate_limit.wait("review", '"retry_after": 600', state_path, sleeps.append),
                300,
            )
            self.assertEqual(sleeps, [30, 300])
            self.assertEqual(
                json.loads(state_path.read_text()),
                {"review": {"waited": 330, "hinted_total": 630, "last_hint": 600}},
            )

    def test_command_reads_stdin_and_reports_wait_cap(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            state_path.write_text(json.dumps({"review": 3600}))
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "review"],
                input='"resets_in_seconds": 2856',
                capture_output=True,
                text=True,
                env={**os.environ, "ONESHOT_RATE_LIMIT_STATE": str(state_path)},
            )
            self.assertEqual(result.returncode, 0)
            output = json.loads(result.stdout)
            self.assertEqual(output["outcome"], "failed")
            self.assertIn("provider limit exceeds wait cap", output["failure_reason"])

    def test_main_with_fake_stdin_sleeps_and_returns_success(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = pathlib.Path(directory) / "waits.json"
            sleeps = []
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                result = wait_rate_limit.main(
                    ["implement"], io.StringIO('{"resets_in_seconds": 2856}'), state_path, sleeps.append
                )
            self.assertEqual(result, 0)
            self.assertEqual(json.loads(stdout.getvalue()), {"outcome": "succeeded"})
            self.assertEqual(sleeps, [300])

    def test_graph_routes_failure_reason_and_bounds_retry_visits(self):
        graph = GRAPH.read_text()
        for stage in ("implement", "simplify", "review"):
            with self.subTest(stage=stage):
                block = graph.split("wait_%s_rate_limit [" % stage, 1)[1].split("\n    ]", 1)[0]
                self.assertIn('stdin_source="context.failure_reason"', block)
                self.assertIn("max_visits=13", block)
                self.assertIn("timeout=\"6m\"", block)
                self.assertIn("wait_rate_limit.py %s" % stage, block)
                agent = graph.split("    %s [" % stage, 1)[1].split("\n    ]", 1)[0]
                self.assertIn("max_visits=16", agent)


if __name__ == "__main__":
    unittest.main()
