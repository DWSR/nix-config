#!/usr/bin/env python3
"""Stubbed registry and publisher tests for derivation image resolution."""

import base64
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = Path(__file__).resolve().parents[2]
FIXTURE = ROOT / "tests/fly-app/fixture"
PUBLISH_SCRIPT = ROOT / "scripts/fly-app-publish.nix"
TOKEN = "fixture-publish-token-do-not-store-4a86d2"
STORE_HASH = "0123456789abcdfghijklmnpqrsvwxyz"
MANIFEST = json.dumps(
    {
        "schemaVersion": 2,
        "mediaType": "application/vnd.oci.image.manifest.v1+json",
        "config": {"mediaType": "application/vnd.oci.image.config.v1+json", "digest": "sha256:" + "1" * 64, "size": 0},
        "layers": [],
    },
    separators=(",", ":"),
).encode()
MANIFEST_DIGEST = "sha256:" + hashlib.sha256(MANIFEST).hexdigest()


class RegistryHandler(BaseHTTPRequestHandler):
    mode = "present"
    requests = []

    def log_message(self, *_args):
        pass

    def do_GET(self):
        self.__class__.requests.append((self.path, self.headers.get("Authorization")))
        if self.mode == "unauthorized":
            self.send_error(401)
            return
        if self.mode == "unavailable":
            self.send_error(503)
            return
        found = self.mode in ("present", "bad-digest") or (self.mode == "appears-after-push" and len(self.requests) > 1)
        if not found:
            self.send_error(404)
            return
        body = MANIFEST
        digest = MANIFEST_DIGEST
        if self.mode == "bad-digest":
            digest = "sha256:" + "0" * 64
        self.send_response(200)
        self.send_header("Content-Type", "application/vnd.oci.image.manifest.v1+json")
        self.send_header("Docker-Content-Digest", digest)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class FlyPublishTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), RegistryHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        cls.registry_url = f"http://127.0.0.1:{cls.server.server_port}"
        cls.temp = tempfile.TemporaryDirectory(prefix="fly-publish-package-")
        cls.package = cls._build_package()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.server_thread.join(timeout=5)
        cls.temp.cleanup()

    @classmethod
    def _build_package(cls):
        expression = f'''
          let
            flake = builtins.getFlake "path:{FIXTURE}";
            pkgs = import flake.inputs.nixpkgs {{ system = builtins.currentSystem; }};
            publisher = pkgs.writeShellScriptBin "nix2container" ''
              if [ "$#" -lt 1 ] || [ "$1" != push ]; then
                echo "unexpected pinned publisher invocation" >&2
                exit 64
              fi
              ${{pkgs.python3}}/bin/python3 - "$@" <<'PY'
              import json, os, sys
              with open(os.environ["FLY_TEST_PUSH_LOG"], "w", encoding="utf-8") as log:
                  json.dump({{"argv": sys.argv[1:], "token": os.environ.get("FLY_API_TOKEN"), "docker_config": os.environ.get("DOCKER_CONFIG")}}, log)
              PY
              exit "''${{FLY_TEST_PUSH_STATUS:-0}}"
            '';
          in import {PUBLISH_SCRIPT} {{ inherit pkgs publisher; registryUrl = "{cls.registry_url}"; }}
        '''
        result = subprocess.run(
            ["nix", "build", "--impure", "--no-link", "--print-out-paths", "--expr", expression],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        return Path(result.stdout.strip().splitlines()[-1]) / "bin/fly-app-publish"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fly-publish-runtime-")
        self.root = Path(self.temp.name)
        self.archive = self.root / f"{STORE_HASH}-fixture-image.tar"
        self.archive.write_bytes(b"fixture image archive")
        self.spec = self.root / "spec.json"
        self.spec.write_text(
            json.dumps(
                {
                    "name": "fixture-app",
                    "settings": {},
                    "machines": {"web": {"config": {}, "image": {"derivation": str(self.archive)}}},
                }
            ),
            encoding="utf-8",
        )
        self.push_log = self.root / "publisher.json"
        self.docker_config = self.root / "docker"
        self.docker_config.mkdir(mode=0o700)
        (self.docker_config / "config.json").write_text("{}", encoding="utf-8")
        RegistryHandler.requests = []
        RegistryHandler.mode = "present"

    def tearDown(self):
        self.temp.cleanup()

    def _invoke(self, *, mode="present", publisher_status="0"):
        RegistryHandler.mode = mode
        env = os.environ.copy()
        env.update(
            {
                "FLY_API_TOKEN": TOKEN,
                "DOCKER_CONFIG": str(self.docker_config),
                "FLY_TEST_PUSH_LOG": str(self.push_log),
                "FLY_TEST_PUSH_STATUS": publisher_status,
            }
        )
        return subprocess.run(
            [str(self.package), "--spec", str(self.spec)],
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def test_existing_image_is_resolved_unchanged_without_registry_or_publisher(self):
        spec = json.loads(self.spec.read_text(encoding="utf-8"))
        spec["machines"]["web"].pop("image")
        spec["machines"]["web"]["containers"] = {
            "main": {"config": {}, "image": {"existingImage": "ghcr.io/acme/web:v7"}}
        }
        self.spec.write_text(json.dumps(spec), encoding="utf-8")

        result = self._invoke()

        self.assertEqual(result.returncode, 0, result.stderr)
        resolved = json.loads(result.stdout)
        self.assertEqual(resolved["images"]["containers"]["web"]["main"], "ghcr.io/acme/web:v7")
        self.assertEqual(RegistryHandler.requests, [])
        self.assertFalse(self.push_log.exists())

    def test_missing_tag_publishes_then_returns_verified_app_scoped_digest_reference(self):
        result = self._invoke(mode="appears-after-push")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        resolved = json.loads(result.stdout)
        self.assertEqual(
            resolved["images"]["machines"]["web"],
            f"registry.fly.io/fixture-app@{MANIFEST_DIGEST}",
        )
        publication = json.loads(self.push_log.read_text(encoding="utf-8"))
        self.assertEqual(
            publication["argv"],
            ["push", "--ref", f"registry.fly.io/fixture-app:{STORE_HASH}", str(self.archive)],
        )
        self.assertEqual(publication["token"], TOKEN)
        self.assertEqual(publication["docker_config"], str(self.docker_config))
        self.assertEqual(len(RegistryHandler.requests), 2)
        expected_auth = "Basic " + base64.b64encode(("x:" + TOKEN).encode()).decode()
        self.assertTrue(all(auth == expected_auth for _, auth in RegistryHandler.requests))
        self.assertTrue(all(path == f"/v2/fixture-app/manifests/{STORE_HASH}" for path, _ in RegistryHandler.requests))

    def test_existing_tag_is_inspected_and_not_republished(self):
        result = self._invoke(mode="present")

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["images"]["machines"]["web"], f"registry.fly.io/fixture-app@{MANIFEST_DIGEST}")
        self.assertFalse(self.push_log.exists())
        self.assertEqual(len(RegistryHandler.requests), 1)

    def test_auth_and_network_errors_are_not_treated_as_missing_images(self):
        for mode in ("unauthorized", "unavailable"):
            with self.subTest(mode=mode):
                self.push_log.unlink(missing_ok=True)
                RegistryHandler.requests = []
                result = self._invoke(mode=mode)
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn(TOKEN, result.stdout + result.stderr)
                self.assertIn("registry inspection failed", result.stderr)
                self.assertFalse(self.push_log.exists())
                self.assertEqual(len(RegistryHandler.requests), 1)

    def test_published_but_unavailable_image_is_failure(self):
        result = self._invoke(mode="absent", publisher_status="0")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not available after publication", result.stderr)
        self.assertTrue(self.push_log.exists())
        self.assertEqual(len(RegistryHandler.requests), 2)

    def test_manifest_digest_mismatch_is_failure_without_trusting_tag(self):
        result = self._invoke(mode="bad-digest")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("manifest digest mismatch", result.stderr)
        self.assertFalse(self.push_log.exists())

    def test_publisher_failure_is_propagated_without_registry_secret_diagnostics(self):
        result = self._invoke(mode="absent", publisher_status="29")

        self.assertEqual(result.returncode, 1)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertIn("pinned publisher failed", result.stderr)
        self.assertEqual(len(RegistryHandler.requests), 1)


if __name__ == "__main__":
    unittest.main()
