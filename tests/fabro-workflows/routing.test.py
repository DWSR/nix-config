import contextlib
import importlib
import io
import json
import pathlib
import re
import sys
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot" / "workflow.fabro"
TOOLS_DIR = ROOT / ".fabro" / "workflows" / "oneshot" / "scripts"
sys.path.insert(0, str(TOOLS_DIR))
tools = importlib.import_module("tools")

EDGE_RE = re.compile(
    r'^\s*(\w+)\s*->\s*(\w+)(?:\s+\[condition="([^"]+)"(?:,\s*weight=\d+)?\])?\s*$'
)
TERM_RE = re.compile(r"^([\w.]+)\s*(contains|<=|>=|=|>|<)\s*([\w-]+)$")


def load_edges():
    edges = []
    for line in WORKFLOW.read_text().splitlines():
        match = EDGE_RE.match(line)
        if match:
            edges.append((match.group(1), match.group(2), match.group(3)))
    return edges


def condition_matches(condition, values):
    if condition is None:
        return True
    for term in condition.split(" && "):
        match = TERM_RE.fullmatch(term)
        if not match:
            raise AssertionError("unsupported routing condition: %s" % term)
        key, operator, expected = match.groups()
        actual = values.get(key)
        if operator == "contains":
            matched = expected in str(actual or "")
        elif operator == "=":
            matched = str(actual) == expected
        else:
            left, right = int(actual), int(expected)
            matched = {"<": left < right, "<=": left <= right,
                       ">": left > right, ">=": left >= right}[operator]
        if not matched:
            return False
    return True


def route_from(stage, values, edges):
    path = []
    visits = {}
    for _ in range(8):
        stage_values = values.get(stage, values)
        if isinstance(stage_values, list):
            visit = visits.get(stage, 0)
            stage_values = stage_values[min(visit, len(stage_values) - 1)]
            visits[stage] = visit + 1
        edge = next(
            ((source, target, condition) for source, target, condition in edges
             if source == stage and condition_matches(condition, stage_values)),
            None,
        )
        if edge is None:
            return path
        stage = edge[1]
        path.append(stage)
    raise AssertionError("routing graph contains a cycle while evaluating %s" % path)


class OneshotRoutingTests(unittest.TestCase):
    def test_failure_routing_matrix(self):
        edges = load_edges()
        cases = (
            ("network failure", "review", {"outcome": "failed", "context.failure_class": "network"},
             "fail", 'outcome=failed && context.failure_class contains network', ["fail"]),
            ("blocked review", "review", {"outcome": "failed", "context.verdict": "BLOCKED"},
             "fail", "outcome=failed && context.verdict=BLOCKED", ["fail"]),
            ("baseline-red review", "review", {"outcome": "succeeded", "context.verdict": "APPROVED",
                                                   "context.baseline_red": "true"},
             "publish", "outcome=succeeded && context.verdict=APPROVED", ["publish", "exit"]),
            ("review rate limit", "review", {"outcome": "failed", "context.failure_class": "rate_limit",
                                                "wait_review_rate_limit": {"outcome": "succeeded"},
                                                "review": [{"outcome": "failed", "context.failure_class": "rate_limit"},
                                                           {"outcome": "succeeded", "context.verdict": "APPROVED"}]},
             "wait_review_rate_limit", "outcome=failed && context.failure_class contains rate_limit",
             ["wait_review_rate_limit", "review", "publish", "exit"]),
            ("rework exhausted", "rework", {"outcome": "succeeded", "context.rework_round": "3"},
             "salvage", "outcome=succeeded && context.rework_round > 2", ["salvage", "exit"]),
            ("closed issue", "prepare", {"outcome": "succeeded", "context.issue_open": "false"},
             "skip", "outcome=succeeded && context.issue_open=false", ["skip", "finish", "exit"]),
            ("review timeout", "review", {"outcome": "failed", "context.failure_class": "timeout"},
             "fail", "outcome=failed && context.failure_class contains timeout", ["fail"]),
        )

        for name, source, values, target, condition, expected_path in cases:
            with self.subTest(path=name):
                edge_index = next(
                    (index for index, edge in enumerate(edges)
                     if edge == (source, target, condition)),
                    None,
                )
                self.assertIsNotNone(edge_index, "missing edge or condition: %s -> %s [%s]" % (
                    source, target, condition))
                self.assertEqual(route_from(source, values, edges), expected_path)
                if source == "review" and values.get("context.failure_class") in ("network", "timeout"):
                    self.assertLess(edge_index, next(i for i, edge in enumerate(edges)
                                                     if edge[0] == "review" and edge[1] == "rework"))

    def test_closed_issue_prepare_returns_skip_context(self):
        issue = {"number": 385, "title": "closed", "state": "closed"}
        output = io.StringIO()
        with mock.patch.object(tools, "origin_repo", return_value=("example", "repo")), \
             mock.patch.object(tools, "gh", return_value=(200, issue)) as github, \
             contextlib.redirect_stdout(output):
            tools.prepare(["385"])

        self.assertEqual(github.call_count, 1)
        self.assertEqual(
            json.loads(output.getvalue()),
            {"context_updates": {"issue_open": "false"}},
        )


if __name__ == "__main__":
    unittest.main()
