#!/usr/bin/env python3
"""Evaluated contract tests for the workstation total-recall client module."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ENDPOINT = "wss://total-recall.tuxedo-musical.ts.net"
HOST = ROOT / "configurations/personal/home-manager/default.nix"
COMMON = ROOT / "home-manager/common/default.nix"
MODULE = ROOT / "home-manager/common/total-recall.nix"

EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
  standalonePkgs = import flake.inputs.nixpkgs {
    system = "aarch64-linux";
    overlays = [ flake.outputs.overlays.custom-packages ];
  };
  defaults = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    pkgs = standalonePkgs;
    modules = [
      ./home-manager/common/total-recall.nix
      ({ ... }: {
        home.username = "tester";
        home.homeDirectory = "/home/tester";
        home.stateVersion = "26.05";
      })
    ];
  }).config.home.totalRecall;
in {
  personal = {
    enable = hm.home.totalRecall.enable;
    endpoint = hm.home.totalRecall.endpoint;
    databaseConnection = hm.home.totalRecall.databaseConnection;
    packages = {
      harnessEvents = hm.home.totalRecall.harnessEvents.pname;
      opencodePlugin = hm.home.totalRecall.opencodePlugin.pname;
      piExtension = hm.home.totalRecall.piExtension.pname;
      mcpWorker = hm.home.totalRecall.mcpWorker.pname;
    };
  };
  defaults = {
    enable = defaults.enable;
    databaseConnection = defaults.databaseConnection;
    packages = {
      harnessEvents = defaults.harnessEvents.pname;
      opencodePlugin = defaults.opencodePlugin.pname;
      piExtension = defaults.piExtension.pname;
      mcpWorker = defaults.mcpWorker.pname;
    };
    matchesOverlay = {
      harnessEvents = "${defaults.harnessEvents}" == "${standalonePkgs.total-recall-harness-events}";
      opencodePlugin = "${defaults.opencodePlugin}" == "${standalonePkgs.total-recall-opencode-plugin}";
      piExtension = "${defaults.piExtension}" == "${standalonePkgs.total-recall-pi-extension}";
      mcpWorker = "${defaults.mcpWorker}" == "${standalonePkgs.total-recall-mcp-worker}";
    };
  };
}
'''

PINNED_PACKAGES = {
    "harnessEvents": "total-recall-harness-events",
    "opencodePlugin": "opencode-harness-events",
    "piExtension": "pi-harness-events",
    "mcpWorker": "mcp-worker",
}


class WorkstationModuleOptionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"Nix workstation evaluation failed:\n{result.stderr}")
        cls.evaluated = json.loads(result.stdout)

    def test_personal_host_enables_one_endpoint_and_one_connection_name(self):
        self.assertTrue(self.evaluated["personal"]["enable"])
        self.assertEqual(self.evaluated["personal"]["endpoint"], ENDPOINT)
        self.assertEqual(self.evaluated["personal"]["databaseConnection"], "memory")

    def test_personal_host_client_packages_resolve_to_the_pinned_derivations(self):
        self.assertEqual(self.evaluated["personal"]["packages"], PINNED_PACKAGES)

    def test_module_defaults_are_disabled_memory_and_pinned_packages(self):
        defaults = self.evaluated["defaults"]
        self.assertFalse(defaults["enable"])
        self.assertEqual(defaults["databaseConnection"], "memory")
        self.assertEqual(defaults["packages"], PINNED_PACKAGES)
        self.assertEqual(defaults["matchesOverlay"], dict.fromkeys(PINNED_PACKAGES, True))

    def test_common_module_is_imported_and_host_declares_the_endpoint_once(self):
        self.assertTrue(MODULE.is_file(), f"missing {MODULE}")
        self.assertIn("./total-recall.nix", COMMON.read_text())
        self.assertEqual(HOST.read_text().count(ENDPOINT), 1)
        self.assertNotIn(ENDPOINT, MODULE.read_text())


if __name__ == "__main__":
    unittest.main()
