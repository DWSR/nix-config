import contextlib
import io
import json
import os
import pathlib
import re
import shlex
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot"
GRAPH = WORKFLOW / "workflow.fabro"
TOOLS = WORKFLOW / "scripts" / "tools.py"

EDGE = re.compile(r"^\s*(\w+)\s*->\s*(\w+)(?:\s*\[(.*)\])?\s*$")
CONDITION = re.compile(r'condition="([^"]*)"')
WEIGHT = re.compile(r"weight=(\d+)")
CLAUSE = re.compile(
    r"^(outcome|context\.[A-Za-z0-9_]+)\s*(!=|<=|>=|=|<|>)\s*(.*)$")
GIT_ENV = dict(
    os.environ,
    GIT_AUTHOR_NAME="Test",
    GIT_AUTHOR_EMAIL="test@example.com",
    GIT_COMMITTER_NAME="Test",
    GIT_COMMITTER_EMAIL="test@example.com",
)


def load_tools():
    namespace = {"__name__": "oneshot_routing_test"}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def parse_edges(graph):
    edges = []
    for line in graph.splitlines():
        match = EDGE.match(line)
        if match is None:
            continue
        source, target, attributes = match.groups()
        attributes = attributes or ""
        condition = CONDITION.search(attributes)
        weight = WEIGHT.search(attributes)
        edges.append({
            "source": source,
            "target": target,
            "condition": condition.group(1) if condition else "",
            "weight": int(weight.group(1)) if weight else 0,
            "text": line.strip(),
        })
    return edges


def compare(actual, operator, expected):
    if operator in ("<", "<=", ">", ">="):
        try:
            actual, expected = int(actual), int(expected)
        except (TypeError, ValueError):
            return False
        return {
            "<": actual < expected,
            "<=": actual <= expected,
            ">": actual > expected,
            ">=": actual >= expected,
        }[operator]
    return actual == expected if operator == "=" else actual != expected


def condition_matches(condition, outcome, context):
    for clause in condition.split(" && "):
        clause = clause.strip()
        if not clause:
            continue
        match = CLAUSE.match(clause)
        if match is None:
            raise AssertionError("unsupported routing clause: %r" % clause)
        key, operator, expected = match.groups()
        actual = outcome if key == "outcome" else str(
            context.get(key[len("context."):], ""))
        if not compare(actual, operator, expected.strip()):
            return False
    return True


def route(graph, source, outcome, context):
    # Fabro prefers the highest-weight matching edge and keeps document order
    # as the tie-breaker, so the first maximum is the effective route.
    candidates = [
        edge for edge in parse_edges(graph)
        if edge["source"] == source
        and condition_matches(edge["condition"], outcome, context)
    ]
    return max(candidates, key=lambda edge: edge["weight"], default=None)


def remove_edge(graph, edge):
    lines = graph.splitlines()
    matches = [index for index, line in enumerate(lines)
               if line.strip() == edge["text"]]
    if len(matches) != 1:
        raise AssertionError("expected one edge %r, found %d" % (
            edge["text"], len(matches)))
    return "\n".join(lines[:matches[0]] + lines[matches[0] + 1:]) + "\n"


def fabro_context(updates):
    # Fabro stores the reserved context value "none" as an empty string before
    # routing. Model that so the assertions use the values the engine sees.
    return {
        key: "" if str(value) == "none" else str(value)
        for key, value in updates.items()
    }


def stage_context(stage, verdict, failure_class):
    tools = load_tools()
    payload = {"verdict": verdict, "failure_class": failure_class,
               "check_results": {}}
    error = tools["stage_result_error"](stage, payload)
    if error:
        raise AssertionError(error)
    return fabro_context(tools["normalize_stage_result"](stage, payload))


def node_block(graph, node):
    match = re.search(r"(?ms)^    %s \[\n.*?^    \]" % re.escape(node), graph)
    if match is None:
        raise AssertionError("oneshot node %s is missing" % node)
    return match.group()


