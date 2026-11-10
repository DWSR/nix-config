#!/usr/bin/env python3
"""Image publication, registry inspection, and publication-state tests for the Fly app publisher."""

import base64
import hashlib
import http.server
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile
import threading
import unittest
import urllib.parse

ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fly-app/fixture"
PUBLISH_SCRIPT = Path(os.environ.get("FLY_APP_PUBLISH_NIX", ROOT / "scripts/fly-app-publish.nix"))
TOKEN = "fixture-fly-token-do-not-store-4c81a2"
AUTH = "Basic " + base64.b64encode(("x:" + TOKEN).encode()).decode()
STORE_PATH = re.compile(r"^/nix/store/([0-9abcdfghijklmnpqrsvwxyz]{32})-[^/]+$")

STUB_PUBLISHER = """
import hashlib
import json
import os
from pathlib import Path
import sys


def describe(path):
    return os.stat(path).st_mode & 0o777 if path and os.path.exists(path) else None


args = sys.argv[1:]
if len(args) != 4 or args[0] != "push" or args[1] != "--ref":
    print("stub nix2container: unexpected arguments", file=sys.stderr)
    raise SystemExit(64)
reference, archive = args[2], args[3]
if not os.path.isfile(archive):
    print("stub nix2container: image archive is not realized", file=sys.stderr)
    raise SystemExit(65)
docker_config = os.environ.get("DOCKER_CONFIG", "")
config_file = Path(docker_config) / "config.json" if docker_config else None
auth = None
if config_file is not None and config_file.is_file():
    config = json.loads(config_file.read_text(encoding="utf-8"))
    auth = config["auths"][next(iter(config["auths"]))]["auth"]
entry = {
    "reference": reference,
    "archive": archive,
    "docker_config_set": bool(docker_config),
    "docker_config_mode": describe(config_file),
    "docker_config_directory_mode": describe(docker_config),
    "docker_auth_sha256": hashlib.sha256(auth.encode("utf-8")).hexdigest() if auth else None,
    "token_in_environment": "FLY_API_TOKEN" in os.environ,
}
with open(os.environ["FLY_TEST_PUSH_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(entry) + "\\n")
if os.environ.get("FLY_TEST_PUSH_FAIL"):
    print("stub nix2container: simulated push failure", file=sys.stderr)
    raise SystemExit(9)
body = json.dumps(
    {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "reference": reference,
    }
).encode("utf-8")
_, _, remainder = reference.partition("/")
app, _, tag = remainder.partition(":")
(Path(os.environ["FLY_TEST_REGISTRY_DIR"]) / (app + "@@" + tag + ".json")).write_bytes(body)
"""


class RegistryState:
    def __init__(self, root):
        self.manifests = Path(root) / "manifests"
        self.manifests.mkdir(parents=True, exist_ok=True)
        self.mode_file = Path(root) / "mode"
        self.request_file = Path(root) / "requests.jsonl"
        self.request_file.write_text("", encoding="utf-8")
        self.set_mode("normal")

    def set_mode(self, mode):
        self.mode_file.write_text(mode, encoding="utf-8")

    def mode(self):
        return self.mode_file.read_text(encoding="utf-8").strip()

    def manifest_file(self, app, reference):
        return self.manifests / f"{app}@@{reference}.json"

    def read_manifest(self, app, reference):
        path = self.manifest_file(app, reference)
        return path.read_bytes() if path.exists() else None

    def requests(self):
        lines = self.request_file.read_text(encoding="utf-8").splitlines()
        return [json.loads(line) for line in lines if line.strip()]

    def record_request(self, app, reference, authenticated):
        record = {"app": app, "reference": reference, "authenticated": authenticated}
        with self.request_file.open("a", encoding="utf-8") as log:
            log.write(json.dumps(record) + "\n")


