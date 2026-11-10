#!/usr/bin/env python3
"""Behavioral regression tests for the operator-run Fly smoke harness."""

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
    fixture = "FLY_TEST_BEFORE_MACHINES" if count == 0 else "FLY_TEST_AFTER_MACHINES"
    output.write_text(os.environ[fixture])
elif "/v1/apps/" in url:
    output.write_text(json.dumps({"name": os.environ["FLY_SMOKE_CONFIRM_APP"]}))
elif "/manifests/" in url:
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

if sys.argv[1:3] != ["deploy", "--app"] or sys.argv[3] != os.environ["FLY_SMOKE_CONFIRM_APP"]:
    sys.exit(2)
pathlib.Path(os.environ["FLY_TEST_DEPLOY_MARKER"]).write_text("deployed")
if os.environ.get("FLY_TEST_DEPLOY_FAIL") == "1":
    sys.exit(1)
''',
        )
        for command in ("jq", "base64", "mktemp", "tr", "sleep"):
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
            ["bash", str(HARNESS), "demo", "registry.fly.io/demo:smoke"],
            check=False,
            capture_output=True,
            text=True,
            env=env,
            timeout=10,
        )
        self.assertNotIn("test-only-token-do-not-log", result.stdout + result.stderr)
        return result, marker

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
