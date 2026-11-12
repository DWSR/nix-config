#!/usr/bin/env python3
"""Runtime confidentiality and orchestration tests for the Fly deploy wrapper."""

import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fly-app/fixture"
DEPLOY_SCRIPT = Path(os.environ.get("FLY_APP_DEPLOY_NIX", ROOT / "scripts/fly-app-deploy.nix"))
TOKEN = "fixture-" + secrets.token_hex(16)
SPEC = '{"name":"fixture-app"}'

STUB_ORCHESTRATION_PUBLISHER = """
import json
import os
from pathlib import Path
import sys

args = sys.argv[1:]
if len(args) != 2 or args[0] != "--spec":
    print("stub publisher: unexpected arguments", file=sys.stderr)
    raise SystemExit(64)
spec_path = Path(args[1])
spec = json.loads(spec_path.read_text(encoding="utf-8"))
if "FLY_TEST_PUBLISH_PAYLOAD" in os.environ:
    payload = json.loads(os.environ["FLY_TEST_PUBLISH_PAYLOAD"])
else:
    payload = {
        "app": spec.get("name"),
        "registry": "registry.fly.io",
        "images": [],
        "machines": {},
    }
record = {
    "spec_path": str(spec_path),
    "spec": spec,
    "payload": payload,
    "token_present": "FLY_API_TOKEN" in os.environ,
    "docker_config": os.environ.get("DOCKER_CONFIG"),
}
Path(os.environ["FLY_TEST_PUBLISH_LOG"]).write_text(
    json.dumps(record), encoding="utf-8"
)
status = int(os.environ.get("FLY_TEST_PUBLISH_STATUS", "0"))
if status:
    print(
        "stub publisher failed token=" + os.environ.get("FLY_API_TOKEN", ""),
        file=sys.stderr,
    )
    raise SystemExit(status)
if not os.environ.get("FLY_TEST_PUBLISH_EMPTY"):
    sys.stdout.write(json.dumps(payload, indent=2, sort_keys=True) + "\\n")
"""

STUB_ORCHESTRATION_RECONCILER = """
import json
import os
from pathlib import Path
import stat
import sys

args = sys.argv[1:]
if len(args) != 4 or args[0] != "--spec" or args[2] != "--images":
    print("stub reconciler: unexpected arguments", file=sys.stderr)
    raise SystemExit(64)
spec_path = Path(args[1])
images_path = Path(args[3])
record = {
    "spec_path": str(spec_path),
    "images_path": str(images_path),
    "images": images_path.read_text(encoding="utf-8") if images_path.is_file() else None,
    "images_mode": stat.S_IMODE(images_path.stat().st_mode) if images_path.exists() else None,
    "token_present": "FLY_API_TOKEN" in os.environ,
}
Path(os.environ["FLY_TEST_RECONCILE_LOG"]).write_text(
    json.dumps(record), encoding="utf-8"
)
print(
    "stub reconciler seen token=" + os.environ.get("FLY_API_TOKEN", ""),
    file=sys.stderr,
)
status = int(os.environ.get("FLY_TEST_RECONCILE_STATUS", "0"))
if status:
    print("stub reconciler rejected deployment", file=sys.stderr)
    raise SystemExit(status)
print("stub reconciler accepted deployment")
"""


class FlyDeployCredentialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="fly-deploy-package-")
        cls.root = Path(cls.temp.name)
        cls.package = cls._build_package()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def _build_package(cls):
        script = DEPLOY_SCRIPT
        expression = f'''
          let
            flake = builtins.getFlake "path:{FIXTURE}";
            pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
            publisher = pkgs.writeShellScriptBin "fly-app-publish" ''
              exec ${{pkgs.python3}}/bin/python3 -c '
              import base64, json, os, pathlib, stat, sys
              config_dir = pathlib.Path(os.environ["DOCKER_CONFIG"])
              config_file = config_dir / "config.json"
              raw = config_file.read_text(encoding="utf-8")
              token = os.environ["FLY_API_TOKEN"]
              config = json.loads(raw)
              auth = config["auths"]["registry.fly.io"]["auth"]
              report = {{
                  "auth_matches": auth == base64.b64encode(("x:" + token).encode()).decode(),
                  "config_mode": stat.S_IMODE(config_file.stat().st_mode),
                  "directory_mode": stat.S_IMODE(config_dir.stat().st_mode),
                  "config_has_literal_token": token in raw,
                  "argv": sys.argv[1:],
                  "config_path": str(config_file),
                  "home_path": os.environ["HOME"],
                  "home_mode": stat.S_IMODE(pathlib.Path(os.environ["HOME"]).stat().st_mode),
              }}
              pathlib.Path(os.environ["FLY_TEST_REPORT"]).write_text(json.dumps(report), encoding="utf-8")
              spec_path = sys.argv[sys.argv.index("--spec") + 1]
              with open(spec_path, encoding="utf-8") as spec_file:
                  spec = json.load(spec_file)
              payload = {{
                  "app": spec["name"],
                  "registry": "registry.fly.io",
                  "images": [],
                  "machines": {{}},
                  "diagnostics": [
                      "publisher stdout token=" + token,
                      "publisher stdout base64=" + base64.b64encode(token.encode()).decode(),
                      "publisher completed",
                  ],
              }}
              print(json.dumps(payload))
              print("publisher stderr token", token, sep="=", file=sys.stderr)
              print("publisher stderr docker-auth", base64.b64encode(("x:" + token).encode()).decode(), sep="=", file=sys.stderr)
              sys.exit(int(os.environ.get("FLY_TEST_STATUS", "0")))
              ' "$@"
            '';
            reconciler = pkgs.writeShellScriptBin "fly-app-reconcile" ''
              exit 0
            '';
          in
            import {script} {{ inherit pkgs publisher reconciler; }}
        '''
        result = subprocess.run(
            ["nix", "build", "--impure", "--no-link", "--print-out-paths", "--expr", expression],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip().splitlines()[-1]) / "bin/fly-app-deploy"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fly-deploy-runtime-")
        self.root = Path(self.temp.name)
        self.report = self.root / "publisher-report.json"
        self.spec = self.root / "spec.json"
        self.spec.write_text(SPEC, encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def _invoke(self, *, token=TOKEN, status="0"):
        env = os.environ.copy()
        env.update(
            {
                "FLY_API_TOKEN": token,
                "FLY_TEST_REPORT": str(self.report),
                "FLY_TEST_STATUS": status,
                "TMPDIR": str(self.root),
            }
        )
        return subprocess.run(
            [str(self.package), "--spec", str(self.spec)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_private_runtime_docker_credentials_reach_publisher_and_are_cleaned(self):
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("publisher stdout token=[REDACTED]", result.stdout)
        self.assertIn("publisher stdout base64=[REDACTED]", result.stdout)
        self.assertIn("publisher stderr token=[REDACTED]", result.stderr)
        self.assertIn("publisher stderr docker-auth=[REDACTED]", result.stderr)

        report = json.loads(self.report.read_text(encoding="utf-8"))
        self.assertTrue(report["auth_matches"])
        self.assertEqual(report["config_mode"], 0o600)
        self.assertEqual(report["directory_mode"], 0o700)
        self.assertEqual(report["home_mode"], 0o700)
        self.assertFalse(report["config_has_literal_token"])
        self.assertEqual(report["argv"], ["--spec", str(self.spec)])
        self.assertFalse(Path(report["config_path"]).exists())
        self.assertNotIn(TOKEN, self.report.read_text(encoding="utf-8"))
        self.assertEqual(list(self.root.glob("fly-app-deploy.*")), [])

    def test_invalid_spec_arguments_fail_before_publisher(self):
        result = subprocess.run(
            [str(self.package), "--spec", str(self.spec), "extra"],
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: fly-app-deploy", result.stderr)

        result = subprocess.run(
            [str(self.package), "--spec", str(self.root / "missing.json")],
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("spec is not readable", result.stderr)

    def test_missing_and_empty_tokens_fail_before_publisher(self):
        for token in (None, ""):
            with self.subTest(token=token):
                if self.report.exists():
                    self.report.unlink()
                env = os.environ.copy()
                env.pop("FLY_API_TOKEN", None)
                env.update({"FLY_TEST_REPORT": str(self.report), "TMPDIR": str(self.root)})
                if token is not None:
                    env["FLY_API_TOKEN"] = token
                result = subprocess.run(
                    [str(self.package), "--spec", str(self.spec)],
                    env=env,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FLY_API_TOKEN is required", result.stderr)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)
                self.assertFalse(self.report.exists())

    def test_publisher_failure_is_propagated_with_redacted_diagnostics(self):
        result = self._invoke(status="23")
        self.assertEqual(result.returncode, 23)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("publisher stdout token=[REDACTED]", result.stdout)
        self.assertIn("publisher stdout base64=[REDACTED]", result.stdout)
        self.assertIn("publisher stderr token=[REDACTED]", result.stderr)
        self.assertIn("publisher stderr docker-auth=[REDACTED]", result.stderr)
        self.assertFalse(Path(json.loads(self.report.read_text())["config_path"]).exists())
        self.assertEqual(list(self.root.glob("fly-app-deploy.*")), [])

    def test_token_is_supplied_to_publisher_through_environment_only(self):
        package_script = self.package.read_text(encoding="utf-8")
        self.assertIn('export FLY_API_TOKEN', package_script)
        self.assertNotIn(TOKEN, package_script)

    def test_tokens_with_line_breaks_fail_before_publisher(self):
        result = self._invoke(token=TOKEN + "\n")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FLY_API_TOKEN must not contain line breaks", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.report.exists())

    def test_secret_values_are_absent_from_deploy_invocation_arguments(self):
        env = os.environ.copy()
        env["FLY_API_TOKEN"] = TOKEN
        env["FLY_TEST_REPORT"] = str(self.report)
        env["TMPDIR"] = str(self.root)
        result = subprocess.run(
            [str(self.package), "--spec", str(self.spec), "--token", TOKEN],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.report.exists())

    def test_runtime_token_is_absent_from_built_program(self):
        for path in self.package.parent.rglob("*"):
            if path.is_file() and not path.is_symlink():
                self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path))


class FlyDeployOrchestrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="fly-deploy-orchestration-package-")
        cls.package = cls._build_package()

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    @classmethod
    def _build_package(cls):
        publisher_program = json.dumps(STUB_ORCHESTRATION_PUBLISHER)
        reconciler_program = json.dumps(STUB_ORCHESTRATION_RECONCILER)
        expression = f'''
          let
            flake = builtins.getFlake "path:{FIXTURE}";
            pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
            publisherProgram = pkgs.writeText "stub-orchestration-publisher.py" {publisher_program};
            reconcilerProgram = pkgs.writeText "stub-orchestration-reconciler.py" {reconciler_program};
            publisher = pkgs.writeShellScriptBin "fly-app-publish" ''
              exec ${{pkgs.python3}}/bin/python3 "${{publisherProgram}}" "$@"
            '';
            reconciler = pkgs.writeShellScriptBin "fly-app-reconcile" ''
              exec ${{pkgs.python3}}/bin/python3 "${{reconcilerProgram}}" "$@"
            '';
          in
            import {DEPLOY_SCRIPT} {{ inherit pkgs publisher reconciler; }}
        '''
        result = subprocess.run(
            ["nix", "build", "--impure", "--no-link", "--print-out-paths", "--expr", expression],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip().splitlines()[-1]) / "bin/fly-app-deploy"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fly-deploy-orchestration-")
        self.root = Path(self.temp.name)
        self.spec = self.root / "spec.json"
        self.spec.write_text(
            json.dumps({"name": "fly-alpha", "settings": {"primary_region": "ord"}}),
            encoding="utf-8",
        )
        self.publish_log = self.root / "publish.json"
        self.reconcile_log = self.root / "reconcile.json"

    def tearDown(self):
        self.temp.cleanup()

    def _environment(self, **overrides):
        env = os.environ.copy()
        env.pop("FLY_API_TOKEN", None)
        env.update(
            {
                "FLY_API_TOKEN": TOKEN,
                "TMPDIR": str(self.root),
                "FLY_TEST_PUBLISH_LOG": str(self.publish_log),
                "FLY_TEST_RECONCILE_LOG": str(self.reconcile_log),
            }
        )
        env.update(overrides)
        return env

    def _invoke(self, **overrides):
        return subprocess.run(
            [str(self.package), "--spec", str(self.spec)],
            env=self._environment(**overrides),
            capture_output=True,
            text=True,
            check=False,
        )

    def _caller(self, **overrides):
        caller = self.root / "caller.sh"
        caller.write_text(
            f'#!/bin/sh\nexec "{self.package}" --spec "{self.spec}"\n',
            encoding="utf-8",
        )
        caller.chmod(0o755)
        return subprocess.run(
            [str(caller)],
            env=self._environment(**overrides),
            capture_output=True,
            text=True,
            check=False,
        )

    def test_publisher_and_reconciler_share_the_selected_spec_and_resolved_images(self):
        result = self._invoke()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("stub reconciler seen token=[REDACTED]", result.stderr)
        self.assertIn("stub reconciler accepted deployment", result.stdout)

        publish = json.loads(self.publish_log.read_text(encoding="utf-8"))
        reconcile = json.loads(self.reconcile_log.read_text(encoding="utf-8"))
        self.assertEqual(publish["spec_path"], str(self.spec))
        self.assertEqual(publish["spec"]["name"], "fly-alpha")
        self.assertTrue(publish["token_present"])
        self.assertTrue(publish["docker_config"])
        self.assertEqual(reconcile["spec_path"], str(self.spec))
        self.assertIn("fly-app-deploy.", reconcile["images_path"])
        self.assertEqual(Path(reconcile["images_path"]).parent.parent, self.root)
        self.assertEqual(json.loads(reconcile["images"]), publish["payload"])
        self.assertEqual(reconcile["images_mode"], 0o600)
        self.assertTrue(reconcile["token_present"])
        self.assertFalse(Path(reconcile["images_path"]).exists())
        self.assertEqual(list(self.root.glob("fly-app-deploy.*")), [])

    def test_publisher_failure_propagates_status_without_running_the_reconciler(self):
        result = self._invoke(FLY_TEST_PUBLISH_STATUS="23")
        self.assertEqual(result.returncode, 23)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("stub publisher failed token=[REDACTED]", result.stderr)
        self.assertFalse(self.reconcile_log.exists())
        self.assertEqual(list(self.root.glob("fly-app-deploy.*")), [])

    def test_reconciler_failure_propagates_status_with_redacted_diagnostics(self):
        result = self._invoke(FLY_TEST_RECONCILE_STATUS="7")
        self.assertEqual(result.returncode, 7)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("stub reconciler seen token=[REDACTED]", result.stderr)
        self.assertIn("stub reconciler rejected deployment", result.stderr)
        self.assertTrue(self.publish_log.exists())
        self.assertTrue(self.reconcile_log.exists())
        self.assertEqual(list(self.root.glob("fly-app-deploy.*")), [])

    def test_empty_publisher_payload_fails_before_the_reconciler(self):
        result = self._invoke(FLY_TEST_PUBLISH_EMPTY="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("publisher produced no resolved image payload", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.reconcile_log.exists())

    def test_payload_for_a_different_app_is_rejected_before_the_reconciler(self):
        result = self._invoke(
            FLY_TEST_PUBLISH_PAYLOAD=json.dumps(
                {
                    "app": "fly-beta",
                    "registry": "registry.fly.io",
                    "images": [],
                    "machines": {},
                }
            )
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("resolved image payload targets app 'fly-beta'", result.stderr)
        self.assertIn("selected specification is app 'fly-alpha'", result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertFalse(self.reconcile_log.exists())

    def test_caller_script_observes_success_and_every_stubbed_failure(self):
        success = self._caller()
        self.assertEqual(success.returncode, 0, success.stderr)

        publisher_failure = self._caller(FLY_TEST_PUBLISH_STATUS="9")
        self.assertEqual(publisher_failure.returncode, 9, publisher_failure.stderr)

        reconciler_failure = self._caller(FLY_TEST_RECONCILE_STATUS="11")
        self.assertEqual(reconciler_failure.returncode, 11, reconciler_failure.stderr)

        for result in (success, publisher_failure, reconciler_failure):
            self.assertNotIn(TOKEN, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
