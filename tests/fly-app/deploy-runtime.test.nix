{ pkgs }:
let
  publisherTest = pkgs.writeText "fly-app-publisher-fixture.py" ''
    import base64
    import json
    import os
    from pathlib import Path
    import stat
    import sys
    import time

    args = sys.argv[1:]
    if os.environ.get("FLY_TEST_WAIT_FOR_SIGNAL"):
        Path(os.environ["FLY_TEST_WAIT_FOR_SIGNAL"]).write_text(str(os.getpid()))
        while True:
            time.sleep(0.01)
    token = os.environ["FLY_API_TOKEN"]
    expected = os.environ["FLY_TEST_EXPECTED_TOKEN"]
    docker_config = Path(os.environ["DOCKER_CONFIG"])
    home = Path(os.environ["HOME"])
    config_path = docker_config / "config.json"
    config_stat = config_path.stat()
    if token != expected:
        raise SystemExit("runtime token was not forwarded")
    if stat.S_IMODE(config_stat.st_mode) != 0o600:
        raise SystemExit("Docker credentials are not mode 0600")
    if stat.S_IMODE(docker_config.stat().st_mode) != 0o700:
        raise SystemExit("Docker config directory is not private")
    if stat.S_IMODE(home.stat().st_mode) != 0o700:
        raise SystemExit("isolated runtime home is not private")

    config = json.loads(config_path.read_text())
    auth = config["auths"]["registry.fly.io"]["auth"]
    if base64.b64decode(auth).decode() != "x:" + token:
        raise SystemExit("Docker-compatible registry credentials are invalid")

    Path(os.environ["FLY_TEST_RECORD"]).write_text(json.dumps({
        "docker_config": str(docker_config),
        "home": str(home),
        "argv": args,
        "spec": args[args.index("--spec") + 1],
    }))
    persistent_state = Path(os.environ["FLY_TEST_PERSISTENT"])
    persistent_state.write_text(json.dumps({"app": "fixture-app", "seen": True}))
    if token in persistent_state.read_text():
        raise SystemExit("runtime token was written into persistent state")

    if os.environ.get("FLY_TEST_FAILURE") == "1":
        print("publisher stdout token=" + token)
        print("publisher stdout encoded=" + base64.b64encode(token.encode()).decode())
        print("publisher stdout registry-auth=" + auth)
        print("publisher stderr token=" + token, file=sys.stderr)
        raise SystemExit(23)
    print("publisher authenticated")
  '';
  publisherProgram = pkgs.writeShellScriptBin "fly-app-publish" ''
    exec ${pkgs.python3}/bin/python3 ${publisherTest} "$@"
  '';
  deployProgram = import ../../scripts/fly-app-deploy.nix {
    inherit pkgs publisherProgram;
  };
  testScript = pkgs.writeText "fly-app-deploy-runtime-test.py" ''
    import base64
    import json
    import os
    from pathlib import Path
    import secrets
    import signal
    import subprocess
    import time
    import sys
    import tempfile
    import unittest
    import urllib.parse

    DEPLOY = sys.argv[1]

    class DeployRuntimeTests(unittest.TestCase):
        def setUp(self):
            self.temp = tempfile.TemporaryDirectory(prefix="fly-runtime-test-")
            self.root = Path(self.temp.name)
            self.token = "fixture-token-" + secrets.token_hex(24)
            self.spec = self.root / "spec.json"
            self.spec.write_text('{"name":"fixture-app"}')
            self.record = self.root / "publisher-record.json"
            self.persistent = self.root / "persistent-state.json"
            self.persistent.write_text('{"app":"fixture-app"}')
            self.persistent_before = self.persistent.read_bytes()

        def tearDown(self):
            self.temp.cleanup()

        def run_deploy(self, *, token="fixture", failure=False):
            env = os.environ.copy()
            env["PATH"] = "/usr/bin:/bin"
            env["FLY_TEST_EXPECTED_TOKEN"] = self.token
            env["FLY_TEST_RECORD"] = str(self.record)
            env["FLY_TEST_PERSISTENT"] = str(self.persistent)
            if token == "fixture":
                env["FLY_API_TOKEN"] = self.token
            elif token is None:
                env.pop("FLY_API_TOKEN", None)
            else:
                env["FLY_API_TOKEN"] = token
            if failure:
                env["FLY_TEST_FAILURE"] = "1"
            else:
                env.pop("FLY_TEST_FAILURE", None)
            return subprocess.run(
                [DEPLOY, "--spec", str(self.spec)],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )

        def assert_private_credentials_cleaned(self):
            record = json.loads(self.record.read_text())
            self.assertFalse(Path(record["docker_config"]).exists())
            self.assertFalse(Path(record["home"]).exists())
            self.assertEqual(record["argv"], ["--spec", str(self.spec)])
            self.assertEqual(record["spec"], str(self.spec))
            self.assertNotIn(self.token, self.record.read_text())
            self.assertNotIn(self.token, self.persistent.read_text())
            self.assertNotIn(self.token, Path(DEPLOY).read_text())

        def test_supplies_private_temporary_docker_auth_and_cleans_it_up(self):
            result = self.run_deploy()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("publisher authenticated", result.stdout)
            self.assert_private_credentials_cleaned()

        def test_missing_and_empty_tokens_fail_before_publisher(self):
            for token in (None, ""):
                with self.subTest(token="missing" if token is None else "empty"):
                    self.record.unlink(missing_ok=True)
                    result = self.run_deploy(token=token)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("FLY_API_TOKEN is required", result.stderr)
                    self.assertFalse(self.record.exists())
                    self.assertNotIn(self.token, result.stdout + result.stderr)

        def test_launcher_error_cleans_private_auth_before_returning(self):
            signal_file = self.root / "publisher-started"
            env = os.environ.copy()
            env["PATH"] = "/usr/bin:/bin"
            env["FLY_API_TOKEN"] = self.token
            env["FLY_TEST_WAIT_FOR_SIGNAL"] = str(signal_file)
            process = subprocess.Popen(
                [DEPLOY, "--spec", str(self.spec)],
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                env=env,
            )
            deadline = time.monotonic() + 5
            while not signal_file.exists() and time.monotonic() < deadline:
                time.sleep(0.01)
            self.assertTrue(signal_file.exists(), "publisher did not start")
            publisher_pid = int(signal_file.read_text())
            os.kill(publisher_pid, signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertNotIn(self.token, stdout + stderr)
            self.assertFalse(any(Path(tempfile.gettempdir()).glob("fly-app-deploy-*/docker/config.json")))

        def test_publisher_failure_output_is_redacted_and_temporary_auth_is_removed(self):
            result = self.run_deploy(failure=True)
            self.assertEqual(result.returncode, 23)
            self.assertIn("publisher stdout token=[REDACTED]", result.stdout)
            self.assertIn("publisher stderr token=[REDACTED]", result.stderr)
            for secret_form in (
                self.token,
                base64.b64encode(self.token.encode()).decode(),
                base64.b64encode(("x:" + self.token).encode()).decode(),
                json.dumps(self.token)[1:-1],
                urllib.parse.quote(self.token, safe=""),
            ):
                self.assertNotIn(secret_form, result.stdout + result.stderr)
            self.assertIn("publisher stdout registry-auth=[REDACTED]", result.stdout)
            self.assert_private_credentials_cleaned()

    unittest.main(argv=[sys.argv[0]], verbosity=2)
  '';
in
pkgs.runCommand "fly-app-deploy-runtime-test"
  {
    nativeBuildInputs = [ pkgs.python3 ];
  }
  ''
    python3 ${testScript} ${deployProgram}/bin/fly-app-deploy
    touch "$out"
  ''
