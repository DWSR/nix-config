#!/usr/bin/env python3
"""Runtime confidentiality tests for the Fly deploy credential wrapper."""

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
              print("publisher stdout token", token, sep="=")
              print("publisher stdout base64", base64.b64encode(token.encode()).decode(), sep="=")
              print("publisher stderr token", token, sep="=", file=sys.stderr)
              print("publisher stderr docker-auth", base64.b64encode(("x:" + token).encode()).decode(), sep="=", file=sys.stderr)
              print("publisher completed")
              sys.exit(int(os.environ.get("FLY_TEST_STATUS", "0")))
              ' "$@"
            '';
          in
            import {script} {{ inherit pkgs publisher; }}
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


if __name__ == "__main__":
    unittest.main()
