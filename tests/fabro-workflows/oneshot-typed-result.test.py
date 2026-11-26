import contextlib
import io
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot"
TOOLS = WORKFLOW / "scripts" / "tools.py"
GRAPH = WORKFLOW / "workflow.fabro"
SCHEMA = WORKFLOW / "schemas" / "stage-result.schema.json"
SCHEMA_REF = "@schemas/stage-result.schema.json"
STAGES = ("implement", "simplify", "review")


def load_tools():
    namespace = {"__name__": "oneshot_typed_result_test"}
    exec(compile(TOOLS.read_text(), str(TOOLS), "exec"), namespace)
    return namespace


def node_block(graph, node):
    match = re.search(r"(?ms)^    %s \[\n.*?^    \]" % re.escape(node), graph)
    if match is None:
        raise AssertionError("node %s is missing" % node)
    return match.group()


def fabro_context(updates):
    # Fabro stores the reserved context value "none" as an empty string before
    # routing (verified against Fabro 0.414.0). Model that here so the routing
    # assertions exercise the same values the engine sees.
    return {
        key: "" if str(value) == "none" else str(value)
        for key, value in updates.items()
    }


def stage_context(stage, verdict, failure_class):
    tools = load_tools()
    payload = {"verdict": verdict, "failure_class": failure_class,
               "check_results": {}}
    self_error = tools["stage_result_error"](stage, payload)
    if self_error:
        raise AssertionError(self_error)
    return fabro_context(tools["normalize_stage_result"](stage, payload))


def stage_routes(graph, stage):
    pattern = re.compile(
        r'normalize_%s -> (\w+) \[condition="([^"]+)"(?:, weight=(\d+))?\]'
        % re.escape(stage))
    return [
        (target, condition, int(weight or 0))
        for target, condition, weight in pattern.findall(graph)
    ]


def condition_matches(condition, context):
    for clause in condition.split(" && "):
        clause = clause.strip()
        if clause.startswith("outcome="):
            continue
        key, sep, value = clause.partition("!=")
        if sep:
            if context.get(key[len("context."):]) == value:
                return False
            continue
        key, _sep, value = clause.partition("=")
        if context.get(key[len("context."):]) != value:
            return False
    return True


def stage_target(graph, stage, verdict, failure_class):
    context = stage_context(stage, verdict, failure_class)
    candidates = []
    for target, condition, weight in stage_routes(graph, stage):
        if condition_matches(condition, context):
            candidates.append((weight, target))
    if not candidates:
        return "fail"
    return sorted(candidates, key=lambda item: (-item[0], item[1]))[0][1]


class SchemaTests(unittest.TestCase):
    def setUp(self):
        self.schema = json.loads(SCHEMA.read_text())

    def test_verdict_and_failure_class_enums(self):
        properties = self.schema["properties"]
        self.assertEqual(
            properties["verdict"]["enum"], ["APPROVED", "REJECTED", "BLOCKED"])
        self.assertEqual(
            properties["failure_class"]["enum"],
            ["none", "network", "rate_limit", "baseline", "code", "environment"])

    def test_check_results_carry_the_required_fields(self):
        check_results = self.schema["properties"]["check_results"]
        self.assertEqual(check_results["type"], "object")
        check = check_results["additionalProperties"]
        self.assertEqual(
            sorted(check["required"]),
            ["baseline_status", "command", "reason", "status"])
        self.assertIn("passed", check["properties"]["status"]["enum"])
        self.assertIn("not_recorded", check["properties"]["baseline_status"]["enum"])

    def test_every_typed_stage_uses_the_schema_with_output_retries(self):
        graph = GRAPH.read_text()
        for stage in STAGES:
            with self.subTest(stage=stage):
                block = node_block(graph, stage)
                self.assertIn('output_schema="%s"' % SCHEMA_REF, block)
                retries = re.search(r"output_retries=(\d+)", block)
                self.assertIsNotNone(retries, "output_retries is missing from %s" % stage)
                self.assertGreaterEqual(int(retries.group(1)), 2)

    def test_each_typed_stage_normalizes_before_routing(self):
        graph = GRAPH.read_text()
        for stage in STAGES:
            with self.subTest(stage=stage):
                block = node_block(graph, "normalize_" + stage)
                self.assertIn('output_schema="routing"', block)
                self.assertIn('stdin_source="context.output.%s"' % stage, block)
                self.assertIn("tools.py normalize %s" % stage, block)
                self.assertIn('%s -> normalize_%s [condition="outcome=succeeded"]' % (
                    stage, stage), graph)
                self.assertIn("%s -> fail" % stage, graph)
                self.assertIn("normalize_%s -> fail" % stage, graph)


