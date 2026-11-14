#!/usr/bin/env python3
"""Behavioral regression tests for the operator-run Fly smoke harness.

The suite covers the existing-image boot mode, the module deployment mode
(hybrid image publication, two deployments, full Machine configs, managed
counts, stable identities, and live app settings), and the failure checks
(recorded missing image, Fly rejection, and caller-script propagation).
"""

import copy
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


HARNESS = Path(__file__).with_name("contract-smoke.sh")


class FlyContractSmokeTests(unittest.TestCase):
    def setUp(self):
        # The harness is documented for direct invocation, so the executable
        # bit is part of its operator-facing contract.
        self.assertTrue(
            os.access(HARNESS, os.X_OK),
            f"{HARNESS} must be executable for direct invocation",
        )
        self.temp = tempfile.TemporaryDirectory(prefix="fly-contract-test-")
        self.root = Path(self.temp.name)
        self.bin = self.root / "bin"
        self.bin.mkdir()
        self._write_command(
            "curl",
            r'''#!/usr/bin/env python3
import json
import os
import pathlib
import sys

args = sys.argv[1:]
url = args[-1]
output = pathlib.Path(args[args.index("--output") + 1])
if "/v1/apps/" in url and url.endswith("/machines"):
    counter = pathlib.Path(os.environ["FLY_TEST_COUNTER"])
    count = int(counter.read_text()) if counter.exists() else 0
    counter.write_text(str(count + 1))
    if count == 0:
        fixture = "FLY_TEST_BEFORE_MACHINES"
    elif count == 1:
        fixture = "FLY_TEST_AFTER_MACHINES"
    else:
        fixture = "FLY_TEST_LATER_MACHINES" if "FLY_TEST_LATER_MACHINES" in os.environ else "FLY_TEST_AFTER_MACHINES"
    output.write_text(os.environ[fixture])
elif "/v1/apps/" in url:
    output.write_text(json.dumps({"name": os.environ["FLY_SMOKE_CONFIRM_APP"]}))
elif "/manifests/" in url:
    if "nix-" + "z" * 32 in url and os.environ.get("FLY_TEST_MISSING_TAG_PRESENT") != "1":
        print("404", end="")
        sys.exit(0)
    if os.environ.get("FLY_TEST_REGISTRY_FAIL") == "1":
        print("401", end="")
        sys.exit(0)
else:
    sys.exit(22)
print("200", end="")
''',
        )
        self._write_command(
            "flyctl",
            r'''#!/usr/bin/env python3
import os
import pathlib
import sys

app = os.environ["FLY_SMOKE_CONFIRM_APP"]
if sys.argv[1:3] == ["config", "show"]:
    if sys.argv[3:5] != ["--app", app]:
        sys.exit(2)
    if os.environ.get("FLY_API_TOKEN") != "test-only-token-do-not-log":
        sys.exit(3)
    sys.stdout.write(os.environ["FLY_TEST_APP_CONFIG"])
    sys.exit(0)
if sys.argv[1:3] != ["deploy", "--app"] or sys.argv[3] != app:
    sys.exit(2)
pathlib.Path(os.environ["FLY_TEST_DEPLOY_MARKER"]).write_text("deployed")
if os.environ.get("FLY_TEST_DEPLOY_FAIL") == "1":
    sys.exit(1)
''',
        )
        self.deploy_program = self.bin / "fly-app-deploy"
        self._write_command(
            "fly-app-deploy",
            r'''#!/usr/bin/env python3
import json
import os
import pathlib
import sys

if len(sys.argv) != 3 or sys.argv[1] != "--spec":
    print("unexpected deploy arguments", file=sys.stderr)
    sys.exit(64)
spec_path = pathlib.Path(sys.argv[2])
if not spec_path.is_file():
    print("deployment spec is not readable", file=sys.stderr)
    sys.exit(64)
if not os.environ.get("FLY_APP_STATE_DIR"):
    print("deployment must use the harness publication state directory", file=sys.stderr)
    sys.exit(66)

log = pathlib.Path(os.environ["FLY_TEST_DEPLOY_LOG"])
with log.open("a", encoding="utf-8") as handle:
    handle.write(str(spec_path) + "\n")
count = len(log.read_text(encoding="utf-8").splitlines())
if os.environ.get("FLY_TEST_DEPLOY_OUTPUT"):
    print(os.environ["FLY_TEST_DEPLOY_OUTPUT"])
if os.environ.get("FLY_TEST_DEPLOY_FAIL_AT") == str(count):
    print(f"stub deployment failure {count}", file=sys.stderr)
    sys.exit(7)

spec = json.loads(spec_path.read_text(encoding="utf-8"))
settings = spec.get("settings") or {}
sources = []
for machine in (spec.get("machines") or {}).values():
    if "image" in machine:
        sources.append(machine["image"])
    for container in (machine.get("containers") or {}).values():
        if "image" in container:
            sources.append(container["image"])
identities = [
    source["derivation"].split("/")[3][:32]
    for source in sources
    if "derivation" in source
]
app = spec["name"]


def republish():
    if identities and os.environ.get("FLY_TEST_PUBLISH_ON_FAILURE") == "1":
        print(
            f"fly-app-publish: publishing registry.fly.io/{app}:nix-{identities[0]}",
            file=sys.stderr,
        )


def failure_output():
    if os.environ.get("FLY_TEST_FAILURE_OUTPUT"):
        print(os.environ["FLY_TEST_FAILURE_OUTPUT"])


if os.environ.get("FLY_TEST_IGNORE_FAILURES") != "1":
    if any(identity == "z" * 32 for identity in identities):
        republish()
        failure_output()
        print(
            "fly-app-publish: previously published image "
            f"'registry.fly.io/{app}:nix-{'z' * 32}' is missing from the Fly "
            "registry while publication state records a digest; refusing to republish",
            file=sys.stderr,
        )
        sys.exit(1)
    rejected = any(
        isinstance(settings.get(key), str) for key in ("http_service", "services")
    )
    rejected = rejected or settings.get("kill_timeout") == "fly-smoke-invalid-duration"
    if rejected:
        republish()
        failure_output()
        for identity in identities:
            print(
                f"fly-app-publish: image registry.fly.io/{app}:nix-{identity} "
                "is unchanged and still available; not republishing",
                file=sys.stderr,
            )
        print(
            f"fly-app-reconcile: Fly rejected deployment for app '{app}' "
            "(flyctl exit status 7)",
            file=sys.stderr,
        )
        sys.exit(7)

if identities:
    state_dir = pathlib.Path(os.environ["FLY_APP_STATE_DIR"])
    state_dir.mkdir(parents=True, exist_ok=True)
    state_path = state_dir / f"{app}.json"
    try:
        state = json.loads(state_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError):
        state = {"version": 1, "app": app, "images": {}}
    for identity in identities:
        state.setdefault("images", {})[identity] = {
            "identity": identity,
            "reference": f"registry.fly.io/{app}:nix-{identity}",
            "digest": "sha256:" + "0" * 64,
        }
    state_path.write_text(
        json.dumps(state, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
''',
        )
        for command in ("jq", "base64", "mktemp", "tr", "sleep", "awk"):
            target = shutil.which(command)
            if target is None:
                self.fail(f"required test dependency is unavailable: {command}")
            (self.bin / command).symlink_to(target)
        self.before = []
        self.after = [self._machine("new-machine", "1")]

    def tearDown(self):
        self.temp.cleanup()

    @staticmethod
    def _machine(machine_id, version, state="started", image="registry.fly.io/demo:smoke"):
        return {
            "id": machine_id,
            "version": version,
            "state": state,
            "config": {"image": image},
        }

    def _write_command(self, name, content):
        path = self.bin / name
        path.write_text(content)
        path.chmod(0o755)

    def _run(self, timeout="1", overrides=None):
        counter = self.root / "machine-requests"
        counter.unlink(missing_ok=True)
        marker = self.root / "deploy-called"
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "FLY_API_TOKEN": "test-only-token-do-not-log",
                "FLY_SMOKE_CONFIRM_APP": "demo",
                "FLY_SMOKE_BOOT_TIMEOUT_SECONDS": timeout,
                "FLY_TEST_BEFORE_MACHINES": json.dumps(self.before),
                "FLY_TEST_AFTER_MACHINES": json.dumps(self.after),
                "FLY_TEST_COUNTER": str(counter),
                "FLY_TEST_DEPLOY_MARKER": str(marker),
            }
        )
        env.update(overrides or {})
        result = subprocess.run(
            [str(HARNESS), "demo", "registry.fly.io/demo:smoke"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        self.assertNotIn("test-only-token-do-not-log", result.stdout + result.stderr)
        return result, marker

    def _spec(self):
        return {
            "name": "demo",
            "settings": {
                "primary_region": "ord",
                "kill_timeout": 45,
                "env": {"APP_MODE": "web"},
            },
            "machines": {
                "web": {
                    "config": {
                        "env": {"APP_MODE": "web"},
                        "guest": {
                            "cpu_kind": "shared",
                            "cpus": 1,
                            "memory_mb": 256,
                        },
                    },
                    "containers": {
                        "app": {
                            "config": {"env": {"CONTAINER": "app"}},
                            "image": {
                                "derivation": (
                                    "/nix/store/"
                                    "00000000000000000000000000000000-app-image"
                                )
                            },
                        },
                        "sidecar": {
                            "config": {"env": {"CONTAINER": "sidecar"}},
                            "image": {
                                "derivation": (
                                    "/nix/store/"
                                    "11111111111111111111111111111111-sidecar-image"
                                )
                            },
                        },
                    },
                    "deployContainer": "app",
                },
                "worker": {
                    "config": {"env": {"APP_MODE": "worker"}},
                    "image": {"existingImage": "registry.fly.io/demo:worker"},
                },
            },
        }

    @staticmethod
    def _expected_image(app, source):
        if "existingImage" in source:
            return source["existingImage"]
        digest = source["derivation"].split("/")[3][:32]
        return f"registry.fly.io/{app}:nix-{digest}"

    def _managed_machines(self, spec=None):
        spec = spec or self._spec()
        web = spec["machines"]["web"]
        worker = spec["machines"]["worker"]
        return [
            {
                "id": "machine-web",
                "state": "started",
                "config": {
                    "env": web["config"]["env"],
                    "guest": web["config"]["guest"],
                    "containers": [
                        {
                            **container["config"],
                            "name": name,
                            "image": self._expected_image(
                                spec["name"], container["image"]
                            ),
                        }
                        for name, container in sorted(web["containers"].items())
                    ],
                    "metadata": {
                        "fly_app_module_key": "web",
                        "fly_process_group": "app",
                    },
                },
            },
            {
                "id": "machine-worker",
                "state": "started",
                "config": {
                    "env": worker["config"]["env"],
                    "image": self._expected_image(
                        spec["name"], worker["image"]
                    ),
                    "metadata": {
                        "fly_app_module_key": "worker",
                        "fly_process_group": "worker",
                    },
                },
            },
        ]

    def _app_config(self, spec=None):
        spec = spec or self._spec()
        config = {"app": spec["name"]}
        config.update(spec["settings"])
        # The Fly CLI serializes durations as strings while the declaration
        # uses plain seconds, so the live fixture mirrors that normalization.
        if "kill_timeout" in config:
            config["kill_timeout"] = f"{config['kill_timeout']}s"
        return config

    def _run_deploy(
        self,
        spec=None,
        before=None,
        after=None,
        app_config=None,
        timeout="1",
        overrides=None,
        failures=False,
    ):
        spec = copy.deepcopy(self._spec()) if spec is None else spec
        spec_path = self.root / "spec.json"
        spec_path.write_text(json.dumps(spec))
        counter = self.root / "machine-requests"
        counter.unlink(missing_ok=True)
        deploy_log = self.root / "deploy-calls"
        deploy_log.unlink(missing_ok=True)
        env = os.environ.copy()
        env.update(
            {
                "PATH": f"{self.bin}:{env['PATH']}",
                "FLY_API_TOKEN": "test-only-token-do-not-log",
                "FLY_SMOKE_CONFIRM_APP": "demo",
                "FLY_SMOKE_BOOT_TIMEOUT_SECONDS": timeout,
                "FLY_TEST_BEFORE_MACHINES": json.dumps(
                    [] if before is None else before
                ),
                "FLY_TEST_AFTER_MACHINES": json.dumps(
                    self._managed_machines() if after is None else after
                ),
                "FLY_TEST_COUNTER": str(counter),
                "FLY_TEST_DEPLOY_LOG": str(deploy_log),
                "FLY_TEST_APP_CONFIG": json.dumps(
                    self._app_config() if app_config is None else app_config
                ),
            }
        )
        env.update(overrides or {})
        arguments = [
            str(HARNESS),
            "--spec",
            str(spec_path),
            "--deploy",
            str(self.deploy_program),
        ]
        if failures:
            arguments.append("--failures")
        arguments.append("demo")
        result = subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=20,
        )
        self.assertNotIn("test-only-token-do-not-log", result.stdout + result.stderr)
        return result, deploy_log

    def test_deploy_mode_proves_hybrid_image_boot_and_two_machine_deployments(self):
        result, deploy_log = self._run_deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(deploy_log.read_text().splitlines()), 2)
        for label in ("1/2", "2/2"):
            self.assertIn(f"Fly deployment {label}: accepted", result.stdout)
            self.assertIn(f"Fly Machine set {label}: ok", result.stdout)
            self.assertIn(f"Fly app settings {label}: ok", result.stdout)
        self.assertIn("Fly hybrid image publication: ok", result.stdout)
        self.assertIn("Fly hybrid image boot: ok", result.stdout)
        self.assertIn("Fly live compatibility: ok", result.stdout)
        self.assertNotIn("Fly failure missing-image: ok", result.stdout)

    def test_deploy_mode_proves_failure_paths_without_republishing(self):
        result, deploy_log = self._run_deploy(failures=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(deploy_log.read_text().splitlines()), 5)
        for label in ("missing-image", "fly-rejection"):
            self.assertIn(f"Fly failure {label}: ok", result.stdout)
        self.assertIn("Fly caller-script failure propagation: ok", result.stdout)
        self.assertIn("Fly live failure compatibility: ok", result.stdout)
        self.assertNotIn("fly-app-publish: publishing", result.stdout + result.stderr)

    def test_failure_checks_reject_an_unexpected_success(self):
        result, _ = self._run_deploy(
            failures=True, overrides={"FLY_TEST_IGNORE_FAILURES": "1"}
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("unexpectedly succeeded", result.stderr)

    def test_failure_checks_reject_a_republish(self):
        result, _ = self._run_deploy(
            failures=True, overrides={"FLY_TEST_PUBLISH_ON_FAILURE": "1"}
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("republished an image", result.stderr)

    def test_failure_checks_reject_a_present_missing_image_tag(self):
        result, _ = self._run_deploy(
            failures=True, overrides={"FLY_TEST_MISSING_TAG_PRESENT": "1"}
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("could not confirm the fabricated missing image is absent", result.stderr)

    def test_failure_check_diagnostics_redact_the_token(self):
        result, _ = self._run_deploy(
            failures=True,
            overrides={
                "FLY_TEST_PUBLISH_ON_FAILURE": "1",
                "FLY_TEST_FAILURE_OUTPUT": "token test-only-token-do-not-log",
            },
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("[REDACTED]", result.stdout + result.stderr)

    def test_deploy_mode_requires_a_multi_container_hybrid_spec(self):
        mixed = copy.deepcopy(self._spec())
        mixed["machines"]["web"]["image"] = {
            "existingImage": "registry.fly.io/demo:web"
        }
        unknown_container = copy.deepcopy(self._spec())
        unknown_container["machines"]["web"]["deployContainer"] = "missing"
        single_container = copy.deepcopy(self._spec())
        single_container["machines"]["web"]["containers"] = {
            "app": single_container["machines"]["web"]["containers"]["app"]
        }
        del single_container["machines"]["web"]["deployContainer"]
        existing_only = copy.deepcopy(self._spec())
        existing_only["machines"]["web"]["containers"] = {
            name: {
                "config": container["config"],
                "image": {"existingImage": f"registry.fly.io/demo:{name}"},
            }
            for name, container in existing_only["machines"]["web"][
                "containers"
            ].items()
        }
        invalid_derivation = copy.deepcopy(self._spec())
        invalid_derivation["machines"]["web"]["containers"]["app"]["image"] = {
            "derivation": "not-a-store-path"
        }
        no_machines = copy.deepcopy(self._spec())
        no_machines["machines"] = {}
        cases = (
            ("app mismatch", {"name": "other"}, "targets app 'other'"),
            ("no machines", no_machines, "at least one Machine"),
            ("no multi-container", single_container, "multi-container Machine"),
            ("no derivation", existing_only, "derivation image source"),
            ("mixed sources", mixed, "cannot mix Machine and container"),
            (
                "unknown deploy container",
                unknown_container,
                "unknown deployContainer",
            ),
            (
                "invalid derivation",
                invalid_derivation,
                "exactly one image source",
            ),
        )
        for label, spec, message in cases:
            with self.subTest(label=label):
                result, deploy_log = self._run_deploy(spec=spec)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)
                self.assertFalse(deploy_log.exists())

    def test_deploy_mode_rejects_machine_set_and_configuration_mismatches(self):
        spec = self._spec()
        base = self._managed_machines(spec)
        missing_worker = [copy.deepcopy(base[0])]
        launch_only = copy.deepcopy(base)
        launch_only[1]["config"]["metadata"] = {"fly_process_group": "worker"}
        duplicate_identity = copy.deepcopy(base)
        duplicate_identity[1]["config"]["metadata"]["fly_app_module_key"] = "web"
        missing_container = copy.deepcopy(base)
        missing_container[0]["config"]["containers"] = [
            entry
            for entry in missing_container[0]["config"]["containers"]
            if entry["name"] == "app"
        ]
        wrong_image = copy.deepcopy(base)
        wrong_image[0]["config"]["containers"][0]["image"] = (
            "registry.fly.io/demo:latest"
        )
        wrong_config = copy.deepcopy(base)
        del wrong_config[0]["config"]["guest"]
        stopped = copy.deepcopy(base)
        stopped[0]["state"] = "stopped"
        malformed = copy.deepcopy(base)
        malformed[0]["config"]["containers"] = "not-a-container-list"
        cases = (
            (
                "managed count",
                [],
                "managed Machine count 0 does not match the 2 declared Machines",
            ),
            (
                "missing identity",
                missing_worker,
                "declared Machine 'worker' has 0 module-managed matches",
            ),
            (
                "launch process group without module identity",
                launch_only,
                "without a module identity",
            ),
            ("duplicate identity", duplicate_identity, "not unique"),
            (
                "container set",
                missing_container,
                "containers app do not match the declaration app, sidecar",
            ),
            (
                "image",
                wrong_image,
                "full config does not contain the declared configuration",
            ),
            (
                "config",
                wrong_config,
                "full config does not contain the declared configuration",
            ),
            ("boot state", stopped, "is not started"),
            (
                "malformed Machines response",
                malformed,
                "could not verify the Fly Machines against the declaration",
            ),
        )
        for label, machines, message in cases:
            with self.subTest(label=label):
                result, _ = self._run_deploy(spec=spec, after=machines)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)

    def test_deploy_mode_rejects_missing_app_settings(self):
        result, _ = self._run_deploy(
            app_config={"app": "demo", "primary_region": "sjc"}
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(
            "live app configuration does not contain the declared settings",
            result.stderr,
        )

    def test_deploy_mode_fails_closed_when_deployment_or_registry_fails(self):
        for overrides, message in (
            (
                {"FLY_TEST_DEPLOY_FAIL_AT": "1"},
                "Fly deployment 1/2 failed with status 7",
            ),
            (
                {"FLY_TEST_DEPLOY_FAIL_AT": "2"},
                "Fly deployment 2/2 failed with status 7",
            ),
            (
                {"FLY_TEST_REGISTRY_FAIL": "1"},
                "requested image is not readable",
            ),
        ):
            with self.subTest(message=message):
                result, _ = self._run_deploy(overrides=overrides)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)

    def test_deploy_mode_rejects_machines_replaced_between_deployments(self):
        later = self._managed_machines()
        later[0]["id"] = "machine-web-replaced"
        result, _ = self._run_deploy(
            overrides={"FLY_TEST_LATER_MACHINES": json.dumps(later)}
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn(
            "second deployment replaced the module-managed Machines",
            result.stderr,
        )

    def test_deploy_mode_redacts_token_from_failure_diagnostics(self):
        result, _ = self._run_deploy(
            overrides={
                "FLY_TEST_DEPLOY_FAIL_AT": "1",
                "FLY_TEST_DEPLOY_OUTPUT": "token test-only-token-do-not-log",
            }
        )
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("[REDACTED]", result.stdout + result.stderr)

    def test_deploy_mode_requires_complete_arguments_and_a_readable_spec(self):
        env = {
            **os.environ,
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "FLY_API_TOKEN": "test-only-token-do-not-log",
            "FLY_SMOKE_CONFIRM_APP": "demo",
        }
        for args, status, message in (
            (
                ["--spec", "spec.json", "demo"],
                2,
                "usage:",
            ),
            (
                ["--spec", "spec.json", "--deploy", str(self.deploy_program), "--failures"],
                2,
                "usage:",
            ),
            (
                ["--spec", "", "--deploy", str(self.deploy_program), "demo"],
                2,
                "usage:",
            ),
            (
                [
                    "--spec",
                    str(self.root / "missing.json"),
                    "--deploy",
                    str(self.deploy_program),
                    "demo",
                ],
                1,
                "spec is not readable",
            ),
            (
                [
                    "--spec",
                    str(self.root / "missing.json"),
                    "--deploy",
                    str(self.root / "missing"),
                    "demo",
                ],
                1,
                "deployment program is not executable",
            ),
        ):
            with self.subTest(args=args):
                result = subprocess.run(
                    [str(HARNESS), *args],
                    check=False,
                    capture_output=True,
                    text=True,
                    env=env,
                    timeout=10,
                )
                self.assertEqual(result.returncode, status, result.stderr)
                self.assertIn(message, result.stderr)
                self.assertNotIn(
                    "test-only-token-do-not-log", result.stdout + result.stderr
                )

    def test_accepts_a_newly_created_machine_and_leading_zero_timeout(self):
        result, marker = self._run("0001")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(marker.exists())
        self.assertIn("Fly Machine boot: ok", result.stdout)

    def test_accepts_an_existing_machine_updated_by_this_deployment(self):
        machine = self._machine("existing-machine", "7")
        self.before = [self._machine("existing-machine", "6")]
        self.after = [machine]
        result, marker = self._run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(marker.exists())

    def test_rejects_a_stale_started_machine_with_the_same_image(self):
        machine = self._machine("stale-machine", "4")
        self.before = [machine]
        self.after = [machine]
        result, marker = self._run()
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertTrue(marker.exists())
        self.assertIn("no newly created or updated Machine", result.stderr)

    def test_rejects_oversized_timeout_before_deploying(self):
        result, marker = self._run("18446744073709551617")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertFalse(marker.exists())
        self.assertIn("must be an integer from 1 through 3600", result.stderr)

    def test_leading_zero_timeout_is_normalized_before_arithmetic(self):
        for timeout in ("01", "000001", "0003600"):
            with self.subTest(timeout=timeout):
                result, _ = self._run(timeout)
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_rejects_zero_and_values_above_the_timeout_limit(self):
        for timeout in ("0", "0000", "3601", "0003601"):
            with self.subTest(timeout=timeout):
                result, marker = self._run(timeout)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertFalse(marker.exists())
                self.assertIn("must be an integer from 1 through 3600", result.stderr)

    def test_missing_app_and_token_guards_fail_closed(self):
        for overrides, message in (
            ({"FLY_SMOKE_CONFIRM_APP": "other"}, "exact existing disposable app name"),
            ({"FLY_API_TOKEN": ""}, "FLY_API_TOKEN is required"),
        ):
            with self.subTest(message=message):
                result, marker = self._run(overrides=overrides)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertFalse(marker.exists())
                self.assertIn(message, result.stderr)

    def test_registry_and_deploy_rejections_fail_closed(self):
        for overrides, message in (
            ({"FLY_TEST_REGISTRY_FAIL": "1"}, "requested image is not readable"),
            ({"FLY_TEST_DEPLOY_FAIL": "1"}, "Fly rejected the image deployment"),
        ):
            with self.subTest(message=message):
                result, marker = self._run(overrides=overrides)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, result.stderr)
                if "REGISTRY_FAIL" in next(iter(overrides)):
                    self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
