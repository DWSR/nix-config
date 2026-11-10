#!/usr/bin/env python3
"""Fly CLI app-settings deployment tests for the Fly app reconciler."""

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import tomllib
import unittest


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fly-app/fixture"
RECONCILE_SCRIPT = Path(
    os.environ.get("FLY_APP_RECONCILE_NIX", ROOT / "scripts/fly-app-reconcile.nix")
)
TOKEN = "fixture-fly-token-do-not-store-6a2b0"
APP = "fly-alpha"
PRIMARY = "registry.fly.io/fly-alpha:web-app"
SIDECAR = "registry.fly.io/fly-alpha:web-sidecar"
WORKER = "registry.fly.io/fly-alpha:worker"
APP_NAME = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$")

STUB_FLYCTL = """
import json
import os
from pathlib import Path
import stat
import sys


def record(entry):
    with Path(os.environ["FLY_TEST_LOG"]).open("a", encoding="utf-8") as log:
        log.write(json.dumps(entry) + "\\n")


def mode(path):
    return stat.S_IMODE(Path(path).stat().st_mode) if Path(path).exists() else None


token = os.environ.get("FLY_API_TOKEN", "")
args = sys.argv[1:]
common = {
    "args": args,
    "token_present": bool(token),
    "token_in_argv": any(token in argument for argument in args) if token else False,
}

if args[:2] == ["machine", "list"]:
    if "--app" not in args or args[args.index("--app") + 1] != "fly-alpha":
        print("stub flyctl: unexpected machine list target", file=sys.stderr)
        raise SystemExit(64)
    record({"command": "machine-list", **common})
    if os.environ.get("FLY_TEST_LIST_FAIL"):
        print("stub flyctl: simulated Machine listing failure " + token, file=sys.stderr)
        raise SystemExit(int(os.environ.get("FLY_TEST_LIST_STATUS", "4")))
    sys.stdout.write(os.environ.get("FLY_TEST_MACHINES", "[]"))
    raise SystemExit(0)

if args[:2] == ["deploy", "--app"]:
    arguments = args[2:]
    if not arguments or arguments[0] != "fly-alpha":
        print("stub flyctl: deploy targeted the wrong app", file=sys.stderr)
        raise SystemExit(64)
    if "--config" not in arguments or "--image" not in arguments:
        print("stub flyctl: deploy is missing config or image", file=sys.stderr)
        raise SystemExit(64)
    config_path = arguments[arguments.index("--config") + 1]
    config = Path(config_path).read_text(encoding="utf-8")
    image = arguments[arguments.index("--image") + 1]
    record(
        {
            "command": "deploy",
            **common,
            "app": arguments[0],
            "config_path": config_path,
            "config": config,
            "config_mode": mode(config_path),
            "config_directory_mode": mode(Path(config_path).parent),
            "image": image,
        }
    )
    if os.environ.get("FLY_TEST_DEPLOY_FAIL"):
        print("simulated Fly rejection token=" + token)
        print("simulated Fly rejection token=" + token, file=sys.stderr)
        raise SystemExit(int(os.environ.get("FLY_TEST_DEPLOY_STATUS", "7")))
    print("deploy accepted for " + arguments[0])
    raise SystemExit(0)

print("stub flyctl: unexpected arguments: " + repr(args), file=sys.stderr)
raise SystemExit(64)
"""


def image_entry(reference):
    return {
        "kind": "existingImage",
        "source": reference,
        "reference": reference,
        "digest": None,
        "published": False,
    }


