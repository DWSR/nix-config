#!/usr/bin/env python3
"""Fly CLI app-settings deployment tests for the Fly app reconciler."""

import copy
import http.server
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import threading
import tomllib
import unittest
import urllib.parse


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


def count(command):
    path = Path(os.environ["FLY_TEST_LOG"])
    if not path.exists():
        return 0
    return sum(
        1
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and json.loads(line).get("command") == command
    )


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
    attempt = count("machine-list")
    record({"command": "machine-list", **common, "attempt": attempt})
    failure = "FLY_TEST_LIST_FAIL_AFTER" if attempt else "FLY_TEST_LIST_FAIL"
    if os.environ.get(failure):
        print("stub flyctl: simulated Machine listing failure " + token, file=sys.stderr)
        raise SystemExit(int(os.environ.get("FLY_TEST_LIST_STATUS", "4")))
    payload = os.environ.get(
        "FLY_TEST_MACHINES" if attempt == 0 else "FLY_TEST_MACHINES_AFTER",
        os.environ.get("FLY_TEST_MACHINES", "[]"),
    )
    sys.stdout.write(payload)
    raise SystemExit(0)

if args[:1] == ["machine"]:
    record(
        {
            "command": "machine-" + (args[1] if len(args) > 1 else "unknown"),
            **common,
        }
    )
    print("stub flyctl: unexpected machine subcommand " + repr(args), file=sys.stderr)
    raise SystemExit(64)

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


class StubMachinesAPI:
    """Stateful stand-in for the Fly Machines API used by the reconciler."""

    def __init__(self):
        self.machines = {}
        self.requests = []
        self.fail_auth = False
        self.fail_create = None
        self.fail_update = None
        self.fail_update_machine_key = None
        self.ambiguous_create = False
        self.drop_field = None
        self.surplus_after_update = False
        self.lock = threading.Lock()
        api = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, payload=None):
                body = b"" if payload is None else json.dumps(payload).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def read_body(self):
                length = int(self.headers.get("Content-Length") or 0)
                if not length:
                    return None
                return json.loads(self.rfile.read(length))

            def do_GET(self):
                api.handle(self, "GET", None)

            def do_POST(self):
                api.handle(self, "POST", self.read_body())

        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:{}".format(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def reset(self, machines):
        with self.lock:
            self.machines = {}
            self.requests = []
            for entry in machines:
                if not isinstance(entry, dict):
                    continue
                machine_id = entry.get("id")
                config = entry.get("config")
                if not isinstance(machine_id, str) or not isinstance(config, dict):
                    continue
                self.machines[machine_id] = {
                    "id": machine_id,
                    "region": entry.get("region", "ord"),
                    "config": copy.deepcopy(config),
                }

    def snapshot(self):
        with self.lock:
            return copy.deepcopy(list(self.machines.values()))

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def creations(self):
        with self.lock:
            return [
                request["body"]
                for request in self.requests
                if request["method"] == "POST" and request["machine_id"] is None
            ]

    def updates(self):
        with self.lock:
            return [
                request
                for request in self.requests
                if request["method"] == "POST" and request["machine_id"] is not None
            ]

    def handle(self, handler, method, body):
        with self.lock:
            path = urllib.parse.urlparse(handler.path).path
            parts = [part for part in path.split("/") if part]
            machine_id = parts[4] if len(parts) > 4 else None
            self.requests.append(
                {
                    "method": method,
                    "path": path,
                    "machine_id": machine_id,
                    "body": body,
                    "authorization": handler.headers.get("Authorization"),
                }
            )
            if self.fail_auth:
                handler.reply(401, {"error": "unauthorized"})
                return
            if parts[:4] != ["v1", "apps", APP, "machines"]:
                handler.reply(404, {"error": "unexpected path"})
                return
            if method == "GET" and machine_id is None:
                handler.reply(200, {"machines": list(self.machines.values())})
                return
            if method == "GET":
                machine = self.machines.get(machine_id)
                handler.reply(200 if machine else 404, machine or {"error": "missing"})
                return
            if method == "POST" and machine_id is None:
                if self.fail_create:
                    handler.reply(self.fail_create, {"error": "create rejected"})
                    return
                created = "machine-created-{}".format(len(self.machines) + 1)
                machine = {
                    "id": created,
                    "region": (body or {}).get("region", "ord"),
                    "config": copy.deepcopy(body["config"]),
                }
                self.machines[created] = machine
                if self.ambiguous_create:
                    self.ambiguous_create = False
                    handler.reply(500, {"error": "create response lost"})
                    return
                handler.reply(200, machine)
                return
            if method == "POST":
                config_body = (body or {}).get("config") or {}
                metadata = config_body.get("metadata") or {}
                wanted_key = (
                    metadata.get("fly_app_module_key")
                    if isinstance(metadata, dict)
                    else None
                )
                if self.fail_update and (
                    self.fail_update_machine_key is None
                    or self.fail_update_machine_key == wanted_key
                ):
                    handler.reply(self.fail_update, {"error": "update rejected"})
                    return
                machine = self.machines.get(machine_id)
                if machine is None:
                    handler.reply(404, {"error": "missing"})
                    return
                config = copy.deepcopy(body["config"])
                if self.drop_field:
                    config.pop(self.drop_field, None)
                machine["config"] = config
                if self.surplus_after_update:
                    self.machines["machine-surplus"] = {
                        "id": "machine-surplus",
                        "region": "ord",
                        "config": {"metadata": {"fly_app_module_key": "surplus"}},
                    }
                    self.surplus_after_update = False
                handler.reply(200, machine)
                return
            handler.reply(405, {"error": "method not allowed"})


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


