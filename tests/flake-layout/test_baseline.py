"""Contract tests for the pre-migration flake-layout baseline.

The baseline records the root selectors, registry/search-path aliases, CI
lanes and exclusions, representative pins, host wiring, and known runner
blockers before any area flake is introduced. ``baseline.py`` compares a
captured observation against that record: a removed selector or alias is a
failure, an added one is reported, and a check that cannot run in the current
runner context is recorded as a blocker rather than as a failure.

These tests are offline: they compare the committed baseline and small parity
fixtures and read repository files. The live capture is exercised by the
``flake-layout-baseline`` flake check, which passes an evaluated observation.
"""

import contextlib
import copy
import io
import json
import pathlib
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import baseline as B  # noqa: E402


def fixture(name):
    return json.loads((HERE / "fixtures" / name).read_text())


def baseline_fixture():
    baseline = fixture("minimal-baseline.json")
    baseline["inventory_sha256"] = B.inventory_hash(
        baseline["selectors"], baseline["registry"], baseline["host_wiring"]
    )
    return baseline


def observation_fixture():
    return fixture("minimal-observation.json")


class SelectorParityTests(unittest.TestCase):
    def test_matching_inventory_has_no_failures(self):
        report = B.compare(baseline_fixture(), observation_fixture())
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["status"], "ok")

    def test_missing_check_fails_by_kind_system_and_name(self):
        observation = observation_fixture()
        observation["selectors"]["checks"]["aarch64-linux"].remove("beta")
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")
        failure = next(f for f in report["failures"] if f.get("selector") == "beta")
        self.assertEqual(failure["kind"], "checks")
        self.assertEqual(failure["system"], "aarch64-linux")

    def test_missing_system_fails(self):
        observation = observation_fixture()
        observation["selectors"]["systems"].remove("aarch64-linux")
        observation["selectors"]["checks"] = {}
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(any(f["kind"] == "systems" for f in report["failures"]))

    def test_missing_flat_selector_fails(self):
        observation = observation_fixture()
        observation["selectors"]["overlays"].remove("shared")
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(
            any(f["kind"] == "overlays" and f.get("selector") == "shared" for f in report["failures"])
        )

    def test_added_selector_is_reported_as_an_unrecorded_baseline_failure(self):
        baseline = baseline_fixture()
        observation = observation_fixture()
        observation["selectors"]["checks"]["aarch64-linux"].append("gamma")
        report = B.compare(baseline, observation)
        self.assertEqual(report["status"], "failed")
        self.assertIn(
            {
                "kind": "checks",
                "system": "aarch64-linux",
                "selector": "gamma",
                "detail": "unrecorded live selector",
            },
            report["failures"],
        )

    def test_missing_registry_alias_fails(self):
        observation = observation_fixture()
        observation["registry"]["registry_names"].remove("self")
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(any(f["kind"] == "registry" for f in report["failures"]))

    def test_missing_search_path_target_fails(self):
        observation = observation_fixture()
        observation["registry"]["search_path_targets"].remove("/etc/nix/path/self")
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")

    def test_host_wiring_identity_change_fails(self):
        observation = observation_fixture()
        observation["host_wiring"]["personal_sops_age_key"] = "/tmp/other-key"
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["status"], "failed")

    def test_secret_runtime_mode_owner_and_path_are_compared_structurally(self):
        baseline = baseline_fixture()
        observation = observation_fixture()
        baseline["host_wiring"]["personal_sops_secrets"] = {
            "token": {"path": "/run/secrets/token", "owner": "root", "mode": "0400"}
        }
        observation["host_wiring"]["personal_sops_secrets"] = {
            "token": {"path": "/run/secrets/token", "owner": "root", "mode": "0444"}
        }
        report = B.compare(baseline, observation)
        self.assertEqual(report["status"], "failed")
        self.assertTrue(any(f["kind"] == "secret-wiring" for f in report["failures"]))

    def test_secret_addition_is_reported_without_exposing_secret_values(self):
        baseline = baseline_fixture()
        baseline.pop("inventory_sha256")
        observation = observation_fixture()
        baseline["host_wiring"]["personal_sops_secrets"] = {
            "old": {"path": "/run/secrets/old", "owner": "root", "mode": "0400"}
        }
        baseline["inventory_sha256"] = B.inventory_hash(
            baseline["selectors"], baseline["registry"], baseline["host_wiring"]
        )
        observation["host_wiring"]["personal_sops_secrets"] = {
            "old": {"path": "/run/secrets/old", "owner": "root", "mode": "0400"},
            "new": {"path": "/run/secrets/new", "owner": "root", "mode": "0400"},
        }
        report = B.compare(baseline, observation)
        self.assertEqual(report["failures"], [])
        self.assertIn(
            {"kind": "secret-wiring", "selector": "personal_sops_secrets.new"},
            report["additions"],
        )
        self.assertNotIn("secret value", json.dumps(report))

    def test_host_package_version_change_is_reported_not_failed(self):
        observation = observation_fixture()
        observation["host_wiring"]["personal_opencode_package"] = "opencode-2.0.0"
        report = B.compare(baseline_fixture(), observation)
        self.assertEqual(report["failures"], [])
        self.assertTrue(any(c["kind"] == "host_wiring" for c in report["changes"]))