class RoutingTests(unittest.TestCase):
    def test_every_verdict_has_an_exact_route(self):
        graph = GRAPH.read_text()
        self.assertEqual(stage_target(graph, "review", "APPROVED", "none"),
                         "publish")
        self.assertEqual(stage_target(graph, "review", "REJECTED", "code"),
                         "rework")
        self.assertEqual(stage_target(graph, "review", "BLOCKED", "code"),
                         "salvage")

    def test_every_failure_class_has_an_exact_route(self):
        graph = GRAPH.read_text()
        routes = {
            "none": ("APPROVED", "publish"),
            "network": ("BLOCKED", "salvage"),
            "rate_limit": ("BLOCKED", "wait_review_rate_limit"),
            "baseline": ("BLOCKED", "salvage"),
            "code": ("REJECTED", "rework"),
            "environment": ("BLOCKED", "salvage"),
        }
        self.assertEqual(
            sorted(routes), sorted(json.loads(SCHEMA.read_text())["properties"]
                                   ["failure_class"]["enum"]))
        for failure_class, (verdict, expected) in routes.items():
            with self.subTest(failure_class=failure_class):
                self.assertEqual(
                    stage_target(graph, "review", verdict, failure_class),
                    expected)

    def test_implement_and_simplify_route_on_their_own_status(self):
        graph = GRAPH.read_text()
        for stage in ("implement", "simplify"):
            with self.subTest(stage=stage):
                waiter = "wait_%s_rate_limit" % stage
                self.assertEqual(
                    stage_target(graph, stage, "APPROVED", "none"), "check")
                self.assertEqual(
                    stage_target(graph, stage, "BLOCKED", "rate_limit"), waiter)
        # The implement node salvages blocked runs; simplify keeps its existing
        # fail path.
        self.assertEqual(
            stage_target(graph, "implement", "BLOCKED", "environment"),
            "salvage")
        self.assertEqual(
            stage_target(graph, "simplify", "BLOCKED", "environment"), "fail")

    def test_routing_avoids_the_reserved_none_context_value(self):
        graph = GRAPH.read_text()
        # Fabro rewrites `context.failure_class=none` to an empty value, so a
        # route on that literal would never match. The normalize stage mirrors
        # the success case into `failure_class_ok` instead.
        self.assertNotIn("failure_class=none", graph)
        self.assertIn("context.failure_class_ok=true", graph)
        updates = stage_context("review", "APPROVED", "none")
        self.assertEqual(updates["failure_class"], "")
        self.assertEqual(updates["failure_class_ok"], "true")
        updates = stage_context("review", "BLOCKED", "network")
        self.assertEqual(updates["failure_class"], "network")
        self.assertEqual(updates["failure_class_ok"], "false")

    def test_conditions_match_exact_enum_values_instead_of_prose(self):
        graph = GRAPH.read_text()
        for fragment in (
            "context.verdict=APPROVED",
            "context.verdict=REJECTED",
            "context.verdict=BLOCKED",
            "context.failure_class_ok=true",
            "context.failure_class=network",
            "context.failure_class=rate_limit",
            "context.failure_class=environment",
        ):
            with self.subTest(fragment=fragment):
                self.assertIn(fragment, graph)
        self.assertNotIn(" contains ", graph)
        failure_classes = json.loads(
            SCHEMA.read_text())["properties"]["failure_class"]["enum"]
        self.assertIn("baseline", failure_classes)
        self.assertIn("code", failure_classes)

    def test_rate_limit_routes_every_stage_to_its_waiter(self):
        graph = GRAPH.read_text()
        self.assertIn(
            'normalize_implement -> wait_implement_rate_limit [condition="context.failure_class=rate_limit", weight=10]',
            graph)
        self.assertIn(
            'normalize_simplify -> wait_simplify_rate_limit [condition="context.failure_class=rate_limit", weight=10]',
            graph)
        self.assertIn(
            'normalize_review -> wait_review_rate_limit [condition="context.failure_class=rate_limit", weight=10]',
            graph)


