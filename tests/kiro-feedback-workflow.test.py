import contextlib, http.server, io, json, os, pathlib, subprocess, tempfile, threading, unittest
from typing import Any

ROOT = pathlib.Path(__file__).resolve().parents[1]
CHILD_WORKFLOW = ROOT / ".fabro/workflows/kiro-feedback/workflow.fabro"
CHILD_TOML = ROOT / ".fabro/workflows/kiro-feedback/workflow.toml"
IMPL_WORKFLOW = ROOT / ".fabro/workflows/kiro-impl/workflow.fabro"
GIT_ENV = dict(os.environ, GIT_AUTHOR_NAME="Test", GIT_AUTHOR_EMAIL="test@example.com",
               GIT_COMMITTER_NAME="Test", GIT_COMMITTER_EMAIL="test@example.com")


def load_feedback_tools(api_base: str | None = None) -> dict[str, Any]:
    marker = "cat > .git/kiro-feedback-scripts/tools.py <<'KIRO_FEEDBACK_TOOLS_PY'\n"
    text = CHILD_TOML.read_text().split(marker, 1)[1].split("\nKIRO_FEEDBACK_TOOLS_PY", 1)[0]
    previous = os.environ.get("KIRO_FEEDBACK_GITHUB_API_BASE")
    if api_base:
        os.environ["KIRO_FEEDBACK_GITHUB_API_BASE"] = api_base
    try:
        namespace: dict[str, Any] = {"__name__": "kiro_feedback_tools_test"}
        exec(compile(text, str(CHILD_TOML), "exec"), namespace)
        return namespace
    finally:
        if previous is None:
            os.environ.pop("KIRO_FEEDBACK_GITHUB_API_BASE", None)
        else:
            os.environ["KIRO_FEEDBACK_GITHUB_API_BASE"] = previous


def read_script(label: str) -> str:
    text = IMPL_WORKFLOW.read_text()
    at = text.index('label="%s"' % label)
    start = text.index('script="', at) + len('script="')
    i, raw = start, []
    while True:
        if text[i] == "\\":
            raw.append(text[i : i + 2])
            i += 2
        elif text[i] == '"':
            break
        else:
            raw.append(text[i])
            i += 1
    return json.loads('"' + "".join(raw) + '"')


def run_stage(label: str, cwd: pathlib.Path, env: dict[str, str], **values: str) -> str:
    source = read_script(label)
    for name, value in values.items():
        source = source.replace("{{ %s }}" % name, json.dumps(value))
    stdout, stderr = io.StringIO(), io.StringIO()
    previous_cwd, previous_env = os.getcwd(), dict(os.environ)
    os.chdir(cwd)
    os.environ.update(env)
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            try:
                exec(compile(source, str(IMPL_WORKFLOW) + ":" + label, "exec"), {"__name__": "__main__"})
            except SystemExit as exc:
                if exc.code not in (0, None):
                    raise
    finally:
        os.chdir(previous_cwd)
        os.environ.clear()
        os.environ.update(previous_env)
    return stdout.getvalue()


def git(cwd: pathlib.Path, *args: str) -> str:
    result = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV)
    if result.returncode != 0:
        raise AssertionError("git %s failed: %s" % (" ".join(args), result.stderr))
    return result.stdout.strip()


