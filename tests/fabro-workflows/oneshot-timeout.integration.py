import argparse
import http.server
import json
import os
import pathlib
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parents[2]
ONESHOT_GRAPH = ROOT / ".fabro" / "workflows" / "oneshot" / "workflow.fabro"


class HangingModelHandler(http.server.BaseHTTPRequestHandler):
    request_started = threading.Event()

    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", "0")))
        self.request_started.set()
        time.sleep(30)

    def log_message(self, *_args):
        pass


class OneshotReviewTimeoutIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="oneshot-timeout-")
        self.addCleanup(self.temp_dir.cleanup)
        self.root = pathlib.Path(self.temp_dir.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.server = None
        self.server_log = None
        self.addCleanup(self._stop_services)
        HangingModelHandler.request_started = threading.Event()
        self.model_server = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), HangingModelHandler
        )
        self.model_server.daemon_threads = True
        self.model_server.allow_reuse_address = True
        self.model_thread = threading.Thread(
            target=self.model_server.serve_forever, daemon=True
        )
        self.model_thread.start()
        self.api_port = self._free_port()
        self.api_url = "http://127.0.0.1:%d/api/v1" % self.api_port
        self.token = "fabro_dev_" + ("a" * 64)
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", "") + os.pathsep + "/usr/bin:/bin",
            "NIX_SSL_CERT_FILE": os.environ.get(
                "NIX_SSL_CERT_FILE", "/etc/ssl/certs/ca-certificates.crt"
            ),
            "SESSION_SECRET": "0" * 64,
            "FABRO_DEV_TOKEN": self.token,
        }
        for name in (
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "ALL_PROXY",
            "http_proxy",
            "https_proxy",
            "all_proxy",
        ):
            self.env.pop(name, None)
        self.fabro = os.environ.get("FABRO_BIN") or shutil.which("fabro")
        if not self.fabro:
            self.fail("fabro binary not found; pass --fabro or set FABRO_BIN")
        self._write_server_settings()
        self.server_log = (self.root / "fabro-server.log").open("w+")
        self.env.pop("HTTP_PROXY", None)
        self.env.pop("HTTPS_PROXY", None)
        self.env.pop("ALL_PROXY", None)
        self.env.pop("http_proxy", None)
        self.env.pop("https_proxy", None)
        self.env.pop("all_proxy", None)
        self.server = subprocess.Popen(
            [
                self.fabro,
                "server",
                "start",
                "--foreground",
                "--no-web",
                "--no-upgrade-check",
                "--config",
                str(self.root / "settings.toml"),
            ],
            cwd=self.root,
            env=self.env,
            stdout=self.server_log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        self._wait_for_server()

    @staticmethod
    def _free_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _write_server_settings(self):
        (self.root / "settings.toml").write_text(
            """_version = 1
[server.listen]
type = "tcp"
address = "127.0.0.1:%d"
[server.api]
url = "%s"
[server.auth]
methods = ["dev-token"]
[server.storage]
root = "%s/storage"
[server.artifacts]
provider = "local"
prefix = "artifacts"
[server.artifacts.local]
root = "%s/storage/objects"
[server.sandbox.providers.local]
enabled = true
[llm.providers.mock]
display_name = "Hanging test provider"
base_url = "http://127.0.0.1:%d/v1"
auth = { type = "none" }
default_model = "hang"
[llm.providers.mock.models.hang]
display_name = "Hanging test model"
api_model = "hang"
capabilities = { text = true, tools = true }
[run.model]
provider = "mock"
name = "hang"
"""
            % (
                self.api_port,
                self.api_url,
                self.root,
                self.root,
                self.model_server.server_port,
            )
        )

    def _wait_for_server(self):
        deadline = time.monotonic() + 15
        health_url = self.api_url + "/health"
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                self.server_log.flush()
                self.fail("Fabro server exited early:\n" + self.server_log.read())
            try:
                with urllib.request.urlopen(health_url, timeout=0.5) as response:
                    if response.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        self.server_log.flush()
        self.fail("Fabro server did not start:\n" + self.server_log.read())

    def _stop_services(self):
        if self.server and self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait(timeout=5)
        if self.server_log and not self.server_log.closed:
            self.server_log.close()
        if getattr(self, "model_server", None):
            self.model_server.shutdown()
            self.model_server.server_close()
        if getattr(self, "model_thread", None):
            self.model_thread.join(timeout=2)

    def _fabro(self, *args, timeout=10):
        return subprocess.run(
            [self.fabro, *args, "--no-upgrade-check"],
            cwd=self.root,
            env=self.env,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )

    def test_hung_review_times_out_and_routes_to_fail_before_watchdog(self):
        # Use the production review node so this covers its class and retry settings.
        graph = ONESHOT_GRAPH.read_text()
        match = re.search(r"(?ms)^    review \[\n.*?^    \]", graph)
        self.assertIsNotNone(match, "oneshot review node is missing")
        review_node = match.group()
        self.assertIn('timeout="30m"', review_node)
        review_node = review_node.replace('timeout="30m"', 'timeout="2s"')
        review_node = review_node.replace(
            'prompt="@prompts/review.md"',
            'prompt="Respond when the model request completes."',
        )

        workflow = self.root / "review-timeout.fabro"
        workflow.write_text(
            'digraph OneshotReviewTimeout {\n'
            '    graph [stall_timeout="10s"]\n'
            '    start [shape=Mdiamond]\n'
            + review_node
            + '\n'
            '    fail [shape=parallelogram, script="echo failure-node-reached"]\n'
            '    exit [shape=Msquare]\n'
            '    start -> review\n'
            '    review -> fail\n'
            '    fail -> exit\n'
            '}\n'
        )

        login = self._fabro(
            "auth",
            "login",
            "--server",
            self.api_url,
            "--dev-token",
            self.token,
        )
        self.assertEqual(login.returncode, 0, login.stdout)
        try:
            run = self._fabro(
                "run",
                str(workflow),
                "--server",
                self.api_url,
                "--target-from",
                str(self.root),
                "--environment",
                "local",
                "--auto-approve",
                "--verbose",
                timeout=15,
            )
        except subprocess.TimeoutExpired as error:
            self.fail("review ignored its 2s timeout before the 10s watchdog: %s" % error)
        output = run.stdout

        self.assertEqual(run.returncode, 0, output)
        run_ids = re.findall(r"Run:\s+([A-Z0-9]{26})", output)
        self.assertTrue(run_ids, "Fabro run output did not contain a run ID")
        run_id = run_ids[0]
        events = self._fabro(
            "events", run_id, "--server", self.api_url, "--json"
        )
        self.assertEqual(events.returncode, 0, events.stdout)
        records = [json.loads(line) for line in events.stdout.splitlines()]
        self.assertTrue(
            HangingModelHandler.request_started.wait(timeout=2),
            "review did not reach the deliberately hanging model endpoint: "
            + output
            + events.stdout[-5000:],
        )
        self.assertIn("timed_out", output)
        self.assertNotIn("Pipeline cancelled", output)
        self.assertIn("→ review → fail", output)
        review_timeout = [
            event
            for event in records
            if event.get("item", {}).get("subject", {}).get("node", {}).get("name")
            == "review"
            and event.get("item", {}).get("record", {}).get("body", {}).get("event")
            == "step.finished"
        ]
        self.assertEqual(len(review_timeout), 1)
        outcome = review_timeout[0]["item"]["record"]["body"]["outcome"]
        self.assertEqual(outcome["status"], "timed_out")
        self.assertLess(outcome["metrics"]["duration_ms"], 10_000)

        review_routes = [
            event
            for event in records
            if event.get("item", {}).get("subject", {}).get("node", {}).get("name")
            == "review"
            and event.get("item", {}).get("record", {}).get("body", {}).get("event")
            == "routing.resolved"
        ]
        self.assertTrue(
            any(
                target.get("name") == "fail"
                for event in review_routes
                for group in event.get("item", {}).get("derived", {}).get("groups", [])
                for target in [group.get("target", {})]
            ),
            "timed-out review did not route to the fail node",
        )


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fabro", help="path to the Fabro CLI executable")
    args, unittest_args = parser.parse_known_args()
    if args.fabro:
        os.environ["FABRO_BIN"] = args.fabro
    unittest.main(argv=[__file__, *unittest_args])
