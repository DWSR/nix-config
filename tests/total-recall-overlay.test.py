#!/usr/bin/env python3
"""Contract tests for the pinned total-recall runtime package overlay."""

import base64
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OVERLAY = ROOT / "overlays/total-recall.nix"
OVERLAYS = ROOT / "overlays/default.nix"


class TotalRecallOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.overlay = OVERLAY.read_text()
        cls.overlays = OVERLAYS.read_text()

    def test_runtime_archives_are_fixed_to_the_researched_linux_versions(self):
        packages = {
            "iii": (
                "0.24.0",
                "https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz",
                "sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=",
            ),
            "database": (
                "0.5.26",
                "https://cdn.iii.cloud/workers/database/0.5.26/database-aarch64-unknown-linux-gnu.tar.gz",
                "a6a7434665fcaa6e91b73c935d5a157e376fabce079076b276f9173d0f84c17f",
            ),
            "queue": (
                "0.21.26",
                "https://cdn.iii.cloud/workers/queue/0.21.26/queue-aarch64-unknown-linux-gnu.tar.gz",
                "3a181c65e9fb2c5dae9dbc665033af6645b20c33f15b8d50b91cdf97604dd6f9",
            ),
            "cron": (
                "0.21.28",
                "https://cdn.iii.cloud/workers/cron/0.21.28/cron-aarch64-unknown-linux-gnu.tar.gz",
                "1b4db9de12ddb22399591fdab918441da93a5fb76c1c834223268d558f745370",
            ),
        }
        for name, (version, url, hash_value) in packages.items():
            with self.subTest(package=name):
                self.assertRegex(self.overlay, rf'pname = "{name}";')
                self.assertRegex(self.overlay, rf'version = "{re.escape(version)}";')
                self.assertIn(f'url = "{url}";', self.overlay)
                expected_hash = hash_value
                if name != "iii":
                    expected_hash = "sha256-" + base64.b64encode(bytes.fromhex(hash_value)).decode()
                self.assertIn(f'hash = "{expected_hash}";', self.overlay)

    def test_runtime_and_upstream_packages_are_exported_under_contract_names(self):
        for package in (
            "iii",
            "database",
            "queue",
            "cron",
            "harness-ingestion",
            "harness-event-persistence",
            "session-post-processing",
            "opencode-plugin",
            "pi-extension",
            "mcp-worker",
        ):
            with self.subTest(package=package):
                self.assertIn(f"total-recall-{package}", self.overlay)
        self.assertIn("inputs.total-recall.packages.${system}", self.overlay)
        self.assertIn('binary = "iii";', self.overlay)
        self.assertIn('mainProgram = binary;', self.overlay)
        self.assertIn('platforms = [ "aarch64-linux" ];', self.overlay)
        self.assertIn('dontUnpack = true;', self.overlay)
        self.assertIn('packagePkgs.autoPatchelfHook', self.overlay)
        self.assertIn('packagePkgs.stdenv.cc.cc.lib', self.overlay)
        self.assertIn('config.allowUnfreePredicate = package: inputs.nixpkgs.lib.getName package == "iii";', self.overlay)
        self.assertIn('packagePkgs = iiiPkgs;', self.overlay)
        self.assertIn('doInstallCheck = true;', self.overlay)
        self.assertIn('test -x "$out/bin/${binary}"', self.overlay)
        self.assertIn('"$out/bin/${binary}" --help >/dev/null', self.overlay)

    def test_custom_package_overlay_registers_total_recall(self):
        self.assertRegex(self.overlays, r'totalRecall\s*=\s*import\s+\./total-recall\.nix')
        self.assertIn("(totalRecall final prev)", self.overlays)

    def test_overlay_uses_no_dynamic_or_unpinned_source_resolution(self):
        self.assertNotRegex(
            self.overlay,
            r"builtins\.fetchTarball|fetchGit|fetchFromGitHub|registry\.iii\.dev|curl|wget",
        )


if __name__ == "__main__":
    unittest.main()