class RoutingMatrixTests(unittest.TestCase):
    def setUp(self):
        self.graph = GRAPH.read_text()

    def assert_route(self, source, outcome, context, target, condition, weight):
        edge = route(self.graph, source, outcome, context)
        self.assertIsNotNone(
            edge, "%s has no route for outcome=%s context=%s" % (
                source, outcome, context))
        self.assertEqual(edge["target"], target, edge["text"])
        self.assertEqual(edge["condition"], condition, edge["text"])
        self.assertEqual(edge["weight"], weight, edge["text"])
        # Prove the assertion depends on this exact edge: dropping it must
        # change the selected route (target or condition).
        without = route(remove_edge(self.graph, edge), source, outcome, context)
        self.assertNotEqual(
            None if without is None else (
                without["target"], without["condition"], without["weight"]),
            (edge["target"], edge["condition"], edge["weight"]),
            "removing %r did not change the route" % edge["text"])
        return edge

    def test_network_failure_routes_to_salvage_or_fail(self):
        self.assert_route(
            "normalize_review", "succeeded",
            stage_context("review", "REJECTED", "network"),
            "salvage", "context.failure_class=network", 5)
        self.assert_route(
            "normalize_implement", "succeeded",
            stage_context("implement", "BLOCKED", "network"),
            "salvage", "context.impl_status=BLOCKED", 0)
        self.assert_route(
            "normalize_simplify", "succeeded",
            stage_context("simplify", "BLOCKED", "network"),
            "fail", "", 0)

    def test_blocked_routes_to_fail_or_salvage(self):
        self.assert_route(
            "prepare", "succeeded",
            {"skipped": "false", "preflight_status": "BLOCKED"},
            "fail", "outcome=succeeded && context.preflight_status=BLOCKED", 10)
        self.assert_route(
            "diagnose", "succeeded", {"preflight_status": "BLOCKED"},
            "fail", "outcome=succeeded && context.preflight_status=BLOCKED", 0)
        self.assert_route(
            "normalize_implement", "succeeded",
            stage_context("implement", "BLOCKED", "code"),
            "salvage", "context.impl_status=BLOCKED", 0)
        self.assert_route(
            "normalize_simplify", "succeeded",
            stage_context("simplify", "BLOCKED", "code"),
            "fail", "", 0)
        self.assert_route(
            "normalize_review", "succeeded",
            stage_context("review", "BLOCKED", "code"),
            "salvage", "context.verdict=BLOCKED", 5)

    def test_baseline_red_routes_to_continue(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp)
            self._git(repo, "init", "--quiet", "--initial-branch=main")
            self._git(repo, "config", "user.name", "Test")
            self._git(repo, "config", "user.email", "test@example.com")
            (repo / "fixture.txt").write_text("baseline\n")
            self._git(repo, "add", "--all")
            self._git(repo, "commit", "--quiet", "-m", "baseline")
            baseline_sha = self._git(repo, "rev-parse", "HEAD")
            state_path = repo / ".git" / "oneshot-state.json"
            state_path.write_text(json.dumps({"baseline_sha": baseline_sha}))

            def failed_check(command, _cwd, _deadline, _timeout):
                return {"command": shlex.join(command), "status": "failed",
                        "reason": "exit status 1"}

            previous = os.getcwd()
            os.chdir(repo)
            try:
                output = io.StringIO()
                with mock.patch.object(
                        tools["shutil"], "which", return_value=None), \
                        mock.patch.dict(tools, {
                            "baseline_command": failed_check,
                            "persist_meta_state": lambda *_args, **_kwargs: "",
                        }), contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["baseline"]([])
            finally:
                os.chdir(previous)

            report = json.loads(output.getvalue().strip().splitlines()[-1])
            results = json.loads(state_path.read_text())["baseline_results"]

        self.assertEqual(report["outcome"], "succeeded")
        self.assertEqual(report["context_updates"]["baseline_status"], "RECORDED")
        failed = [item for item in results if item["status"] == "failed"]
        self.assertGreaterEqual(len(failed), 1, results)
        self.assert_route(
            "baseline", report["outcome"], report["context_updates"],
            "implement", "outcome=succeeded", 0)

    def test_rate_limit_routes_every_stage_to_its_waiter(self):
        self.assert_route(
            "normalize_implement", "succeeded",
            stage_context("implement", "APPROVED", "rate_limit"),
            "wait_implement_rate_limit",
            "context.failure_class=rate_limit", 10)
        self.assert_route(
            "normalize_simplify", "succeeded",
            stage_context("simplify", "APPROVED", "rate_limit"),
            "wait_simplify_rate_limit",
            "context.failure_class=rate_limit", 10)
        self.assert_route(
            "normalize_review", "succeeded",
            stage_context("review", "REJECTED", "rate_limit"),
            "wait_review_rate_limit",
            "context.failure_class=rate_limit", 10)

    def test_exhausted_rework_routes_to_salvage(self):
        self.assert_route(
            "rework", "succeeded", {"rework_round": "3"},
            "salvage", "outcome=succeeded && context.rework_round > 2", 0)
        self.assert_route(
            "rework", "succeeded", {"rework_round": "2"},
            "implement", "outcome=succeeded && context.rework_round <= 2", 0)

    def test_closed_issue_routes_to_a_clean_skip(self):
        tools = load_tools()
        calls = []
        closed = {"number": 385, "state": "closed", "title": "closed",
                  "labels": [{"name": "fabro-ready"}]}

        def fake_gh(method, path, _body=None, expect=(200, 201, 204)):
            calls.append((method, path))
            if method == "GET" and path.endswith("/issues/385"):
                return 200, closed
            return 200, None

        tools["github_reachability_blocker"] = lambda: ""
        tools["origin_repo"] = lambda: ("example", "project")
        tools["run"] = lambda *_args, **_kwargs: ""
        tools["gh"] = fake_gh
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["prepare"](["385"])
            finally:
                os.chdir(previous)
        report = json.loads(output.getvalue().strip().splitlines()[-1])

        self.assertEqual(report["outcome"], "succeeded")
        self.assertEqual(report["context_updates"]["skipped"], "true")
        self.assertEqual(report["context_updates"]["skip_reason"], "closed")
        self.assertIn(
            ("DELETE", "/repos/example/project/issues/385/labels/fabro-ready"),
            calls)
        self.assert_route(
            "prepare", report["outcome"], report["context_updates"],
            "exit", "outcome=succeeded && context.skipped=true", 10)

    def test_timeout_routes_to_fail_or_salvage(self):
        for source in ("implement", "simplify", "review",
                       "normalize_review", "wait_review_rate_limit", "rework"):
            with self.subTest(source=source):
                self.assert_route(source, "failed", {}, "fail", "", 0)

    def test_each_timed_node_declares_its_timeout(self):
        expected = {
            "setup_helpers": "5m",
            "prepare": "10m",
            "diagnose": "2m",
            "baseline": "10m",
            "implement": "45m",
            "check": "5m",
            "simplify": "30m",
            "review": "30m",
            "publish": "15m",
        }
        for node, timeout in expected.items():
            with self.subTest(node=node):
                self.assertIn('timeout="%s"' % timeout, node_block(self.graph, node))
        self.assertIn('stall_timeout="60m"', self.graph)

    def test_conditional_edges_precede_the_unconditional_fallback(self):
        edges = parse_edges(self.graph)
        sources = {edge["source"] for edge in edges}
        for source in sources:
            with self.subTest(source=source):
                group = [edge for edge in edges if edge["source"] == source]
                fallbacks = [index for index, edge in enumerate(group)
                             if not edge["condition"]]
                if fallbacks:
                    self.assertEqual(
                        fallbacks, [len(group) - 1],
                        "unconditional fallback must be last for %s" % source)

    @staticmethod
    def _git(cwd, *args):
        result = subprocess.run(
            ["git", *args], cwd=cwd, capture_output=True, text=True, env=GIT_ENV)
        if result.returncode:
            raise AssertionError("git %s failed: %s" % (
                " ".join(args), result.stderr))
        return result.stdout.strip()


if __name__ == "__main__":
    unittest.main()
