import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".fabro" / "workflows" / "oneshot" / "workflow.fabro"
SCHEMA = ROOT / ".fabro" / "workflows" / "oneshot" / "schemas" / "review-result.schema.json"
NORMALIZER = ROOT / ".fabro" / "workflows" / "oneshot" / "scripts" / "normalize_review.py"

VERDICTS = ("APPROVED", "REJECTED", "BLOCKED")
FAILURE_CLASSES = ("none", "network", "rate_limit", "baseline", "code", "environment")
VALID_CHECK = {"command": "pytest", "status": "PASS", "baseline_status": "not run", "reason": ""}
VALID_CHECKS = {"tests": VALID_CHECK}


def normalize(payload):
    return subprocess.run(
        [sys.executable, str(NORMALIZER)],
        input=json.dumps(payload),
        capture_output=True,
        text=True,
    )


class OneshotReviewResultTests(unittest.TestCase):
    def test_shared_schema_and_agent_nodes(self):
        schema = json.loads(SCHEMA.read_text())
        graph = WORKFLOW.read_text()
        self.assertEqual(schema["properties"]["verdict"]["enum"], list(VERDICTS))
        self.assertEqual(schema["properties"]["failure_class"]["enum"], list(FAILURE_CLASSES))

        check_schema = schema["properties"]["check_results"]["additionalProperties"]
        self.assertEqual(check_schema["required"], list(VALID_CHECK))
        self.assertEqual(set(check_schema["properties"]), set(VALID_CHECK))
        for node in ("implement", "simplify", "review"):
            with self.subTest(node=node):
                block = graph.split("    %s [" % node, 1)[1].split("\n    ]", 1)[0]
                self.assertIn('output_schema="@schemas/review-result.schema.json"', block)
                self.assertIn("output_retries=2", block)

    def test_routing_covers_every_enum_value_with_exact_conditions(self):
        graph = WORKFLOW.read_text()
        for verdict in VERDICTS:
            with self.subTest(verdict=verdict):
                self.assertIn("context.verdict=%s" % verdict, graph)
        for failure_class in FAILURE_CLASSES:
            with self.subTest(failure_class=failure_class):
                if failure_class != "code":
                    self.assertIn("context.failure_class=%s" % failure_class, graph)
        self.assertNotIn("failure_class contains", graph)
        self.assertIn("normalize_review -> publish [condition=\"outcome=succeeded && context.verdict=APPROVED && context.failure_class=none\"]", graph)
        self.assertIn("normalize_review -> rework [condition=\"outcome=failed && context.verdict=REJECTED\"]", graph)
        self.assertIn("normalize_review -> wait_review_rate_limit [condition=\"outcome=failed && context.failure_class=rate_limit\", weight=10]", graph)
        self.assertIn("normalize_review -> fail [condition=\"outcome=failed && context.failure_class=network\"]", graph)
        self.assertIn("normalize_review -> fail [condition=\"outcome=failed && context.failure_class=baseline\"]", graph)
        self.assertIn("normalize_review -> fail [condition=\"outcome=failed && context.failure_class=environment\"]", graph)
        self.assertIn("normalize_review -> fail [condition=\"outcome=failed && context.verdict=BLOCKED\"]", graph)
        self.assertIn("review -> normalize_review [condition=\"outcome=succeeded || outcome=failed\"]", graph)


    def test_normalizer_preserves_updates_and_sets_typed_routing_fields(self):
        payload = {
            "outcome": "failed",
            "verdict": "REJECTED",
            "failure_class": "code",
            "check_results": {"tests": {"command": "pytest", "status": "FAIL", "baseline_status": "PASS", "reason": "test failed"}},
            "failure_reason": "test failed",
            "context_updates": {"review_findings": "fix this", "review_remediation": "change this", "stage_failure": "finding"},
        }
        result = normalize(payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {
            "outcome": "failed",
            "failure_reason": "test failed",
            "context_updates": {
                "review_findings": "fix this",
                "review_remediation": "change this",
                "stage_failure": "finding",
                "verdict": "REJECTED",
                "failure_class": "code",
            },
        })

    def test_normalizer_accepts_all_enum_values_in_valid_pairs(self):
        cases = [("succeeded", "APPROVED", "none")]
        cases.append(("failed", "REJECTED", "code"))
        cases.extend(("failed", "BLOCKED", failure) for failure in ("network", "rate_limit", "baseline", "environment"))
        for outcome, verdict, failure_class in cases:
            with self.subTest(outcome=outcome, verdict=verdict, failure_class=failure_class):
                payload = {
                    "outcome": outcome,
                    "verdict": verdict,
                    "failure_class": failure_class,
                    "check_results": VALID_CHECKS,
                    "failure_reason": "blocked" if outcome == "failed" else None,
                    "context_updates": (
                        {"impl_status": "READY"} if outcome == "succeeded"
                        else {"review_findings": "finding", "review_remediation": "fix", "stage_failure": "blocked"}
                        if verdict == "REJECTED" else {"stage_failure": "blocked"}
                    ),
                }
                result = normalize(payload)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_normalizer_preserves_implement_status(self):
        payload = {
            "outcome": "succeeded",
            "verdict": "APPROVED",
            "failure_class": "none",
            "check_results": VALID_CHECKS,
            "context_updates": {"impl_status": "READY", "impl_summary": "done"},
        }
        result = normalize(payload)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["context_updates"]["impl_status"], "READY")

    def test_normalizer_rejects_invalid_fields_before_routing(self):
        for field, value in (("verdict", "APPROVE"), ("failure_class", "net")):
            with self.subTest(field=field):
                payload = {
                    "outcome": "succeeded",
                    "verdict": "APPROVED",
                    "failure_class": "none",
                    "check_results": VALID_CHECKS,
                    "context_updates": {},
                }
                payload[field] = value
                result = normalize(payload)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("invalid %s" % field, result.stderr)

    def test_normalizer_rejects_valid_enums_with_inconsistent_outcome(self):
        payload = {
            "outcome": "succeeded",
            "verdict": "REJECTED",
            "failure_class": "code",
            "check_results": VALID_CHECKS,
            "context_updates": {"impl_status": "READY"},
        }
        result = normalize(payload)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("successful stage output", result.stderr)

    def test_normalizer_rejects_invalid_failure_class_for_verdict(self):
        payload = {
            "outcome": "failed",
            "verdict": "REJECTED",
            "failure_class": "network",
            "check_results": VALID_CHECKS,
            "failure_reason": "blocked",
            "context_updates": {"stage_failure": "blocked"},
        }
        result = normalize(payload)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must use failure_class code", result.stderr)

    def test_normalizer_requires_failure_diagnostics(self):
        payload = {
            "outcome": "failed",
            "verdict": "BLOCKED",
            "failure_class": "environment",
            "check_results": {"build": {"command": "nix build", "status": "BLOCKED", "baseline_status": "not run", "reason": "unavailable"}},
            "context_updates": {},
        }
        result = normalize(payload)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("failure_reason", result.stderr)

    def test_normalizer_rejects_incomplete_check_result(self):
        payload = {
            "outcome": "succeeded",
            "verdict": "APPROVED",
            "failure_class": "none",
            "check_results": {"tests": {"command": "pytest"}},
            "context_updates": {},
        }
        result = normalize(payload)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("invalid check_results", result.stderr)


if __name__ == "__main__":
    unittest.main()