class RunnerBlockerTests(unittest.TestCase):
    def test_recorded_blockers_are_separate_from_failures(self):
        report = B.compare(baseline_fixture(), observation_fixture())
        self.assertEqual(report["status"], "ok")
        self.assertEqual([b["name"] for b in report["blockers"]], ["opencode"])
        self.assertEqual(report["blockers"][0]["status"], "blocked")

    def test_non_native_systems_are_recorded_as_blocked(self):
        report = B.compare(
            baseline_fixture(), observation_fixture(), native_system="x86_64-darwin"
        )
        blocked = {b.get("platform") for b in report["blockers"]}
        self.assertIn("aarch64-linux", blocked)
        self.assertEqual(report["failures"], [])


class CliTests(unittest.TestCase):
    def run_verify(self, observation):
        with tempfile.TemporaryDirectory() as tmp:
            observation_path = pathlib.Path(tmp) / "observation.json"
            observation_path.write_text(json.dumps(observation))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                return B.main(
                    [
                        "verify",
                        "--baseline",
                        str(HERE / "fixtures" / "minimal-baseline.json"),
                        "--observation",
                        str(observation_path),
                    ]
                )

    def test_verify_exits_nonzero_when_a_selector_is_missing(self):
        observation = observation_fixture()
        observation["selectors"]["checks"]["aarch64-linux"].remove("alpha")
        self.assertEqual(self.run_verify(observation), 1)

    def test_fixture_baseline_has_dispatch_inventory(self):
        baseline = baseline_fixture()
        self.assertTrue(baseline["ci"]["dispatch_outputs"])
        self.assertTrue(baseline["inventory_sha256"])

    def test_verify_exits_zero_when_only_blockers_remain(self):
        baseline = baseline_fixture()
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path = pathlib.Path(tmp) / "baseline.json"
            baseline_path.write_text(json.dumps(baseline))
            observation = observation_fixture()
            observation_path = pathlib.Path(tmp) / "observation.json"
            observation_path.write_text(json.dumps(observation))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                status = B.main(
                    [
                        "verify",
                        "--baseline",
                        str(baseline_path),
                        "--observation",
                        str(observation_path),
                    ]
                )
        self.assertEqual(status, 0)

    def test_missing_inventory_integrity_hash_fails_closed(self):
        baseline = baseline_fixture()
        baseline.pop("inventory_sha256")
        with tempfile.TemporaryDirectory() as tmp:
            baseline_path = pathlib.Path(tmp) / "baseline.json"
            observation_path = pathlib.Path(tmp) / "observation.json"
            baseline_path.write_text(json.dumps(baseline))
            observation_path.write_text(json.dumps(observation_fixture()))
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(
                io.StringIO()
            ):
                status = B.main(
                    [
                        "verify",
                        "--baseline",
                        str(baseline_path),
                        "--observation",
                        str(observation_path),
                    ]
                )
        self.assertEqual(status, 1)


