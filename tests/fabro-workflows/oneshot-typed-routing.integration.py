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
ONESHOT = ROOT / ".fabro" / "workflows" / "oneshot"
GRAPH = ONESHOT / "workflow.fabro"
TOOLS = ONESHOT / "scripts" / "tools.py"
SCHEMAS = ONESHOT / "schemas"


def node_block(graph, node):
    match = re.search(r"(?ms)^    %s \[\n.*?^    \]" % re.escape(node), graph)
    if match is None:
        raise AssertionError("oneshot node %s is missing" % node)
    return match.group()


def node_edges(graph, node):
    return [
        line.strip()
        for line in graph.splitlines()
        if line.strip().startswith("%s ->" % node)
    ]


def typed_payload(verdict, failure_class):
    return json.dumps({
        "verdict": verdict, "failure_class": failure_class, "check_results": {},
    })


class ScriptedModelHandler(http.server.BaseHTTPRequestHandler):
    responses = []
    requests = []

    def do_POST(self):
        type(self).requests.append(
            self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        self.wfile.write(self._stream(type(self).responses[0]))

    @staticmethod
    def _stream(content):
        def chunk(delta, finish=None):
            record = {
                "id": "chatcmpl-test", "object": "chat.completion.chunk",
                "created": 0, "model": "scripted",
                "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
            }
            return "data: " + json.dumps(record) + "\n\n"

        return (chunk({"role": "assistant", "content": ""})
                + chunk({"content": content})
                + chunk({}, "stop")
                + "data: [DONE]\n\n").encode()

    def log_message(self, *_args):
        pass


class OneshotTypedRoutingIntegrationTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix="oneshot-routing-")
        self.addCleanup(self.temp_dir.cleanup)
        self.root = pathlib.Path(self.temp_dir.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.addCleanup(self._stop_services)
        self.model = http.server.ThreadingHTTPServer(
            ("127.0.0.1", 0), ScriptedModelHandler)
        self.model.daemon_threads = True
        self.model_thread = threading.Thread(
            target=self.model.serve_forever, daemon=True)
        self.model_thread.start()
        self.port = self._free_port()
        self.api = "http://127.0.0.1:%d/api/v1" % self.port
        self.token = "fabro_dev_" + ("a" * 64)
        self.fabro = os.environ.get("FABRO_BIN") or shutil.which("fabro")
        if not self.fabro:
            self.fail("fabro binary not found; pass --fabro or set FABRO_BIN")
        self.env = {
            **os.environ,
            "HOME": str(self.home),
            "PATH": os.environ.get("PATH", "") + os.pathsep + "/usr/bin:/bin",
            "SESSION_SECRET": "0" * 64,
            "FABRO_DEV_TOKEN": self.token,
        }
        for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
                     "http_proxy", "https_proxy", "all_proxy"):
            self.env.pop(name, None)
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
display_name = "Scripted provider"
base_url = "http://127.0.0.1:%d/v1"
auth = { type = "none" }
default_model = "scripted"
[llm.providers.mock.models.scripted]
display_name = "Scripted model"
api_model = "scripted"
capabilities = { text = true, tools = true }
[run.model]
provider = "mock"
name = "scripted"
""" % (self.port, self.api, self.root, self.root, self.model.server_port))
        self.log = (self.root / "fabro-server.log").open("w+")
        self.server = subprocess.Popen(
            [self.fabro, "server", "start", "--foreground", "--no-web",
             "--no-upgrade-check", "--config", str(self.root / "settings.toml")],
            cwd=self.root, env=self.env, stdout=self.log,
            stderr=subprocess.STDOUT, text=True)
        self._wait_for_server()
        login = self._fabro(
            "auth", "login", "--server", self.api, "--dev-token", self.token)
        self.assertEqual(login.returncode, 0, login.stdout)
        self.target = self.root / "target"
        self.target.mkdir()
        shutil.copytree(SCHEMAS, self.target / "schemas")

    @staticmethod
    def _free_port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def _wait_for_server(self):
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if self.server.poll() is not None:
                self.log.flush()
                self.fail("Fabro server exited early:\n" + self.log.read())
            try:
                with urllib.request.urlopen(self.api + "/health", timeout=0.5) as resp:
                    if resp.status == 200:
                        return
            except (OSError, urllib.error.URLError):
                time.sleep(0.1)
        self.log.flush()
        self.fail("Fabro server did not start:\n" + self.log.read())

    def _stop_services(self):
        if self.server and self.server.poll() is None:
            self.server.terminate()
            try:
                self.server.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.server.kill()
                self.server.wait(timeout=5)
        if self.log and not self.log.closed:
            self.log.close()
        self.model.shutdown()
        self.model.server_close()
        self.model_thread.join(timeout=2)

    def _fabro(self, *args, timeout=10):
        return subprocess.run(
            [self.fabro, *args, "--no-upgrade-check"], cwd=self.root,
            env=self.env, text=True, stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT, timeout=timeout, check=False)

    def _workflow(self, stage, invalid=False):
        # Reuse the production node definitions and edges so the test covers
        # the conditions that ship, not a paraphrase of them.
        graph = GRAPH.read_text()
        node = node_block(graph, stage)
        node = node.replace('prompt="@prompts/%s.md"' % stage,
                            'prompt="Return the typed stage result JSON only."')
        node = node.replace('timeout="45m"', 'timeout="2m"')
        node = node.replace('timeout="30m"', 'timeout="2m"')
        if invalid:
            # Isolate output validation from whole-node retries.
            node = node.replace("max_retries=2", "max_retries=0")
        normalize = node_block(graph, "normalize_" + stage).replace(
            "python3 .git/oneshot-scripts/tools.py normalize %s" % stage,
            "python3 %s normalize %s" % (TOOLS, stage))
        edges = node_edges(graph, stage) + node_edges(graph, "normalize_" + stage)
        origins = {stage, "normalize_" + stage}
        targets = {re.match(r"\w+ -> (\w+)", edge).group(1) for edge in edges}
        targets -= origins
        sentinels = "\n".join(
            '    %s [shape=parallelogram, script="echo REACHED-%s"]' % (t, t)
            for t in sorted(targets))
        return (
            'digraph TypedRouting {\n  graph [stall_timeout="30s"]\n'
            '  start [shape=Mdiamond]\n  exit [shape=Msquare]\n'
            + node + "\n" + normalize + "\n" + sentinels + "\n"
            + "  start -> %s\n" % stage
            + "\n".join("  " + edge for edge in edges) + "\n"
            + "\n".join("  %s -> exit" % t for t in sorted(targets)) + "\n}\n")

    def _run(self, index, stage, verdict, failure_class, invalid=False):
        ScriptedModelHandler.responses = [typed_payload(verdict, failure_class)]
        ScriptedModelHandler.requests = []
        workflow = self.target / ("routing-%d.fabro" % index)
        workflow.write_text(self._workflow(stage, invalid=invalid))
        run = self._fabro(
            "run", str(workflow), "--server", self.api,
            "--target-from", str(self.target), "--environment", "local",
            "--auto-approve", "--verbose", timeout=90)
        self.assertEqual(run.returncode, 0, run.stdout)
        run_ids = re.findall(r"Run:\s+([A-Z0-9]{26})", run.stdout)
        self.assertTrue(run_ids, "Fabro run output did not contain a run ID")
        return run.stdout, run_ids[0]

    def _normalize_context(self, run_id, stage):
        events = self._fabro("events", run_id, "--server", self.api, "--json")
        self.assertEqual(events.returncode, 0, events.stdout)
        for line in events.stdout.splitlines():
            record = json.loads(line)
            node = record.get("item", {}).get("subject", {}).get("node", {})
            body = record.get("item", {}).get("record", {}).get("body", {})
            if (node.get("name") == "normalize_" + stage
                    and body.get("event") == "step.finished"):
                return body["outcome"]["context_updates"]
        self.fail("normalize_%s did not finish" % stage)

    def test_typed_routing(self):
        cases = (
            ("implement", "APPROVED", "none", False,
             "→ normalize_implement → check"),
            ("review", "APPROVED", "none", False,
             "→ normalize_review → publish"),
            ("review", "BLOCKED", "network", False,
             "→ normalize_review → salvage"),
            ("review", "REJECTED", "code", False,
             "→ normalize_review → rework"),
            ("implement", "APPROVE", "none", True, "→ implement → fail"),
        )
        for index, (stage, verdict, failure_class, invalid, path) in enumerate(cases):
            with self.subTest(stage=stage, verdict=verdict,
                              failure_class=failure_class):
                output, run_id = self._run(
                    index, stage, verdict, failure_class, invalid)
                self.assertIn(path, output)
                if invalid:
                    self.assertEqual(
                        len(ScriptedModelHandler.requests), 3,
                        "output_retries=2 allows the attempt plus two retries")
                if index == 0:
                    context = self._normalize_context(run_id, stage)
                    # Fabro stores the reserved "none" as ""; the mirrored
                    # failure_class_ok key is what the route matches.
                    self.assertEqual(context["failure_class"], "")
                    self.assertEqual(context["failure_class_ok"], "true")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--fabro", help="path to the Fabro CLI executable")
    args, unittest_args = parser.parse_known_args()
    if args.fabro:
        os.environ["FABRO_BIN"] = args.fabro
    unittest.main(argv=[__file__, *unittest_args])