class NormalizeTests(unittest.TestCase):
    def payload(self, **overrides):
        payload = {
            "verdict": "APPROVED",
            "failure_class": "none",
            "check_results": {
                "typed result tests": {
                    "command": "python3 tests/fabro-workflows/oneshot-typed-result.test.py",
                    "status": "passed",
                    "baseline_status": "not_recorded",
                    "reason": "exit 0",
                },
            },
        }
        payload.update(overrides)
        return payload

    def test_every_verdict_and_failure_class_is_accepted(self):
        tools = load_tools()
        schema = json.loads(SCHEMA.read_text())
        for stage in STAGES:
            for verdict in schema["properties"]["verdict"]["enum"]:
                for failure_class in schema["properties"]["failure_class"]["enum"]:
                    with self.subTest(stage=stage, verdict=verdict,
                                      failure_class=failure_class):
                        payload = self.payload(
                            verdict=verdict, failure_class=failure_class)
                        self.assertEqual(tools["stage_result_error"](stage, payload), "")
                        updates = tools["normalize_stage_result"](stage, payload)
                        self.assertEqual(updates["verdict"], verdict)
                        self.assertEqual(updates["failure_class"], failure_class)
                        self.assertEqual(
                            updates["failure_class_ok"],
                            "true" if failure_class == "none" else "false")
                        if stage in ("implement", "simplify"):
                            self.assertEqual(
                                updates["impl_status"],
                                "READY" if verdict == "APPROVED" else "BLOCKED")

    def test_invalid_verdict_failure_class_and_check_results_are_rejected(self):
        tools = load_tools()
        invalid = (
            self.payload(verdict="APPROVE"),
            self.payload(verdict="approved"),
            self.payload(verdict=""),
            self.payload(verdict=None),
            self.payload(failure_class="NETWORK"),
            self.payload(failure_class=""),
            self.payload(failure_class=None),
            self.payload(check_results=[]),
            self.payload(check_results={"x": {"command": "x", "status": "passed",
                                              "baseline_status": "passed"}}),
            self.payload(check_results={"x": {"command": "x", "status": "nope",
                                              "baseline_status": "passed",
                                              "reason": ""}}),
            self.payload(check_results={"x": {"command": "x", "status": "passed",
                                              "baseline_status": "nope",
                                              "reason": ""}}),
        )
        for payload in invalid:
            with self.subTest(payload=payload):
                self.assertNotEqual(
                    tools["stage_result_error"]("review", payload), "")

    def test_routeable_stage_failure_is_generated_for_non_approvals(self):
        tools = load_tools()
        updates = tools["normalize_stage_result"](
            "review", self.payload(verdict="BLOCKED", failure_class="network"))
        self.assertIn("network", updates["stage_failure"])

        approved = tools["normalize_stage_result"](
            "review", self.payload(verdict="APPROVED", failure_class="none"))
        self.assertEqual(approved["stage_failure"], "")

    def test_cli_emits_routing_and_writes_the_review_record(self):
        tools = load_tools()
        payload = self.payload(
            verdict="REJECTED",
            failure_class="code",
            stage_failure="review: one blocking defect",
            review_findings="1. tools.py hides the verdict",
            review_remediation="1. include the typed verdict",
        )
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))), \
                        contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["normalize"](["review"])
                report = json.loads(output.getvalue().strip().splitlines()[-1])
                record = json.loads(
                    pathlib.Path(".git/oneshot-review.json").read_text())
            finally:
                os.chdir(previous)

        self.assertEqual(report["outcome"], "succeeded")
        self.assertEqual(report["context_updates"]["verdict"], "REJECTED")
        self.assertEqual(report["context_updates"]["failure_class"], "code")
        self.assertEqual(report["context_updates"]["stage_failure"],
                         "review: one blocking defect")
        self.assertEqual(record["stage"], "review")
        self.assertEqual(record["verdict"], "REJECTED")
        self.assertEqual(record["review_findings"],
                         "1. tools.py hides the verdict")

    def test_cli_accepts_a_double_encoded_context_value(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with mock.patch.object(
                        sys, "stdin", io.StringIO(json.dumps(json.dumps(self.payload())))), \
                        contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    tools["normalize"](["implement"])
            finally:
                os.chdir(previous)
        report = json.loads(output.getvalue().strip().splitlines()[-1])
        self.assertEqual(report["context_updates"]["impl_status"], "READY")

    def test_cli_dispatches_normalize(self):
        with tempfile.TemporaryDirectory() as tmp:
            script = pathlib.Path(tmp, "tools.py")
            script.write_text(TOOLS.read_text())
            pathlib.Path(tmp, ".git").mkdir()
            result = subprocess.run(
                [os.environ.get("PYTHON", "python3"), str(script),
                 "normalize", "implement"],
                cwd=tmp, input=json.dumps(self.payload()),
                capture_output=True, text=True,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report["outcome"], "succeeded")
        self.assertEqual(report["context_updates"]["impl_status"], "READY")

    def test_cli_rejects_invalid_verdict_without_emitting_routing(self):
        tools = load_tools()
        with tempfile.TemporaryDirectory() as tmp:
            os.makedirs(os.path.join(tmp, ".git"))
            previous = os.getcwd()
            os.chdir(tmp)
            try:
                output = io.StringIO()
                with mock.patch.object(
                        sys, "stdin",
                        io.StringIO(json.dumps(self.payload(verdict="APPROVE")))), \
                        contextlib.redirect_stdout(output), \
                        contextlib.redirect_stderr(io.StringIO()):
                    with self.assertRaises(SystemExit) as caught:
                        tools["normalize"](["review"])
            finally:
                os.chdir(previous)

        self.assertIn("invalid verdict", str(caught.exception))
        self.assertEqual(output.getvalue().strip(), "")


if __name__ == "__main__":
    unittest.main()