def fly_machine(machine_id, process_group=None, module_key=None, metadata=None, **fields):
    values = dict(metadata or {})
    if process_group is not None:
        values["fly_process_group"] = process_group
    if module_key is not None:
        values["fly_app_module_key"] = module_key
    config = {"metadata": values} if values else {}
    config.update(fields)
    return {"id": machine_id, "config": config}


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


def full_spec():
    spec = base_spec()
    spec["machines"]["web"]["config"] = {
        "guest": {"cpu_kind": "shared", "cpus": 2, "memory_mb": 1024},
        "env": {"APP_MODE": "web"},
        "services": [
            {
                "internal_port": 8080,
                "protocol": "tcp",
                "ports": [{"port": 80, "handlers": ["http"]}],
            }
        ],
        "restart": {"policy": "on-failure", "max_retries": 3},
        "metadata": {"owner": "platform"},
        "init": {"cmd": ["/app/web"]},
    }
    spec["machines"]["web"]["containers"]["sidecar"]["config"].update(
        {
            "entrypoint": ["/bin/sidecar"],
            "env": {"SIDECAR": "enabled"},
            "user": "1000",
        }
    )
    spec["machines"]["worker"]["config"] = {
        "guest": {"cpu_kind": "performance", "cpus": 1, "memory_mb": 2048},
        "env": {"APP_MODE": "worker"},
        "schedule": "hourly",
        "metadata": {"owner": "platform"},
    }
    return spec


