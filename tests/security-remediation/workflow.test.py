import pathlib
import re
import tomllib
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
PACKAGE = ROOT / ".fabro" / "workflows" / "security-remediation"
WORKFLOW_FABRO = PACKAGE / "workflow.fabro"
WORKFLOW_TOML = PACKAGE / "workflow.toml"
VERIFY_PROMPT = PACKAGE / "prompts" / "verify.md"

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


def normalized(text: str) -> str:
    return re.sub(r"\s+", " ", text)


class SecurityRemediationGraphTests(unittest.TestCase):
    def setUp(self) -> None:
        text = WORKFLOW_FABRO.read_text()
        blocks = node_blocks(text)
        self.blocks = {name: body for name, body in blocks.items() if name not in RESERVED}
        self.edges = [(source, target) for source, target in EDGE.findall(text)]
        self.nodes = (
            set(self.blocks)
            | {source for source, _ in self.edges}
            | {target for _, target in self.edges}
        ) - RESERVED
        self.goal_gates = {
            name for name, body in self.blocks.items() if GOAL_GATE.search(body)
        }

    def test_prepare_is_the_only_goal_gate(self) -> None:
        self.assertIn("prepare", self.blocks)
        self.assertEqual(self.goal_gates, {"prepare"})

    def test_the_goal_gate_runs_on_every_path_to_exit(self) -> None:
        # Fabro evaluates every declared goal gate when a run reaches exit and
        # treats a gate it never visited as unsatisfied. The remediation graph
        # must therefore keep its only gate on a node that dominates exit, or a
        # healthy closed-alert or failure path fails its synthetic goal check.
        self.assertIn("start", self.nodes)
        self.assertIn("exit", self.nodes)
        dom = dominators(self.nodes, self.edges, "start")
        unreachable_gates = sorted(self.goal_gates - dom["exit"])
        self.assertEqual(
            unreachable_gates,
            [],
            "goal gates must be visited on every path to exit; "
            f"these can be skipped: {unreachable_gates}",
        )

    def test_fail_is_ungated_and_ends_the_run(self) -> None:
        # `fail` only runs on failure paths, so it must stay ungated. Its
        # nonzero exit has to end the run directly: with the default
        # on_failure="route" the failed outcome would reach exit and the run
        # would be recorded as succeeded.
        self.assertIn("fail", self.blocks)
        self.assertNotRegex(self.blocks["fail"], GOAL_GATE)
        self.assertRegex(self.blocks["fail"], r'\bon_failure\s*=\s*"exit"')

    def test_fail_is_not_on_every_path_to_exit(self) -> None:
        dom = dominators(self.nodes, self.edges, "start")
        self.assertNotIn("fail", dom["exit"])


class CheckpointAndPullRequestConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        with WORKFLOW_TOML.open("rb") as handle:
            self.config = tomllib.load(handle)

    def test_the_package_declares_the_graph_under_test(self) -> None:
        self.assertEqual(self.config["workflow"]["graph"], "workflow.fabro")
        self.assertTrue(WORKFLOW_FABRO.is_file())

    def test_run_branch_checkpoints_are_disabled(self) -> None:
        # Fabro checkpoint commits run `git add -A` + `git commit` on HEAD,
        # which here is the remediation branch, and would break the
        # single-commit publish invariant.
        self.assertIs(self.config["run"]["run_branch"]["enabled"], False)

    def test_the_workflow_owned_pull_request_is_disabled(self) -> None:
        # The publish stage owns branch naming and pull-request creation, so
        # Fabro must not open a second pull request of its own.
        self.assertIs(self.config["run"]["pull_request"]["enabled"], False)


class VerifyPromptExclusionTests(unittest.TestCase):
    def test_keeps_the_darwin_only_exclusions(self) -> None:
        text = normalized(VERIFY_PROMPT.read_text())
        for expected in (
            "nix flake check --all-systems",
            "checks.aarch64-darwin",
            "platform mismatch",
            "Required system: 'aarch64-darwin'",
            "aarch64-darwin",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, text)

    def test_keeps_the_excluded_convention(self) -> None:
        text = normalized(VERIFY_PROMPT.read_text())
        self.assertIn("excluded: <command> (<environment cause>)", text)
        self.assertIn("Excluded checks never produce `tests_passed=false`", text)
        self.assertIn("never consume a rework round", text)


if __name__ == "__main__":
    unittest.main()