class StaticFactTests(unittest.TestCase):
    def test_ci_parser_reads_runners_conditions_and_exclusions(self):
        facts = B.parse_ci((B.ROOT / ".github" / "workflows" / "ci.yml").read_text())
        self.assertEqual(facts["jobs"]["flake-check"], "macos-latest")
        self.assertEqual(
            facts["job_conditions"]["flake-check"],
            "needs.dispatch.outputs.flake-check == 'true'",
        )
        self.assertEqual(facts["dispatch_outputs"]["flake-check"], "flake_check")
        self.assertEqual(facts["dispatch_assignments"]["flake_check"], "false")
        self.assertEqual(facts["dispatch_guards"]["flake-check"], 1)
        self.assertIn("lima-vm-config-validate", facts["flake_check_exclusions"])
        self.assertNotIn("dispatch", facts["flake_check_exclusions"])

    def test_disabling_a_recorded_ci_lane_is_a_failure(self):
        baseline = B.load_json(HERE / "baseline.json")
        facts = B.static_facts(B.ROOT)
        facts["ci"]["job_conditions"]["flake-check"] = "false"
        report = B.diff_static(baseline, facts)
        self.assertTrue(
            any(f.get("kind") == "ci-lane" and f.get("selector") == "flake-check" for f in report["failures"])
        )

    def test_dispatch_can_disable_a_recorded_ci_lane(self):
        baseline = B.load_json(HERE / "baseline.json")
        original = (B.ROOT / ".github" / "workflows" / "ci.yml").read_text()
        disabled = original.replace(
            '                flake_check=true', '                flake_check=false'
        )
        self.assertNotEqual(disabled, original)
        facts = B.static_facts(B.ROOT)
        facts["ci"] = B.parse_ci(disabled)
        report = B.diff_static(baseline, facts)
        self.assertTrue(
            any(
                f.get("kind") == "ci-dispatch" and f.get("selector") == "dispatch_logic"
                for f in report["failures"]
            )
        )

    def test_removing_a_blocker_record_is_a_failure(self):
        baseline = B.load_json(HERE / "baseline.json")
        baseline["runner_blockers"] = [
            item for item in baseline["runner_blockers"] if item["name"] != "fabro-workflows-validate"
        ]
        report = B.diff_static(baseline, B.static_facts(B.ROOT))
        self.assertTrue(
            any(
                f.get("kind") == "runner-blocker" and f.get("selector") == "fabro-workflows-validate"
                for f in report["failures"]
            )
        )

    def test_adding_an_unmatched_blocker_record_is_a_failure(self):
        baseline = B.load_json(HERE / "baseline.json")
        baseline["runner_blockers"].append(
            {"name": "not-a-check", "kind": "other", "reason": "fixture"}
        )
        report = B.diff_static(baseline, B.static_facts(B.ROOT))
        self.assertTrue(
            any(
                f.get("kind") == "runner-blocker" and f.get("selector") == "not-a-check"
                for f in report["failures"]
            )
        )

    def test_missing_dispatch_baseline_fails_closed(self):
        baseline = B.load_json(HERE / "baseline.json")
        baseline["ci"].pop("dispatch_assignments")
        report = B.diff_static(baseline, B.static_facts(B.ROOT))
        self.assertTrue(
            any(f.get("kind") == "ci-dispatch" for f in report["failures"])
        )

    def test_dispatch_output_replacement_fails_lane_baseline(self):
        baseline = B.load_json(HERE / "baseline.json")
        facts = B.static_facts(B.ROOT)
        text = facts["ci"]["text"].replace(
            'echo "flake-check=$flake_check"', 'echo "flake-check=false"'
        )
        facts["ci"] = B.parse_ci(text)
        report = B.diff_static(baseline, facts)
        self.assertTrue(
            any(
                f.get("kind") == "ci-dispatch" and f.get("selector") == "flake-check"
                for f in report["failures"]
            )
        )

    def test_dispatch_enablement_guard_removal_fails_lane_baseline(self):
        baseline = B.load_json(HERE / "baseline.json")
        original = (B.ROOT / ".github" / "workflows" / "ci.yml").read_text()
        disabled = original.replace('"$stack_ok" == "true"', '"$stack_ok" == "false"')
        self.assertNotEqual(disabled, original)
        facts = B.static_facts(B.ROOT)
        facts["ci"] = B.parse_ci(disabled)
        report = B.diff_static(baseline, facts)
        self.assertTrue(
            any(
                f.get("kind") == "ci-dispatch" and f.get("selector") == "dispatch_logic"
                for f in report["failures"]
            )
        )

    def test_dispatch_outer_gate_removal_fails_lane_baseline(self):
        baseline = B.load_json(HERE / "baseline.json")
        original = (B.ROOT / ".github" / "workflows" / "ci.yml").read_text()
        disabled = original.replace('if [[ "$pr_default" == "true" || "$EVENT_NAME" == "push" ]]; then', "if false; then")
        self.assertNotEqual(disabled, original)
        facts = B.static_facts(B.ROOT)
        facts["ci"] = B.parse_ci(disabled)
        report = B.diff_static(baseline, facts)
        self.assertTrue(
            any(
                f.get("kind") == "ci-dispatch" and f.get("selector") == "dispatch_logic"
                for f in report["failures"]
            )
        )

    def test_baseline_inventory_tampering_is_detected(self):
        baseline = B.load_json(HERE / "baseline.json")
        observation = {
            "selectors": copy.deepcopy(baseline["selectors"]),
            "registry": copy.deepcopy(baseline["registry"]),
            "host_wiring": copy.deepcopy(baseline["host_wiring"]),
        }
        del baseline["selectors"]["checks"]["aarch64-linux"][0]
        report = B.compare(baseline, observation)
        self.assertTrue(any(f["kind"] == "baseline-integrity" for f in report["failures"]))

    def test_flake_inputs_skip_non_flake_locks(self):
        facts = B.static_facts(B.ROOT)
        self.assertIn("nixpkgs", facts["flake_inputs"])
        self.assertIn("self", facts["flake_inputs"])
        self.assertNotIn("homebrew-core", facts["flake_inputs"])

    def test_committed_baseline_matches_repository_facts(self):
        baseline = B.load_json(HERE / "baseline.json")
        report = B.diff_static(baseline, B.static_facts(B.ROOT))
        self.assertEqual(report["failures"], [])

    def test_missing_integrity_hash_is_a_static_failure(self):
        baseline = B.load_json(HERE / "baseline.json")
        baseline.pop("inventory_sha256")
        report = B.diff_static(baseline, B.static_facts(B.ROOT))
        self.assertTrue(
            any(
                finding.get("kind") == "baseline-integrity"
                and finding.get("selector") == "inventory_sha256"
                for finding in report["failures"]
            )
        )

    def test_committed_baseline_compares_full_selector_pin_and_secret_inventories(self):
        baseline = B.load_json(HERE / "baseline.json")
        facts = B.static_facts(B.ROOT)
        report = B.diff_static(baseline, facts)
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["changes"], [])
        self.assertEqual(report["additions"], [])
        self.assertEqual(set(baseline["pins"]), set(B.PIN_INPUTS))
        self.assertTrue(baseline["secrets"]["stores"])

    def test_committed_baseline_records_every_system(self):
        selectors = B.load_json(HERE / "baseline.json")["selectors"]
        self.assertEqual(set(selectors["systems"]), set(B.SYSTEMS))
        for kind in ("checks", "apps", "devShells"):
            self.assertEqual(set(selectors[kind]), set(B.SYSTEMS))

    def test_committed_baseline_detects_a_removed_real_selector(self):
        baseline = B.load_json(HERE / "baseline.json")
        observation = {
            "selectors": copy.deepcopy(baseline["selectors"]),
            "registry": copy.deepcopy(baseline["registry"]),
            "host_wiring": copy.deepcopy(baseline["host_wiring"]),
        }
        destination = "aarch64-linux"
        observation["selectors"]["checks"][destination].remove("dependency-cooldown")
        report = B.compare(baseline, observation)
        self.assertEqual(report["status"], "failed")
        self.assertIn(
            {"kind": "checks", "system": destination, "selector": "dependency-cooldown"},
            [
                {key: failure[key] for key in ("kind", "system", "selector")}
                for failure in report["failures"]
            ],
        )

    def test_baseline_matches_selector_registry_pin_and_host_observation(self):
        baseline = B.load_json(HERE / "baseline.json")
        observation = {
            "selectors": copy.deepcopy(baseline["selectors"]),
            "registry": copy.deepcopy(baseline["registry"]),
            "host_wiring": copy.deepcopy(baseline["host_wiring"]),
        }
        report = B.compare(baseline, observation)
        self.assertEqual(report["status"], "ok")
        self.assertEqual(report["failures"], [])
        self.assertEqual(report["additions"], [])
        self.assertEqual(report["changes"], [])

    def test_baseline_check_added_after_capture_is_not_a_parity_addition(self):
        baseline = B.load_json(HERE / "baseline.json")
        observation = {
            "selectors": copy.deepcopy(baseline["selectors"]),
            "registry": copy.deepcopy(baseline["registry"]),
            "host_wiring": copy.deepcopy(baseline["host_wiring"]),
        }
        for checks in observation["selectors"]["checks"].values():
            checks.append("flake-layout-baseline")
        report = B.compare(baseline, observation, facts=B.static_facts(B.ROOT))
        self.assertEqual(report["failures"], [])
        self.assertNotIn("flake-layout-baseline", [a.get("selector") for a in report["additions"]])

    def test_committed_runner_blockers_are_separate_from_failures(self):
        baseline = B.load_json(HERE / "baseline.json")
        observation = {
            "selectors": copy.deepcopy(baseline["selectors"]),
            "registry": copy.deepcopy(baseline["registry"]),
            "host_wiring": copy.deepcopy(baseline["host_wiring"]),
        }
        report = B.compare(baseline, observation)
        self.assertEqual(report["failures"], [])
        names = {blocker["name"] for blocker in report["blockers"]}
        self.assertIn("lima-vm-config-validate", names)
        self.assertTrue(
            all(
                blocker["status"] in {"blocked", "covered-elsewhere"}
                for blocker in report["blockers"]
                if blocker["kind"] != "not-selected"
            )
        )
        self.assertTrue(all(b["status"] == "not-run" for b in report["blockers"] if b["kind"] == "not-selected"))

    def test_committed_registry_covers_every_flake_input(self):
        baseline = B.load_json(HERE / "baseline.json")
        facts = B.static_facts(B.ROOT)
        self.assertEqual(
            set(baseline["registry"]["registry_names"]), set(facts["flake_inputs"])
        )


if __name__ == "__main__":
    unittest.main()
