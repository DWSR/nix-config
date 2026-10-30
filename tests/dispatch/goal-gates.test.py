import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro/workflows/dispatch/workflow.fabro"

RESERVED = {"graph", "node", "edge", "subgraph"}
NODE_START = re.compile(r"(?m)^\s*([A-Za-z_]\w*)\s*\[")
EDGE = re.compile(r"(?m)^\s*([A-Za-z_]\w*)\s*->\s*([A-Za-z_]\w*)")
GOAL_GATE = re.compile(r"\bgoal_gate\s*=\s*true\b")


def node_blocks(text: str) -> dict[str, str]:
    """Return each declared node id mapped to its attribute text."""
    blocks: dict[str, str] = {}
    for match in NODE_START.finditer(text):
        depth = 1
        quote = False
        escaped = False
        index = match.end()
        while index < len(text) and depth:
            char = text[index]
            if quote:
                if escaped:
                    escaped = False
                elif char == "\\":
                    escaped = True
                elif char == '"':
                    quote = False
            elif char == '"':
                quote = True
            elif char == "[":
                depth += 1
            elif char == "]":
                depth -= 1
            index += 1
        if depth:
            raise AssertionError(f"unterminated block for {match.group(1)}")
        blocks[match.group(1)] = text[match.end() : index - 1]
    return blocks


def dominators(nodes: set[str], edges: list[tuple[str, str]], start: str) -> dict[str, set[str]]:
    predecessors = {node: set() for node in nodes}
    for source, target in edges:
        predecessors[target].add(source)
    dom = {node: set(nodes) for node in nodes}
    dom[start] = {start}
    changed = True
    while changed:
        changed = False
        for node in nodes:
            if node == start:
                continue
            if predecessors[node]:
                reachable = set.intersection(*(dom[pred] for pred in predecessors[node]))
            else:
                reachable = set()
            updated = {node} | reachable
            if updated != dom[node]:
                dom[node] = updated
                changed = True
    return dom


class DispatchGoalGateTests(unittest.TestCase):
    def setUp(self) -> None:
        text = WORKFLOW.read_text()
        blocks = node_blocks(text)
        self.blocks = {name: body for name, body in blocks.items() if name not in RESERVED}
        self.edges = [(source, target) for source, target in EDGE.findall(text)]
        self.nodes = (
            set(self.blocks)
            | {source for source, _ in self.edges}
            | {target for _, target in self.edges}
        ) - RESERVED

    def test_every_goal_gate_runs_on_every_path_to_exit(self) -> None:
        # Fabro checks every declared goal gate when a run reaches exit, and a
        # gate that was never visited counts as unsatisfied. A gate on a node
        # that only some paths visit therefore fails otherwise healthy runs
        # (Fabro's synthetic "Goal check" routes nowhere and the run fails).
        goal_gates = {
            name for name, body in self.blocks.items() if GOAL_GATE.search(body)
        }
        self.assertIn("start", self.nodes)
        self.assertIn("exit", self.nodes)

        dom = dominators(self.nodes, self.edges, "start")
        unreachable_gates = sorted(goal_gates - dom["exit"])
        self.assertEqual(
            unreachable_gates,
            [],
            "goal gates must be visited on every path to exit; "
            f"these can be skipped: {unreachable_gates}",
        )

    def test_fail_stage_terminates_the_run_on_failure(self) -> None:
        # `fail` only runs on failure paths, so it must not be a goal gate.
        # Its nonzero exit has to end the run directly: with the default
        # on_failure="route" its unconditional edge hands the failed outcome to
        # exit, which records the run as succeeded and hides the failure.
        fail = self.blocks["fail"]
        self.assertNotRegex(fail, GOAL_GATE)
        self.assertRegex(fail, r'\bon_failure\s*=\s*"exit"')


if __name__ == "__main__":
    unittest.main()