class FakeBridge:
    def __init__(self) -> None:
        self.calls: list[tuple[str, dict[str, Any]]] = []
        calls = self.calls

        class Handler(http.server.BaseHTTPRequestHandler):
            def reply(self, status: int, payload: dict[str, Any]) -> None:
                body = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self) -> None:
                self.reply(200, self.server.pr)

            def do_POST(self) -> None:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
                calls.append((self.path, body))
                self.reply(201 if self.path == "/api/v1/runs" else 200,
                           {"id": "child-%d" % len(calls)})

            def log_message(self, *_args: object) -> None:
                pass

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.pr = {}
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    @property
    def base(self) -> str:
        return "http://127.0.0.1:%d/api/v1" % self.server.server_address[1]

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class KiroFeedbackToolsTests(unittest.TestCase):
    def test_parse_pr_ref_accepts_numbers_and_urls(self):
        tools = load_feedback_tools()
        self.assertEqual(tools["parse_pr_ref"]("123"), 123)
        self.assertEqual(tools["parse_pr_ref"]("#17"), 17)
        self.assertEqual(tools["parse_pr_ref"]("https://github.com/acme/repo/pull/42"), 42)

    def test_ci_state_requires_every_check_to_finish_green(self):
        tools = load_feedback_tools()
        self.assertEqual(tools["ci_state"]([]), "none")
        self.assertEqual(tools["ci_state"]([{"state": "SUCCESS"}, {"state": "SKIPPED"}]), "success")
        self.assertEqual(tools["ci_state"]([{"state": "SUCCESS"}, {"state": "IN_PROGRESS"}]), "pending")
        self.assertEqual(tools["ci_state"]([{"state": "SUCCESS"}, {"state": "FAILURE"}]), "failed")

    def test_unresolved_threads_collects_ids_and_skips_resolved_or_empty(self):
        tools = load_feedback_tools()
        tools["graphql"] = lambda _query, _variables: {"repository": {"pullRequest": {"reviewThreads": {
            "nodes": [
                {"id": "t1", "isResolved": False, "path": "a.py", "line": 4,
                 "comments": {"nodes": [{"author": {"login": "bot"}, "body": "Please fix"}]}},
                {"id": "t2", "isResolved": True, "path": "b.py", "line": 1,
                 "comments": {"nodes": [{"author": {"login": "bot"}, "body": "old"}]}},
                {"id": "t3", "isResolved": False, "path": "c.py", "line": 2,
                 "comments": {"nodes": [{"author": {"login": "bot"}, "body": "   "}]}},
            ],
            "pageInfo": {"hasNextPage": False, "endCursor": None},
        }}}}
        self.assertEqual([thread["id"] for thread in tools["unresolved_threads"]("acme/repo", 7)], ["t1"])

    def test_workflow_waits_for_green_ci_and_bounds_rework(self):
        text = CHILD_WORKFLOW.read_text()
        self.assertIn('label="Address feedback"', text)
        self.assertIn('await_ci -> finish [condition="outcome=succeeded && context.ci_result=success"]', text)
        self.assertIn('await_ci -> rework [condition="outcome=succeeded && context.ci_result=failed"]', text)
        self.assertIn('rework -> fix [condition="outcome=succeeded && context.fix_round <= 2"]', text)
        self.assertIn("rework -> fail\n", text)
        self.assertLessEqual(load_feedback_tools()["MAX_FIX_ROUNDS"], 2)


class KiroImplFeedbackDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.bridge = FakeBridge()
        self.addCleanup(self.bridge.close)
        git(self.root, "init", "--initial-branch=main")
        git(self.root, "remote", "add", "origin", "https://github.com/acme/repo.git")
        self.env = {"KIRO_IMPL_API_BASE": self.bridge.base, "PATH": os.environ.get("PATH", "")}
        self.values = {"inputs.spec": "example", "vars.kiro_feedback_workflow_version": "version-1"}

    def write_state(self, **overrides: Any) -> None:
        state = {"spec": "example", "trunk": "main", "feedback_needed": True, "pending": [], "current": None,
                 "layers": [{"layer": 1, "task": "1", "branch": "stack/example/1-one", "sha": "a" * 40, "pr": 11},
                            {"layer": 2, "task": "2", "branch": "stack/example/2-two", "sha": "b" * 40, "pr": 12}]}
        state.update(overrides)
        (self.root / ".git" / "kiro-impl-state.json").write_text(json.dumps(state))

    def state(self) -> dict[str, Any]:
        return json.loads((self.root / ".git" / "kiro-impl-state.json").read_text())

    def queue(self) -> str:
        return run_stage("Queue stack feedback", self.root, self.env, **self.values)

    def test_feedback_is_dispatched_bottom_up_and_advances(self):
        self.write_state()
        self.assertIn('"has_feedback": "true"', self.queue())
        self.assertEqual(len(self.bridge.calls), 2)
        path, body = self.bridge.calls[0]
        self.assertEqual(path, "/api/v1/runs")
        self.assertEqual(body["workflow_version_id"], "version-1")
        self.assertEqual(body["target"]["branch"], "stack/example/1-one")
        self.assertEqual(body["args"]["inputs"],
                         {"spec": "example", "pr": "11", "branch": "stack/example/1-one", "base": "main"})
        self.assertEqual(self.state()["feedback"]["current"]["child_run_id"], "child-1")

        self.assertIn('"has_next": "true"', run_stage("Advance feedback cursor", self.root, self.env))
        state = self.state()
        self.assertIsNone(state["feedback"]["current"])
        self.assertEqual(state["feedback"]["index"], 1)

        self.assertIn('"has_feedback": "true"', self.queue())
        inputs = self.bridge.calls[2][1]["args"]["inputs"]
        self.assertEqual((inputs["pr"], inputs["base"]), ("12", "stack/example/1-one"))

    def test_no_stack_or_unpinned_version_does_not_dispatch(self):
        self.write_state(feedback_needed=False)
        self.assertIn('"has_feedback": "false"', self.queue())
        self.assertEqual(self.bridge.calls, [])

        self.write_state()
        with self.assertRaises(SystemExit):
            run_stage("Queue stack feedback", self.root, self.env,
                      **{"inputs.spec": "example", "vars.kiro_feedback_workflow_version": ""})
        self.assertEqual(self.bridge.calls, [])


class KiroFeedbackGitTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)
        self.bridge = FakeBridge()
        self.addCleanup(self.bridge.close)
        self.origin = self.root / "origin.git"
        seed = self.root / "seed"
        git(self.root, "init", "--bare", "--initial-branch=main", str(self.origin))
        git(self.root, "clone", str(self.origin), str(seed))
        (seed / "base.txt").write_text("base\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "initial")
        git(seed, "push", "origin", "main")
        git(seed, "checkout", "-b", "stack/example/1-one")
        (seed / "layer.txt").write_text("layer\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "layer")
        git(seed, "push", "origin", "stack/example/1-one")
        git(seed, "checkout", "main")
        (seed / "main.txt").write_text("main\n")
        git(seed, "add", "-A")
        git(seed, "commit", "-m", "advance main")
        git(seed, "push", "origin", "main")
        self.new_main = git(seed, "rev-parse", "main")
        self.work = self.root / "work"
        git(self.root, "clone", str(self.origin), str(self.work))
        git(self.work, "remote", "set-url", "origin", "https://github.com/acme/repo.git")
        git(self.work, "config", "url.file://%s.insteadOf" % self.origin, "https://github.com/acme/repo.git")
        self.bridge.server.pr = {
            "number": 11, "state": "open", "merged": False,
            "head": {"ref": "stack/example/1-one", "repo": {"full_name": "acme/repo"}},
            "base": {"ref": "main"},
        }
        os.environ["GITHUB_TOKEN"] = "test-token"
        self.addCleanup(os.environ.pop, "GITHUB_TOKEN", None)

    def test_prepare_rebases_the_layer_and_amend_pushes_it(self):
        tools = load_feedback_tools(self.bridge.base)
        previous = os.getcwd()
        os.chdir(self.work)
        try:
            with contextlib.redirect_stdout(io.StringIO()):
                tools["prepare"](["11", "stack/example/1-one", "main"])
                state = json.loads((self.work / ".git" / "kiro-feedback-state.json").read_text())
                self.assertTrue(state["rebased"])
                tools["amend"]([])
        finally:
            os.chdir(previous)

        pushed = git(self.origin, "rev-parse", "refs/heads/stack/example/1-one")
        self.assertEqual(git(self.origin, "rev-parse", pushed + "^"), self.new_main)
        self.assertEqual(git(self.origin, "show", pushed + ":layer.txt").strip(), "layer")


if __name__ == "__main__":
    unittest.main()