class RegistryHandler(http.server.BaseHTTPRequestHandler):
    state = None

    def log_message(self, *_args):
        pass

    def _respond(self, status, body, content_type="application/json", headers=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in (headers or {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        parts = path.split("/")
        if len(parts) != 5 or parts[1] != "v2" or parts[3] != "manifests":
            self._respond(404, b'{"errors":[{"code":"NOT_FOUND"}]}')
            return
        app = urllib.parse.unquote(parts[2])
        reference = urllib.parse.unquote(parts[4])
        authenticated = self.headers.get("Authorization", "") == AUTH
        self.state.record_request(app, reference, authenticated)
        mode = self.state.mode()
        if not authenticated or mode == "auth":
            self._respond(
                401,
                b'{"errors":[{"code":"UNAUTHORIZED"}]}',
                headers={"WWW-Authenticate": 'Basic realm="registry"'},
            )
            return
        if mode == "server-error":
            self._respond(500, b'{"errors":[{"code":"UNKNOWN"}]}')
            return
        body = self.state.read_manifest(app, reference)
        if body is None:
            self._respond(404, b'{"errors":[{"code":"MANIFEST_UNKNOWN"}]}')
            return
        digest = "sha256:" + hashlib.sha256(body).hexdigest()
        self._respond(
            200,
            body,
            content_type="application/vnd.oci.image.manifest.v1+json",
            headers={"Docker-Content-Digest": digest},
        )


class FlyPublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.state_dir = tempfile.TemporaryDirectory(prefix="fly-publish-registry-")
        cls.state = RegistryState(cls.state_dir.name)
        RegistryHandler.state = cls.state
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), RegistryHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.host = f"127.0.0.1:{cls.server.server_address[1]}"

        cls.temp = tempfile.TemporaryDirectory(prefix="fly-publish-package-")
        cls.package = cls._build_package(cls.host)
        cls.unreachable = cls._build_package("127.0.0.1:1")

        cls.archive = cls._build_archive("fly-test-archive")
        cls.other_archive = cls._build_archive("fly-test-archive-other")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=5)
        cls.temp.cleanup()
        cls.state_dir.cleanup()

    @staticmethod
    def _run_nix(expression):
        result = subprocess.run(
            ["nix", "build", "--impure", "--no-link", "--print-out-paths", "--expr", expression],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"nix build failed:\n{result.stderr}")
        return result.stdout.strip().splitlines()[-1]

    @classmethod
    def _build_package(cls, host):
        expression = f"""
          let
            flake = builtins.getFlake "path:{FIXTURE}";
            pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
            stubPy = pkgs.writeText "stub-nix2container.py" {json.dumps(STUB_PUBLISHER)};
            stub = pkgs.writeShellScriptBin "nix2container" ''
              exec ${{pkgs.python3}}/bin/python3 "${{stubPy}}" "$@"
            '';
            snapshotter = pkgs.runCommand "stub-nix-snapshotter" {{ }} ''
              mkdir -p "$out/bin"
              ln -s "${{stub}}/bin/nix2container" "$out/bin/nix2container"
            '';
          in
          import {PUBLISH_SCRIPT} {{
            inherit pkgs;
            nixSnapshotter = snapshotter;
            registryScheme = "http";
            registryHost = {json.dumps(host)};
          }}
        """
        return Path(cls._run_nix(expression)) / "bin/fly-app-publish"

    @classmethod
    def _build_archive(cls, name):
        expression = f"""
          derivation {{
            name = "{name}";
            system = builtins.currentSystem;
            builder = "/bin/sh";
            args = [ "-c" "printf archive > $out" ];
          }}
        """
        return Path(cls._run_nix(expression))

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fly-publish-runtime-")
        self.root = Path(self.temp.name)
        self.push_log = self.root / "push.log"
        self.state.set_mode("normal")
        self.state.request_file.write_text("", encoding="utf-8")
        shutil.rmtree(self.state.manifests)
        self.state.manifests.mkdir(parents=True)

    def tearDown(self):
        self.temp.cleanup()

    def _spec(self, spec):
        path = self.root / "spec.json"
        path.write_text(json.dumps(spec) + "\n", encoding="utf-8")
        return path

    def _invoke(self, package=None, *, spec, token=TOKEN, extra_env=None):
        env = os.environ.copy()
        env.pop("DOCKER_CONFIG", None)
        env.pop("FLY_API_TOKEN", None)
        env.update(
            {
                "TMPDIR": str(self.root),
                "FLY_TEST_REGISTRY_DIR": str(self.state.manifests),
                "FLY_TEST_PUSH_LOG": str(self.push_log),
                "FLY_APP_STATE_DIR": str(self.root / "state"),
            }
        )
        if token is not None:
            env["FLY_API_TOKEN"] = token
        env.update(extra_env or {})
        return subprocess.run(
            [str(package or self.package), "--spec", str(self._spec(spec))],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def _pushes(self):
        if not self.push_log.exists():
            return []
        return [
            json.loads(line)
            for line in self.push_log.read_text(encoding="utf-8").splitlines()
            if line.strip()
        ]

    def _derivation_spec(self, archive=None):
        return {
            "name": "fly-alpha",
            "machines": {
                "web": {"image": {"derivation": str(archive or self.archive)}}
            },
        }

    def _identity(self, archive=None):
        return STORE_PATH.match(str(archive or self.archive)).group(1)

    def _tag(self, archive=None):
        return "nix-" + self._identity(archive)

    def _state_file(self, app="fly-alpha"):
        return self.root / "state" / (app + ".json")

    def _state(self, app="fly-alpha"):
        return json.loads(self._state_file(app).read_text(encoding="utf-8"))

    def _result(self, result):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stderr.count(TOKEN), 0)
        self.assertEqual(result.stdout.count(TOKEN), 0)
        return json.loads(result.stdout)

    def test_existing_images_are_resolved_without_inspection_or_publication(self):
        result = self._invoke(
            spec={
                "name": "fly-alpha",
                "machines": {
                    "web": {"image": {"existingImage": "registry.fly.io/fly-alpha:customer-7"}}
                },
            }
        )
        payload = self._result(result)
        self.assertEqual(payload["app"], "fly-alpha")
        self.assertEqual(payload["images"], [
            {
                "kind": "existingImage",
                "source": "registry.fly.io/fly-alpha:customer-7",
                "reference": "registry.fly.io/fly-alpha:customer-7",
                "digest": None,
                "published": False,
            }
        ])
        self.assertEqual(
            payload["machines"]["web"]["image"]["reference"],
            "registry.fly.io/fly-alpha:customer-7",
        )
        self.assertEqual(self._pushes(), [])
        self.assertEqual(self.state.requests(), [])
        self.assertFalse((self.root / "state").exists())
        self.assertEqual(list(self.root.glob("fly-app-publish.*")), [])

    def test_first_publication_confirms_app_scoped_reference_and_digest(self):
        result = self._invoke(spec=self._derivation_spec())
        payload = self._result(result)
        digest = STORE_PATH.match(str(self.archive)).group(1)
        reference = f"{self.host}/fly-alpha:nix-{digest}"
        self.assertEqual(payload["images"][0]["kind"], "derivation")
        self.assertEqual(payload["images"][0]["reference"], reference)
        self.assertTrue(payload["images"][0]["published"])
        manifest = self.state.read_manifest("fly-alpha", f"nix-{digest}")
        self.assertIsNotNone(manifest)
        expected_digest = "sha256:" + hashlib.sha256(manifest).hexdigest()
        self.assertEqual(payload["images"][0]["digest"], expected_digest)
        self.assertEqual(payload["machines"]["web"]["image"]["reference"], reference)
        self.assertEqual(payload["machines"]["web"]["image"]["digest"], expected_digest)

        pushes = self._pushes()
        self.assertEqual(len(pushes), 1)
        self.assertEqual(pushes[0]["reference"], reference)
        self.assertEqual(pushes[0]["archive"], str(self.archive))
        self.assertTrue(pushes[0]["docker_config_set"])
        self.assertEqual(pushes[0]["docker_config_mode"], 0o600)
        self.assertEqual(pushes[0]["docker_config_directory_mode"], 0o700)
        self.assertEqual(
            pushes[0]["docker_auth_sha256"],
            hashlib.sha256(AUTH.removeprefix("Basic ").encode("utf-8")).hexdigest(),
        )
        self.assertFalse(pushes[0]["token_in_environment"])

        requests = self.state.requests()
        self.assertTrue(requests)
        self.assertTrue(all(request["authenticated"] for request in requests))
        self.assertEqual(list(self.root.glob("fly-app-publish.*")), [])

    def test_unchanged_confirmed_image_is_not_republished(self):
        spec = self._derivation_spec()
        first = self._result(self._invoke(spec=spec))
        second = self._result(self._invoke(spec=spec))
        self.assertTrue(first["images"][0]["published"])
        self.assertFalse(second["images"][0]["published"])
        self.assertEqual(first["images"][0]["digest"], second["images"][0]["digest"])
        self.assertEqual(len(self._pushes()), 1)
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            first["images"][0]["digest"],
        )

        changed = self._result(
            self._invoke(spec=self._derivation_spec(self.other_archive))
        )
        self.assertTrue(changed["images"][0]["published"])
        self.assertNotEqual(
            changed["images"][0]["reference"], first["images"][0]["reference"]
        )
        self.assertEqual(len(self._pushes()), 2)
        state = self._state()
        self.assertEqual(
            state["images"][self._identity(self.other_archive)]["reference"],
            changed["images"][0]["reference"],
        )
        self.assertEqual(
            state["images"][self._identity()]["digest"],
            first["images"][0]["digest"],
        )

    def test_publication_persists_identity_reference_and_digest_without_secrets(self):
        payload = self._result(self._invoke(spec=self._derivation_spec()))
        state_file = self._state_file()
        self.assertTrue(state_file.is_file())
        self.assertEqual(stat.S_IMODE(state_file.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(state_file.parent.stat().st_mode), 0o700)
        raw = state_file.read_bytes()
        self.assertNotIn(TOKEN.encode("utf-8"), raw)
        state = json.loads(raw)
        self.assertEqual(state["app"], "fly-alpha")
        record = state["images"][self._identity()]
        self.assertEqual(record["identity"], self._identity())
        self.assertEqual(record["reference"], payload["images"][0]["reference"])
        self.assertEqual(record["digest"], payload["images"][0]["digest"])
        self.assertRegex(record["digest"], r"^sha256:[0-9a-f]{64}$")

    def test_default_state_location_uses_xdg_state_home(self):
        xdg_state = self.root / "xdg-state"
        result = self._invoke(
            spec=self._derivation_spec(),
            extra_env={
                "FLY_APP_STATE_DIR": "",
                "XDG_STATE_HOME": str(xdg_state),
            },
        )
        self._result(result)
        self.assertTrue((xdg_state / "fly-app" / "fly-alpha.json").is_file())

    def test_intact_state_missing_remote_image_fails_without_republishing(self):
        spec = self._derivation_spec()
        first = self._result(self._invoke(spec=spec))
        self.state.manifest_file("fly-alpha", self._tag()).unlink()

        result = self._invoke(spec=spec)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("missing from the Fly registry", result.stderr)
        self.assertIn("refusing to republish", result.stderr)
        self.assertEqual(result.stderr.count(TOKEN), 0)
        self.assertEqual(len(self._pushes()), 1)
        self.assertIsNone(self.state.read_manifest("fly-alpha", self._tag()))
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            first["images"][0]["digest"],
        )

    def test_intact_state_wrong_remote_digest_fails_without_republishing(self):
        spec = self._derivation_spec()
        first = self._result(self._invoke(spec=spec))
        self.state.manifest_file("fly-alpha", self._tag()).write_bytes(
            b'{"schemaVersion":2,"tampered":true}'
        )

        result = self._invoke(spec=spec)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("does not match the recorded publication", result.stderr)
        self.assertIn("refusing to republish", result.stderr)
        self.assertEqual(len(self._pushes()), 1)
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            first["images"][0]["digest"],
        )

    def test_state_loss_with_missing_remote_image_publishes_automatically(self):
        spec = self._derivation_spec()
        first = self._result(self._invoke(spec=spec))
        self.state.manifest_file("fly-alpha", self._tag()).unlink()
        shutil.rmtree(self._state_file().parent)

        second = self._result(self._invoke(spec=spec))
        self.assertTrue(second["images"][0]["published"])
        self.assertEqual(second["images"][0]["digest"], first["images"][0]["digest"])
        self.assertEqual(len(self._pushes()), 2)
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            second["images"][0]["digest"],
        )

    def test_state_loss_adopts_an_existing_confirmed_image_without_republishing(self):
        spec = self._derivation_spec()
        first = self._result(self._invoke(spec=spec))
        shutil.rmtree(self._state_file().parent)

        second = self._result(self._invoke(spec=spec))
        self.assertFalse(second["images"][0]["published"])
        self.assertEqual(second["images"][0]["digest"], first["images"][0]["digest"])
        self.assertEqual(len(self._pushes()), 1)
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            first["images"][0]["digest"],
        )

    def test_malformed_state_is_treated_as_first_deployment(self):
        spec = self._derivation_spec()
        self._result(self._invoke(spec=spec))
        self._state_file().write_text("{not json", encoding="utf-8")
        self.state.manifest_file("fly-alpha", self._tag()).unlink()

        second = self._result(self._invoke(spec=spec))
        self.assertTrue(second["images"][0]["published"])
        self.assertEqual(len(self._pushes()), 2)
        self.assertEqual(
            self._state()["images"][self._identity()]["digest"],
            second["images"][0]["digest"],
        )

    def test_state_of_a_different_registry_reference_is_treated_as_first_deployment(self):
        spec = self._derivation_spec()
        self._result(self._invoke(spec=spec))
        state = self._state()
        state["images"][self._identity()]["reference"] = "registry.fly.io/fly-alpha:other"
        self._state_file().write_text(json.dumps(state), encoding="utf-8")
        self.state.manifest_file("fly-alpha", self._tag()).unlink()

        second = self._result(self._invoke(spec=spec))
        self.assertTrue(second["images"][0]["published"])
        self.assertEqual(len(self._pushes()), 2)

    def test_shared_derivation_is_published_once_for_all_machines(self):
        spec = {
            "name": "fly-multi",
            "machines": {
                "web": {
                    "containers": {
                        "app": {"image": {"derivation": str(self.archive)}},
                        "sidecar": {"image": {"derivation": str(self.archive)}},
                    },
                    "deployContainer": "app",
                },
                "worker": {"image": {"derivation": str(self.archive)}},
            },
        }
        payload = self._result(self._invoke(spec=spec))
        self.assertEqual(len(payload["images"]), 1)
        reference = payload["images"][0]["reference"]
        self.assertEqual(payload["machines"]["web"]["containers"]["app"]["reference"], reference)
        self.assertEqual(
            payload["machines"]["web"]["containers"]["sidecar"]["reference"], reference
        )
        self.assertEqual(payload["machines"]["worker"]["image"]["reference"], reference)
        self.assertEqual(payload["machines"]["web"]["deployImage"]["reference"], reference)
        self.assertEqual(len(self._pushes()), 1)

    def test_different_derivations_publish_distinct_content_addressed_references(self):
        spec = {
            "name": "fly-alpha",
            "machines": {
                "web": {"image": {"derivation": str(self.archive)}},
                "worker": {"image": {"derivation": str(self.other_archive)}},
            },
        }
        payload = self._result(self._invoke(spec=spec))
        references = sorted(image["reference"] for image in payload["images"])
        self.assertEqual(len(set(references)), 2)
        self.assertTrue(all(reference.startswith(f"{self.host}/fly-alpha:nix-") for reference in references))
        self.assertEqual(len(self._pushes()), 2)

    def test_auth_error_is_not_treated_as_a_missing_image(self):
        self.state.set_mode("auth")
        result = self._invoke(spec=self._derivation_spec())
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("authentication failed", result.stderr)
        self.assertEqual(self._pushes(), [])

    def test_server_error_is_not_treated_as_a_missing_image(self):
        self.state.set_mode("server-error")
        result = self._invoke(spec=self._derivation_spec())
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("HTTP 500", result.stderr)
        self.assertEqual(self._pushes(), [])

    def test_unreachable_registry_is_not_treated_as_a_missing_image(self):
        result = self._invoke(
            package=self.unreachable, spec=self._derivation_spec()
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("could not reach the Fly registry", result.stderr)
        self.assertEqual(self._pushes(), [])

    def test_publication_failure_is_reported_without_confirmation(self):
        result = self._invoke(
            spec=self._derivation_spec(), extra_env={"FLY_TEST_PUSH_FAIL": "1"}
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("publication failed", result.stderr)
        self.assertEqual(len(self._pushes()), 1)
        self.assertIsNone(self.state.read_manifest("fly-alpha", "nix-" + STORE_PATH.match(str(self.archive)).group(1)))
        self.assertFalse(self._state_file().exists())

    def test_missing_or_empty_token_fails_before_publication(self):
        for token in (None, ""):
            with self.subTest(token=token):
                result = self._invoke(spec=self._derivation_spec(), token=token)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("FLY_API_TOKEN is required", result.stderr)
                self.assertEqual(self._pushes(), [])
                self.assertEqual(self.state.requests(), [])

    def test_token_with_line_breaks_fails_before_publication(self):
        result = self._invoke(
            spec={"name": "fly-alpha"},
            token=TOKEN + "\n",
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FLY_API_TOKEN must not contain line breaks", result.stderr)
        self.assertEqual(self._pushes(), [])

    def test_usage_errors_are_rejected(self):
        env = os.environ.copy()
        env["FLY_API_TOKEN"] = TOKEN
        result = subprocess.run(
            [str(self.package), "--spec", str(self.root / "spec.json"), "extra"],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage: fly-app-publish", result.stderr)

    def test_supplied_docker_config_is_used_without_a_new_temporary_home(self):
        supplied = self.root / "docker"
        supplied.mkdir(mode=0o700)
        config = supplied / "config.json"
        config.write_text(
            json.dumps(
                {
                    "auths": {
                        "registry.fly.io": {"auth": AUTH.removeprefix("Basic ")}
                    }
                }
            ),
            encoding="utf-8",
        )
        config.chmod(0o600)
        result = self._invoke(
            spec=self._derivation_spec(),
            extra_env={"DOCKER_CONFIG": str(supplied)},
        )
        self._result(result)
        pushes = self._pushes()
        self.assertEqual(len(pushes), 1)
        self.assertTrue(pushes[0]["docker_config_set"])
        self.assertEqual(pushes[0]["docker_config_mode"], 0o600)
        self.assertEqual(list(self.root.glob("fly-app-publish.*")), [])

    def test_app_without_machines_publishes_nothing(self):
        payload = self._result(
            self._invoke(
                spec={
                    "name": "fly-alpha",
                    "settings": {"primary_region": "ord"},
                    "machines": {},
                }
            )
        )
        self.assertEqual(payload["images"], [])
        self.assertEqual(payload["machines"], {})
        self.assertEqual(self._pushes(), [])

    def test_token_is_absent_from_the_built_program(self):
        wrapper = self.package.read_text(encoding="utf-8")
        embedded = [
            Path(path) for path in re.findall(r"/nix/store/[^\s\"']+\.py", wrapper)
        ]
        self.assertTrue(embedded, wrapper)
        for path in [self.package, *embedded]:
            self.assertNotIn(TOKEN.encode(), path.read_bytes(), str(path))
        self.assertNotIn(TOKEN, self.push_log.read_text() if self.push_log.exists() else "")


if __name__ == "__main__":
    unittest.main()
