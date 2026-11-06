import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "overlays" / "total-recall.nix"


class TotalRecallOverlayTests(unittest.TestCase):
    def evaluate_overlay(self):
        expression = '''
          let
            overlay = (import ./overlays/total-recall.nix {
              inputs.total-recall.packages.aarch64-linux = {
                harness-ingestion = "upstream-harness-ingestion";
                harness-event-persistence = "upstream-harness-event-persistence";
                session-post-processing = "upstream-session-post-processing";
                opencode-harness-events = "upstream-opencode-harness-events";
                pi-harness-events = "upstream-pi-harness-events";
                mcp-worker = "upstream-mcp-worker";
              };
            });
            final = {
              stdenv.hostPlatform.system = "aarch64-linux";
              stdenvNoCC.mkDerivation = attrs: attrs;
              fetchurl = attrs: attrs;
              lib.licenses = { mit = "MIT"; asl20 = "Apache-2.0"; };
            };
          in overlay final {}
        '''
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", expression],
            cwd=ROOT,
            text=True,
            capture_output=True,
        )
        if result.returncode:
            raise AssertionError(result.stderr)
        if not result.stdout:
            raise AssertionError("nix eval returned no package attributes")
        return json.loads(result.stdout)

    def test_pinned_arm64_linux_binaries(self):
        packages = self.evaluate_overlay()
        expected = {
            "total-recall-iii": (
                "0.24.0",
                "https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz",
                "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=",
                "iii",
            ),
            "total-recall-database": (
                "0.5.26",
                "https://cdn.iii.cloud/workers/database/0.5.26/database-aarch64-unknown-linux-gnu.tar.gz",
                "sha256-pqdDRmX8qm6RtzyTXVoVfjdvq84HkHaydvkXPQ+EwX8=",
                "database",
            ),
            "total-recall-queue": (
                "0.21.26",
                "https://cdn.iii.cloud/workers/queue/0.21.26/queue-aarch64-unknown-linux-gnu.tar.gz",
                "sha256-OhgcZen7LF2unbxmUDOvZkWyDDPxW41QuRzfl2BN1vk=",
                "queue",
            ),
            "total-recall-cron": (
                "0.21.28",
                "https://cdn.iii.cloud/workers/cron/0.21.28/cron-aarch64-unknown-linux-gnu.tar.gz",
                "sha256-G0253hLdsiOZWR/auRhEHak6X7dsHINCIyaNVY90U3A=",
                "cron",
            ),
        }
        for name, (version, url, digest, program) in expected.items():
            with self.subTest(package=name):
                package = packages[name]
                self.assertEqual(package["version"], version)
                self.assertEqual(package["src"]["url"], url)
                self.assertEqual(package["src"]["hash"], digest)
                self.assertEqual(package["meta"]["mainProgram"], program)
                self.assertIn("installPhase", package)

    def test_upstream_packages_are_reexported_unchanged(self):
        packages = self.evaluate_overlay()
        expected = {
            "total-recall-harness-ingestion": "upstream-harness-ingestion",
            "total-recall-harness-event-persistence": "upstream-harness-event-persistence",
            "total-recall-session-post-processing": "upstream-session-post-processing",
            "total-recall-opencode-plugin": "upstream-opencode-harness-events",
            "total-recall-pi-extension": "upstream-pi-harness-events",
            "total-recall-mcp-worker": "upstream-mcp-worker",
        }
        for name, upstream in expected.items():
            with self.subTest(package=name):
                self.assertEqual(packages[name], upstream)


if __name__ == "__main__":
    unittest.main()