def base_spec():
    return {
        "name": APP,
        "settings": {
            "primary_region": "ord",
            "kill_signal": "SIGTERM",
            "kill_timeout": 30,
            "env": {
                "LOG_LEVEL": "info",
                "FEATURE_FLAGS": "one,two",
            },
            "http_service": {
                "internal_port": 8080,
                "force_https": True,
                "auto_stop_machines": "stop",
                "concurrency": {
                    "type": "requests",
                    "soft_limit": 200,
                    "hard_limit": 250,
                },
            },
            "processes": {
                "web": "/app/web",
                "worker": "/app/worker",
            },
            "services": [
                {
                    "internal_port": 8080,
                    "protocol": "tcp",
                    "ports": [
                        {"handlers": ["http"], "port": 80},
                        {"handlers": ["tls", "http"], "port": 443},
                    ],
                }
            ],
            "checks": {
                "alive": {
                    "type": "http",
                    "port": 8080,
                    "path": "/healthz",
                    "interval": "15s",
                    "timeout": "2s",
                }
            },
            "vm": [
                {
                    "size": "shared-cpu-2x",
                    "memory": "1gb",
                    "processes": ["web"],
                }
            ],
        },
        "machines": {
            "web": {
                "containers": {
                    "app": {
                        "config": {"image": PRIMARY},
                        "image": {"existingImage": PRIMARY},
                    },
                    "sidecar": {
                        "config": {"image": SIDECAR},
                        "image": {"existingImage": SIDECAR},
                    },
                },
                "deployContainer": "app",
            },
            "worker": {
                "config": {"image": WORKER},
                "image": {"existingImage": WORKER},
            },
        },
    }


def resolved_payload(spec):
    machines = {}
    images = {}
    for machine_name, machine in sorted(spec["machines"].items()):
        resolved = {"containers": {}}
        containers = machine.get("containers", {})
        for container_name, container in sorted(containers.items()):
            entry = image_entry(container["image"]["existingImage"])
            resolved["containers"][container_name] = entry
            images[entry["source"]] = entry
        if "image" in machine:
            entry = image_entry(machine["image"]["existingImage"])
            resolved["image"] = entry
            images[entry["source"]] = entry
        if "deployContainer" in machine:
            resolved["deployImage"] = resolved["containers"][machine["deployContainer"]]
        machines[machine_name] = resolved
    return {
        "app": spec["name"],
        "registry": "registry.fly.io",
        "images": [images[reference] for reference in sorted(images)],
        "machines": machines,
    }


class FlyReconcileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="fly-reconcile-package-")
        cls.package = cls._build_package()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @staticmethod
    def _run_nix(expression):
        result = subprocess.run(
            [
                "nix",
                "build",
                "--impure",
                "--no-link",
                "--print-out-paths",
                "--expr",
                expression,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"nix build failed:\n{result.stderr}")
        return result.stdout.strip().splitlines()[-1]

    @classmethod
    def _build_package(cls):
        expression = f"""
          let
            flake = builtins.getFlake "path:{FIXTURE}";
            pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
            stubPy = pkgs.writeText "stub-flyctl.py" {json.dumps(STUB_FLYCTL)};
            stub = pkgs.writeShellScriptBin "flyctl" ''
              exec ${{pkgs.python3}}/bin/python3 "${{stubPy}}" "$@"
            '';
          in
          import {RECONCILE_SCRIPT} {{
            inherit pkgs;
            flyctl = stub;
          }}
        """
        return Path(cls._run_nix(expression)) / "bin/fly-app-reconcile"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fly-reconcile-runtime-")
        self.root = Path(self.temp.name)
        self.log = self.root / "flyctl.jsonl"
        self.config_copy = self.root / "fly.toml.copy"
        self.spec = self.root / "spec.json"
        self.images = self.root / "images.json"
        self.machines = []

    def tearDown(self):
        self.temp.cleanup()

    def _flight_files(self, spec=None, payload=None):
        spec = spec or base_spec()
        payload = payload or resolved_payload(spec)
        self.spec.write_text(json.dumps(spec), encoding="utf-8")
        self.images.write_text(json.dumps(payload), encoding="utf-8")

    def _environment(
        self,
        *,
        token=TOKEN,
        list_fail=False,
        deploy_fail=False,
        deploy_status="7",
        list_status="4",
    ):
        env = os.environ.copy()
        env.pop("FLY_API_TOKEN", None)
        env.update(
            {
                "TMPDIR": str(self.root),
                "FLY_TEST_LOG": str(self.log),
                "FLY_TEST_MACHINES": json.dumps(self.machines),
                "FLY_TEST_DEPLOY_STATUS": deploy_status,
                "FLY_TEST_LIST_STATUS": list_status,
            }
        )
        if token is not None:
            env["FLY_API_TOKEN"] = token
        if list_fail:
            env["FLY_TEST_LIST_FAIL"] = "1"
        if deploy_fail:
            env["FLY_TEST_DEPLOY_FAIL"] = "1"
        return env

    def _invoke(self, *, arguments=None, **environment):
        return subprocess.run(
            [
                str(self.package),
                *(arguments or ["--spec", str(self.spec), "--images", str(self.images)]),
            ],
            env=self._environment(**environment),
            capture_output=True,
            text=True,
            check=False,
        )

    def _entries(self, command):
        if not self.log.exists():
            return []
        entries = [
            json.loads(line)
            for line in self.log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]
        return [entry for entry in entries if entry["command"] == command]

    def _deploy(self):
        deploys = self._entries("deploy")
        self.assertEqual(len(deploys), 1, deploys)
        return deploys[0]

    def test_deploys_selected_primary_container_with_rendered_settings(self):
        spec = base_spec()
        self._flight_files(spec=spec)
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

        machine_lists = self._entries("machine-list")
        self.assertEqual(len(machine_lists), 1)
        deploy = self._deploy()
        self.assertEqual(deploy["app"], APP)
        self.assertEqual(deploy["image"], PRIMARY)
        self.assertFalse(deploy["token_in_argv"])
        self.assertTrue(deploy["token_present"])
        self.assertEqual(deploy["config_mode"], 0o600)
        self.assertEqual(deploy["config_directory_mode"], 0o700)
        for flag in (
            "--ha=false",
            "--yes",
            "--now",
        ):
            self.assertIn(flag, deploy["args"])
        for flag in ("--update-only", "--remote-only", "--local-only", "--nixpacks"):
            self.assertNotIn(flag, deploy["args"])
        self.assertNotIn(TOKEN, deploy["config"])
        self.assertNotIn(TOKEN, json.dumps(deploy["args"]))

        rendered = tomllib.loads(deploy["config"])
        self.assertEqual(rendered["app"], APP)
        self.assertEqual(
            {key: value for key, value in rendered.items() if key != "app"},
            spec["settings"],
        )
        self.assertFalse(Path(deploy["config_path"]).exists())
        self.assertFalse(Path(deploy["config_path"]).parent.exists())

    def test_later_deploys_keep_declared_process_group_counts(self):
        self._flight_files()
        self.machines = [
            {
                "id": "machine-one",
                "config": {
                    "metadata": {"fly_process_group": "web"},
                    "image": PRIMARY,
                },
            },
            {
                "id": "machine-two",
                "config": {
                    "metadata": {"fly_process_group": "worker"},
                    "image": WORKER,
                },
            },
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = self._deploy()
        self.assertIn("--ha=false", deploy["args"])
        self.assertIn("--update-only", deploy["args"])

    def test_explicit_deploy_container_wins_over_other_machine_images(self):
        spec = base_spec()
        self._flight_files(spec=spec)
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = self._deploy()
        self.assertEqual(deploy["image"], PRIMARY)
        self.assertNotEqual(deploy["image"], WORKER)

    def test_explicit_deploy_containers_must_agree(self):
        spec = base_spec()
        spec["machines"]["worker"] = {
            "containers": {
                "app": {
                    "config": {"image": WORKER},
                    "image": {"existingImage": WORKER},
                }
            },
            "deployContainer": "app",
        }
        self._flight_files(spec=spec)
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("cannot select a single primary deploy image", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_implicit_conflicting_primary_images_fail_without_deploying(self):
        spec = {
            "name": APP,
            "settings": {"primary_region": "ord"},
            "machines": {
                "web": {
                    "config": {"image": PRIMARY},
                    "image": {"existingImage": PRIMARY},
                },
                "worker": {
                    "config": {"image": WORKER},
                    "image": {"existingImage": WORKER},
                },
            },
        }
        self._flight_files(spec=spec)
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot select a single primary deploy image", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_derivation_payload_must_carry_its_declared_store_path(self):
        store_path = "/nix/store/" + "a" * 32 + "-fly-image"
        reference = "registry.fly.io/fly-alpha:nix-" + "a" * 32
        self._flight_files(
            spec={
                "name": APP,
                "settings": {"primary_region": "ord"},
                "machines": {"web": {"image": {"derivation": store_path}}},
            },
            payload={
                "app": APP,
                "registry": "registry.fly.io",
                "images": [
                    {
                        "kind": "derivation",
                        "source": store_path,
                        "reference": reference,
                        "digest": "sha256:" + "a" * 64,
                        "published": False,
                    }
                ],
                "machines": {
                    "web": {
                        "containers": {},
                        "image": {
                            "kind": "derivation",
                            "source": store_path,
                            "reference": reference,
                            "digest": "sha256:" + "a" * 64,
                            "published": False,
                        },
                    }
                },
            },
        )
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self._deploy()["image"], reference)

    def test_payload_reference_must_match_the_declared_image_source(self):
        spec = base_spec()
        payload = resolved_payload(spec)
        payload["machines"]["web"]["deployImage"]["reference"] = (
            "registry.fly.io/fly-alpha:not-declared"
        )
        payload["machines"]["web"]["deployImage"]["source"] = (
            "registry.fly.io/fly-alpha:not-declared"
        )
        self._flight_files(spec=spec, payload=payload)
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("does not match the declared image source", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_fly_rejection_is_nonzero_and_token_is_redacted(self):
        self._flight_files()
        result = self._invoke(deploy_fail=True, deploy_status="23")
        self.assertEqual(result.returncode, 23)
        self.assertIn("Fly rejected deployment", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("[REDACTED]", result.stderr)
        self.assertEqual(len(self._entries("deploy")), 1)

    def test_machine_listing_failure_fails_before_deploy_without_leaking_token(self):
        self._flight_files()
        result = self._invoke(list_fail=True, list_status="9")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not list Fly Machines", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertEqual(self._entries("deploy"), [])

    def test_missing_or_empty_token_fails_before_any_cli_call(self):
        self._flight_files()
        for token in (None, ""):
            with self.subTest(token=token):
                result = self._invoke(token=token)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FLY_API_TOKEN is required", result.stderr)
                self.assertEqual(self._entries("machine-list"), [])
                self.assertEqual(self._entries("deploy"), [])

    def test_token_with_line_breaks_fails_before_any_cli_call(self):
        self._flight_files()
        result = self._invoke(token=TOKEN + "\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FLY_API_TOKEN must not contain line breaks", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_usage_errors_are_rejected(self):
        self._flight_files()
        for arguments in (
            ["--spec", str(self.spec)],
            ["--images", str(self.images), "--spec", str(self.spec)],
            ["--spec", str(self.spec), "--images", str(self.images), "extra"],
        ):
            with self.subTest(arguments=arguments):
                result = self._invoke(arguments=arguments)
                self.assertEqual(result.returncode, 2)
                self.assertIn("usage: fly-app-reconcile", result.stderr)
                self.assertEqual(self._entries("machine-list"), [])
                self.assertEqual(self._entries("deploy"), [])

    def test_payload_for_a_different_app_is_rejected(self):
        spec = base_spec()
        payload = resolved_payload(spec)
        payload["app"] = "fly-beta"
        self._flight_files(spec=spec, payload=payload)
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("targets a different app", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_settings_cannot_override_app_identity_or_request_a_build(self):
        for key in ("app", "build"):
            with self.subTest(key=key):
                spec = base_spec()
                spec["settings"][key] = "unexpected"
                self._flight_files(spec=spec)
                result = self._invoke()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(key, result.stderr)
                self.assertEqual(self._entries("machine-list"), [])
                self.assertEqual(self._entries("deploy"), [])

    def test_a_spec_without_machines_cannot_select_a_deploy_image(self):
        self._flight_files(
            spec={"name": APP, "settings": {"primary_region": "ord"}, "machines": {}},
            payload={"app": APP, "registry": "registry.fly.io", "images": [], "machines": {}},
        )
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no declared Machine provides a deploy image", result.stderr)
        self.assertEqual(self._entries("machine-list"), [])
        self.assertEqual(self._entries("deploy"), [])

    def test_token_is_absent_from_the_built_program(self):
        embedded = [
            Path(path)
            for path in re.findall(
                r"/nix/store/[^\s\"']+\.py", self.package.read_text(encoding="utf-8")
            )
        ]
        self.assertTrue(embedded, self.package)
        for path in [self.package, *embedded]:
            self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path))


if __name__ == "__main__":
    unittest.main()
