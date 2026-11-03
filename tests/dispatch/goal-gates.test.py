import pathlib
import re
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro/workflows/dispatch/workflow.fabro"

RESERVED = {"graph", "node", "edge", "subgraph"}
NODE_START = re.compile(r"(?m)^\s*([A-Za-z_]\w*)\s*\[")
EDGE_LINE = re.compile(
    r"(?m)^[ \t]*([A-Za-z_]\w*(?:[ \t]*->[ \t]*[A-Za-z_]\w*)+)[ \t]*"
    r"(?:\[(.*)\])?[ \t]*$"
)
GOAL_GATE = re.compile(r"\bgoal_gate\s*=\s*true\b")
ON_FAILURE_EXIT = re.compile(r'\bon_failure\s*=\s*"exit"')


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


def edges(text: str) -> list[tuple[str, str, str]]:
    """Return (source, target, attributes) for every edge, chains expanded.

    Chained declarations like ``start -> prepare -> scan`` expand to one edge
    per hop, all sharing the declaration's attributes.
    """
    result: list[tuple[str, str, str]] = []
    for match in EDGE_LINE.finditer(text):
        chain = [part.strip() for part in match.group(1).split("->")]
        attrs = match.group(2) or ""
        result.extend((source, target, attrs) for source, target in zip(chain, chain[1:]))
    return result


class DispatchGoalGateTests(unittest.TestCase):
    def setUp(self) -> None:
        text = WORKFLOW.read_text()
        self.blocks = {
            name: body for name, body in node_blocks(text).items() if name not in RESERVED
        }
        self.edges = edges(text)

    def outgoing(self, name: str) -> list[tuple[str, str]]:
        return [(target, attrs) for source, target, attrs in self.edges if source == name]

    def test_dispatch_declares_no_goal_gates(self) -> None:
        # Fabro checks every declared goal gate when a run reaches exit and
        # fails the run when a gate ended failed/skipped or was never visited.
        # A gate on a success path therefore recorded fully successful dispatch
        # runs as failed at the synthetic goal check (#185, #187). Dispatch
        # needs no gate: the exit wiring below already makes a successful exit
        # imply that every stage succeeded.
        goal_gates = sorted(
            name for name, body in self.blocks.items() if GOAL_GATE.search(body)
        )
        self.assertEqual(goal_gates, [])

    def test_exit_is_only_wired_from_a_successful_prune(self) -> None:
        # A stage failure must never hand a route to exit: reaching exit is
        # what turns the run into a success.
        incoming = [
            (source, attrs) for source, target, attrs in self.edges if target == "exit"
        ]
        self.assertEqual([source for source, _ in incoming], ["prune"])
        condition = re.search(r'condition\s*=\s*"([^"]*)"', incoming[0][1])
        self.assertIsNotNone(condition)
        self.assertIn("outcome=succeeded", condition.group(1))

    def test_fail_stage_terminates_the_run_on_failure(self) -> None:
        # `fail` only runs on failure paths, so it must stay ungated and keep
        # no route onwards. Its nonzero exit has to end the run directly: with
        # the default on_failure="route" the failed outcome would reach exit
        # and the run would be recorded as succeeded.
        fail = self.blocks["fail"]
        self.assertNotRegex(fail, GOAL_GATE)
        self.assertRegex(fail, ON_FAILURE_EXIT)
        self.assertIn('exit 1"', fail)
        self.assertEqual(self.outgoing("fail"), [])

    def test_every_stage_failure_ends_the_run(self) -> None:
        # No goal gate is needed only because no stage can fail and still let
        # the run continue: each stage either has an unconditional route to the
        # terminal `fail` node or ends the run itself with on_failure="exit".
        # This is what makes a reached exit mean "every stage succeeded".
        for name, body in self.blocks.items():
            if name in {"start", "exit", "fail"}:
                continue
            routed_to_fail = any(
                target == "fail" and "condition" not in attrs
                for target, attrs in self.outgoing(name)
            )
            self.assertTrue(
                routed_to_fail or ON_FAILURE_EXIT.search(body),
                f"{name} can fail without ending the run",
            )


if __name__ == "__main__":
    unittest.main()