def single_machine_spec(declared_mounts=None):
    config = {"image": PRIMARY}
    if declared_mounts is not None:
        config["mounts"] = declared_mounts
    return {
        "name": APP,
        "settings": {"primary_region": "ord"},
        "machines": {
            "web": {
                "config": config,
                "image": {"existingImage": PRIMARY},
            }
        },
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
        self.api = StubMachinesAPI()

    def tearDown(self):
        self.api.close()
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
        list_fail_after=False,
        deploy_fail=False,
        deploy_status="7",
        list_status="4",
        machines_after=None,
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
                "FLY_MACHINES_API": self.api.url,
            }
        )
        if machines_after is not None:
            env["FLY_TEST_MACHINES_AFTER"] = json.dumps(machines_after)
        if token is not None:
            env["FLY_API_TOKEN"] = token
        if list_fail:
            env["FLY_TEST_LIST_FAIL"] = "1"
        if list_fail_after:
            env["FLY_TEST_LIST_FAIL_AFTER"] = "1"
        if deploy_fail:
            env["FLY_TEST_DEPLOY_FAIL"] = "1"
        return env

    def _invoke(self, *, arguments=None, seed=True, **environment):
        if seed:
            after = environment.get("machines_after")
            self.api.reset(self.machines if after is None else after)
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

    def _commands(self):
        if not self.log.exists():
            return []
        return [
            json.loads(line)["command"]
            for line in self.log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

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
        self.assertEqual(len(machine_lists), 2)
        self.assertIn("matched Machines for app 'fly-alpha': none", result.stderr)
        self.assertIn(
            "missing declared Machines for app 'fly-alpha': web worker",
            result.stderr,
        )
        creations = {
            body["config"]["metadata"]["fly_app_module_key"]: body
            for body in self.api.creations()
        }
        self.assertEqual(sorted(creations), ["web", "worker"])
        self.assertEqual(
            sorted(
                container["name"]
                for container in creations["web"]["config"]["containers"]
            ),
            ["app", "sidecar"],
        )
        self.assertEqual(creations["worker"]["config"]["image"], WORKER)
        self.assertTrue(
            all(
                request["authorization"] == "Bearer " + TOKEN
                for request in self.api.requests
            )
        )
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

    def test_maps_declared_machine_keys_to_post_deploy_fly_ids(self):
        self._flight_files()
        self.machines = []
        result = self._invoke(
            machines_after=[
                fly_machine("machine-web", process_group="web", image=PRIMARY),
                fly_machine("machine-worker", process_group="worker", image=WORKER),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("matched Machines", result.stderr)
        self.assertIn("web=machine-web", result.stderr)
        self.assertIn("worker=machine-worker", result.stderr)
        self.assertNotIn("missing declared Machines", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

        machine_lists = self._entries("machine-list")
        self.assertEqual(len(machine_lists), 2)
        self.assertEqual(machine_lists[0]["attempt"], 0)
        self.assertEqual(machine_lists[1]["attempt"], 1)
        self.assertEqual(len(self._entries("deploy")), 1)

    def test_module_identity_metadata_maps_machines_created_through_the_api(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web", module_key="web"),
            fly_machine("machine-worker", process_group="worker", module_key="worker"),
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("web=machine-web", result.stderr)
        self.assertIn("worker=machine-worker", result.stderr)
        self.assertNotIn("missing declared Machines", result.stderr)
        self.assertNotIn("surplus", result.stderr)

    def test_module_identity_metadata_takes_precedence_over_a_launch_group(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="app", module_key="web"),
            fly_machine("machine-worker", process_group="worker", module_key="worker"),
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("web=machine-web", result.stderr)
        self.assertIn("worker=machine-worker", result.stderr)

    def test_unmanaged_machines_do_not_suppress_first_deploy_machine_creation(self):
        self._flight_files()
        stray = {"id": "machine-stray", "config": {"image": PRIMARY}}
        self.machines = [stray]
        result = self._invoke(
            machines_after=[
                stray,
                fly_machine("machine-web", process_group="web"),
                fly_machine("machine-worker", process_group="worker"),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        deploy = self._deploy()
        self.assertNotIn("--update-only", deploy["args"])
        self.assertIn("ignoring unmanaged Machines", result.stderr)

    def test_unmanaged_machines_are_reported_and_excluded_from_the_managed_set(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web", image=PRIMARY),
            fly_machine("machine-worker", process_group="worker", image=WORKER),
            {"id": "machine-stray", "config": {"image": PRIMARY}},
            {"id": "machine-debug", "config": {"metadata": {"owner": "operator"}}},
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("ignoring unmanaged Machines", result.stderr)
        self.assertIn("machine-debug", result.stderr)
        self.assertIn("machine-stray", result.stderr)
        self.assertIn("web=machine-web", result.stderr)
        self.assertIn("worker=machine-worker", result.stderr)
        self.assertNotIn("=machine-debug", result.stderr)
        self.assertNotIn("=machine-stray", result.stderr)
        self.assertNotIn("missing declared Machines", result.stderr)

    def test_ambiguous_matches_are_rejected_without_deleting(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web-a", process_group="web"),
            fly_machine("machine-web-b", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ambiguous matches for declared Machine 'web'", result.stderr)
        self.assertIn("machine-web-a", result.stderr)
        self.assertIn("machine-web-b", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertEqual(len(self._entries("deploy")), 1)
        self.assertEqual(set(self._commands()), {"machine-list", "deploy"})

    def test_marker_and_launch_identity_for_one_declaration_are_ambiguous(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web-api", process_group="app", module_key="web"),
            fly_machine("machine-web-launch", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("ambiguous matches for declared Machine 'web'", result.stderr)
        self.assertIn("machine-web-api", result.stderr)
        self.assertIn("machine-web-launch", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)

    def test_surplus_managed_machine_is_rejected_without_deleting(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
            fly_machine("machine-extra", process_group="cron"),
            fly_machine("machine-batch", module_key="batch"),
        ]
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("surplus module-managed Machine", result.stderr)
        self.assertIn("machine-extra", result.stderr)
        self.assertIn("cron", result.stderr)
        self.assertIn("machine-batch", result.stderr)
        self.assertIn("batch", result.stderr)
        self.assertIn("never deletes Machines", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertEqual(len(self._entries("deploy")), 1)
        self.assertEqual(set(self._commands()), {"machine-list", "deploy"})

    def test_missing_declared_machines_are_created_through_the_api(self):
        self._flight_files()
        self.machines = []
        result = self._invoke(
            machines_after=[fly_machine("machine-web", process_group="web")]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("web=machine-web", result.stderr)
        self.assertIn("missing declared Machines", result.stderr)
        self.assertIn("creating them through the Machines API", result.stderr)
        creations = {
            body["config"]["metadata"]["fly_app_module_key"]: body
            for body in self.api.creations()
        }
        self.assertEqual(sorted(creations), ["worker"])
        self.assertEqual(creations["worker"]["config"]["image"], WORKER)
        self.assertIn("worker=machine-created-2", result.stderr)
        self.assertIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertEqual(self._commands().count("deploy"), 1)
        self.assertEqual(set(self._commands()), {"machine-list", "deploy"})

    def test_post_deploy_machine_listing_failure_returns_failure(self):
        self._flight_files()
        self.machines = [fly_machine("machine-web", process_group="web")]
        result = self._invoke(list_fail_after=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not list Fly Machines", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertEqual(len(self._entries("machine-list")), 2)
        self.assertEqual(len(self._entries("deploy")), 1)

    def test_malformed_machine_entries_fail_instead_of_succeeding(self):
        cases = {
            "missing id": [{"config": {"metadata": {"fly_process_group": "web"}}}],
            "empty id": [{"id": "", "config": {}}],
            "missing config": [{"id": "machine-web"}],
            "non-object config": [{"id": "machine-web", "config": "not-an-object"}],
            "non-string module identity": [
                {"id": "machine-web", "config": {"metadata": {"fly_app_module_key": 3}}}
            ],
            "empty launch identity": [
                {"id": "machine-web", "config": {"metadata": {"fly_process_group": ""}}}
            ],
        }
        for label, machines in cases.items():
            with self.subTest(case=label):
                if self.log.exists():
                    self.log.unlink()
                self._flight_files()
                self.machines = []
                result = self._invoke(machines_after=machines)
                self.assertNotEqual(result.returncode, 0, label)
                self.assertIn("Fly", result.stderr)
                self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_reconciliation_mutates_only_through_the_machines_api(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self._commands()), {"machine-list", "deploy"})
        self.assertEqual(self.api.creations(), [])
        self.assertEqual(
            sorted(request["machine_id"] for request in self.api.updates()),
            ["machine-web", "machine-worker"],
        )
        self.assertFalse(
            [
                request
                for request in self.api.requests
                if request["method"] not in ("GET", "POST")
            ]
        )

    def test_updates_every_declared_machine_and_preserves_launch_metadata(self):
        self._flight_files()
        self.machines = [
            fly_machine(
                "machine-web",
                process_group="web",
                metadata={"fly_platform_version": "v2", "fly_release_id": "rel-1"},
                image=PRIMARY,
            ),
            fly_machine(
                "machine-worker",
                process_group="worker",
                metadata={"fly_platform_version": "v2"},
                image=WORKER,
            ),
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        updates = {
            request["machine_id"]: request["body"]["config"]
            for request in self.api.updates()
        }
        self.assertEqual(sorted(updates), ["machine-web", "machine-worker"])
        web = updates["machine-web"]
        self.assertEqual(web["metadata"]["fly_process_group"], "web")
        self.assertEqual(web["metadata"]["fly_platform_version"], "v2")
        self.assertEqual(web["metadata"]["fly_release_id"], "rel-1")
        self.assertEqual(web["metadata"]["fly_app_module_key"], "web")
        self.assertEqual(
            sorted(container["name"] for container in web["containers"]),
            ["app", "sidecar"],
        )
        self.assertEqual(updates["machine-worker"]["image"], WORKER)
        final = {
            machine["config"]["metadata"]["fly_app_module_key"]: machine["config"]
            for machine in self.api.snapshot()
        }
        self.assertEqual(sorted(final), ["web", "worker"])
        self.assertEqual(final["web"]["metadata"]["fly_process_group"], "web")
        self.assertEqual(final["worker"]["metadata"]["fly_platform_version"], "v2")

    def test_creates_missing_machines_with_full_declared_configs(self):
        spec = full_spec()
        self._flight_files(spec=spec)
        self.machines = []
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        creations = {
            body["config"]["metadata"]["fly_app_module_key"]: body["config"]
            for body in self.api.creations()
        }
        self.assertEqual(sorted(creations), ["web", "worker"])
        web = creations["web"]
        self.assertEqual(web["guest"], spec["machines"]["web"]["config"]["guest"])
        self.assertEqual(web["env"], {"APP_MODE": "web"})
        self.assertEqual(
            web["services"], spec["machines"]["web"]["config"]["services"]
        )
        self.assertEqual(web["metadata"]["owner"], "platform")
        containers = {container["name"]: container for container in web["containers"]}
        self.assertEqual(sorted(containers), ["app", "sidecar"])
        self.assertEqual(containers["app"]["image"], PRIMARY)
        self.assertEqual(containers["sidecar"]["image"], SIDECAR)
        self.assertEqual(containers["sidecar"]["entrypoint"], ["/bin/sidecar"])
        self.assertEqual(
            creations["worker"]["guest"],
            spec["machines"]["worker"]["config"]["guest"],
        )
        self.assertEqual(creations["worker"]["schedule"], "hourly")
        self.assertEqual(len(self.api.snapshot()), 2)

    def test_two_consecutive_deployments_retain_full_machine_configs(self):
        spec = full_spec()
        self._flight_files(spec=spec)
        self.machines = []
        launch = [
            fly_machine(
                "machine-web",
                process_group="web",
                metadata={"fly_platform_version": "v2"},
            ),
            fly_machine(
                "machine-worker",
                process_group="worker",
                metadata={"fly_platform_version": "v2"},
            ),
        ]
        first = self._invoke(machines_after=launch)
        self.assertEqual(first.returncode, 0, first.stderr)
        self.machines = self.api.snapshot()
        second = self._invoke(machines_after=self.machines, seed=False)
        self.assertEqual(second.returncode, 0, second.stderr)
        deploys = self._entries("deploy")
        self.assertEqual(len(deploys), 2)
        self.assertNotIn("--update-only", deploys[0]["args"])
        self.assertIn("--update-only", deploys[1]["args"])

        final = {
            machine["config"]["metadata"]["fly_app_module_key"]: machine["config"]
            for machine in self.api.snapshot()
        }
        self.assertEqual(sorted(final), ["web", "worker"])
        web = final["web"]
        self.assertEqual(web["guest"], spec["machines"]["web"]["config"]["guest"])
        self.assertEqual(web["env"], {"APP_MODE": "web"})
        self.assertEqual(web["services"], spec["machines"]["web"]["config"]["services"])
        self.assertEqual(
            web["restart"], spec["machines"]["web"]["config"]["restart"]
        )
        self.assertEqual(web["init"], spec["machines"]["web"]["config"]["init"])
        self.assertEqual(web["metadata"]["owner"], "platform")
        self.assertEqual(web["metadata"]["fly_process_group"], "web")
        self.assertEqual(web["metadata"]["fly_platform_version"], "v2")
        containers = {container["name"]: container for container in web["containers"]}
        self.assertEqual(sorted(containers), ["app", "sidecar"])
        self.assertEqual(containers["app"]["image"], PRIMARY)
        self.assertEqual(containers["sidecar"]["image"], SIDECAR)
        self.assertEqual(containers["sidecar"]["entrypoint"], ["/bin/sidecar"])
        self.assertEqual(containers["sidecar"]["env"], {"SIDECAR": "enabled"})
        self.assertEqual(containers["sidecar"]["user"], "1000")
        worker = final["worker"]
        self.assertEqual(
            worker["guest"], spec["machines"]["worker"]["config"]["guest"]
        )
        self.assertEqual(worker["schedule"], "hourly")
        self.assertEqual(worker["image"], WORKER)
        self.assertEqual(worker["metadata"]["owner"], "platform")
        self.assertEqual(worker["metadata"]["fly_process_group"], "worker")

    def test_update_failure_returns_nonzero_and_does_not_report_success(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        self.api.fail_update = 500
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Fly Machines API", result.stderr)
        self.assertIn("HTTP 500", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_create_failure_returns_nonzero_and_does_not_report_success(self):
        self._flight_files()
        self.machines = []
        self.api.fail_create = 422
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Fly Machines API", result.stderr)
        self.assertIn("HTTP 422", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)

    def test_failed_partial_update_returns_nonzero_and_retry_reuses_same_machines(self):
        spec = full_spec()
        self._flight_files(spec=spec)
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        self.api.fail_update = 500
        self.api.fail_update_machine_key = "worker"
        first = self._invoke()
        self.assertNotEqual(first.returncode, 0)
        self.assertIn("Machine 'worker'", first.stderr)
        self.assertIn("no rollback", first.stderr)
        self.assertIn("HTTP 500", first.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", first.stderr)
        self.assertNotIn(TOKEN, first.stdout + first.stderr)

        after_failure = {
            machine["id"]: machine["config"] for machine in self.api.snapshot()
        }
        self.assertEqual(sorted(after_failure), ["machine-web", "machine-worker"])
        self.assertEqual(after_failure["machine-web"]["env"], {"APP_MODE": "web"})
        self.assertNotIn("env", after_failure["machine-worker"])
        self.assertEqual(self.api.creations(), [])
        update_attempts = len(self.api.updates())

        self.api.fail_update = None
        self.api.fail_update_machine_key = None
        self.machines = self.api.snapshot()
        retry = self._invoke(seed=False, machines_after=[])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        final = {
            machine["id"]: machine["config"] for machine in self.api.snapshot()
        }
        self.assertEqual(sorted(final), ["machine-web", "machine-worker"])
        self.assertEqual(final["machine-worker"]["env"], {"APP_MODE": "worker"})
        self.assertEqual(len(self.api.updates()), update_attempts + 2)
        self.assertEqual(self.api.creations(), [])
        self.assertFalse(
            [request for request in self.api.requests if request["method"] == "DELETE"]
        )
        self.assertIn("fly-app-reconcile: deployed app", retry.stderr)

    def test_ambiguous_create_is_adopted_by_retry_without_a_duplicate(self):
        self._flight_files()
        self.machines = []
        self.api.ambiguous_create = True
        first = self._invoke()
        self.assertNotEqual(first.returncode, 0)
        self.assertIn("Machine 'web'", first.stderr)
        self.assertIn("no rollback", first.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", first.stderr)

        created = self.api.snapshot()
        self.assertEqual(len(created), 1)
        created_id = created[0]["id"]
        self.assertEqual(
            created[0]["config"]["metadata"]["fly_app_module_key"], "web"
        )

        self.machines = created
        retry = self._invoke(seed=False, machines_after=[])
        self.assertEqual(retry.returncode, 0, retry.stderr)
        final = {
            machine["config"]["metadata"]["fly_app_module_key"]: machine["id"]
            for machine in self.api.snapshot()
        }
        self.assertEqual(sorted(final), ["web", "worker"])
        self.assertEqual(final["web"], created_id)
        created_keys = [
            body["config"]["metadata"]["fly_app_module_key"]
            for body in self.api.creations()
        ]
        self.assertEqual(sorted(created_keys), ["web", "worker"])
        self.assertFalse(
            [request for request in self.api.requests if request["method"] == "DELETE"]
        )
        self.assertIn("fly-app-reconcile: deployed app", retry.stderr)

    def test_mount_set_changes_require_replacement_without_mutation(self):
        cases = {
            "attach": (
                [{"volume": "vol-new", "path": "/data"}],
                None,
            ),
            "detach": (
                None,
                [{"volume": "vol-old", "path": "/data"}],
            ),
            "swap": (
                [{"volume": "vol-new", "path": "/data"}],
                [{"volume": "vol-old", "path": "/data"}],
            ),
        }
        for label, (declared, existing) in cases.items():
            with self.subTest(case=label):
                if self.log.exists():
                    self.log.unlink()
                self._flight_files(spec=single_machine_spec(declared))
                fields = {"process_group": "web", "image": PRIMARY}
                if existing is not None:
                    fields["mounts"] = existing
                self.machines = [fly_machine("machine-web", **fields)]
                self.api.reset(self.machines)
                result = self._invoke(seed=False)
                self.assertNotEqual(result.returncode, 0, result.stderr)
                self.assertIn("Machine 'web'", result.stderr)
                self.assertIn("replacement-required", result.stderr)
                self.assertIn("requires replacement", result.stderr)
                self.assertIn("'mounts'", result.stderr)
                self.assertIn("never deletes", result.stderr)
                self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)
                self.assertEqual(self.api.updates(), [])
                self.assertEqual(len(self.api.snapshot()), 1)

    def test_replacement_rejection_does_not_mutate_other_machines(self):
        spec = base_spec()
        spec["machines"]["web"]["config"] = {
            "mounts": [{"volume": "vol-new", "path": "/data"}]
        }
        self._flight_files(spec=spec)
        self.machines = [
            fly_machine(
                "machine-web",
                process_group="web",
                mounts=[{"volume": "vol-old", "path": "/data"}],
            ),
            fly_machine("machine-worker", process_group="worker", image=WORKER),
        ]
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("replacement-required", result.stderr)
        self.assertIn("Machine 'web'", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)
        self.assertEqual(self.api.updates(), [])
        self.assertEqual(self.api.creations(), [])
        self.assertEqual(len(self.api.snapshot()), 2)

    def test_mount_path_change_is_applied_in_place(self):
        declared = [{"volume": "vol-one", "path": "/mnt/data"}]
        self._flight_files(spec=single_machine_spec(declared))
        self.machines = [
            fly_machine(
                "machine-web",
                process_group="web",
                image=PRIMARY,
                mounts=[{"volume": "vol-one", "path": "/data"}],
            )
        ]
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        updates = self.api.updates()
        self.assertEqual(len(updates), 1)
        self.assertEqual(updates[0]["body"]["config"]["mounts"], declared)
        self.assertEqual(len(self.api.snapshot()), 1)
        self.assertIn("fly-app-reconcile: deployed app", result.stderr)

    def test_machines_api_authentication_failure_is_reported_without_the_token(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        self.api.fail_auth = True
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Machines API authentication failed", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)

    def test_missing_field_after_update_fails_final_verification(self):
        self._flight_files(spec=full_spec())
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        self.api.drop_field = "guest"
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("did not retain the declared configuration", result.stderr)
        self.assertIn("guest", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)

    def test_surplus_managed_machine_during_api_reconciliation_fails(self):
        self._flight_files()
        self.machines = [
            fly_machine("machine-web", process_group="web"),
            fly_machine("machine-worker", process_group="worker"),
        ]
        self.api.surplus_after_update = True
        result = self._invoke()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("surplus module-managed Machine", result.stderr)
        self.assertNotIn("fly-app-reconcile: deployed app", result.stderr)

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
