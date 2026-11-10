#!/usr/bin/env python3
"""Evaluated contract tests for the workstation total-recall client module."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "home-manager" / "common" / "total-recall.nix"
PERSONAL_HOST = ROOT / "configurations" / "personal" / "home-manager" / "default.nix"
COMMON_DEFAULT = ROOT / "home-manager" / "common" / "default.nix"
ENDPOINT = "wss://total-recall.tuxedo-musical.ts.net"
FIXTURE_ENDPOINT = "wss://memory.example.invalid"

EXPRESSION = f'''
let
  flake = builtins.getFlake (toString ./.);
  personal = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
  isolated = (flake.inputs.home-manager.lib.homeManagerConfiguration {{
    pkgs = import flake.inputs.nixpkgs {{
      system = "aarch64-darwin";
      config.allowUnfree = true;
      overlays = [ flake.outputs.overlays.custom-packages ];
    }};
    modules = [
      {json.dumps(str(MODULE))}
      {{
        home.username = "total-recall-test";
        home.homeDirectory = "/Users/total-recall-test";
        home.stateVersion = "26.05";
        home.totalRecall.endpoint = {json.dumps(FIXTURE_ENDPOINT)};
      }}
    ];
  }}).config;
in {{
  optionNames = builtins.attrNames personal.home.totalRecall;
  personal = {{
    enable = personal.home.totalRecall.enable;
    endpoint = personal.home.totalRecall.endpoint;
    databaseConnection = personal.home.totalRecall.databaseConnection;
  }};
  defaults = {{
    enable = isolated.home.totalRecall.enable;
    endpoint = isolated.home.totalRecall.endpoint;
    databaseConnection = isolated.home.totalRecall.databaseConnection;
  }};
}}
'''


class TotalRecallWorkstationOptionsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"Nix workstation evaluation failed:\n{result.stderr}"
            )
        cls.evaluated = json.loads(result.stdout)

    def test_module_exposes_the_shared_client_option_namespace(self):
        self.assertEqual(
            sorted(self.evaluated["optionNames"]),
            [
                "databaseConnection",
                "enable",
                "endpoint",
                "harnessEvents",
                "mcpWorker",
                "opencodePlugin",
                "piExtension",
            ],
        )

    def test_module_defaults_disable_the_wiring_and_share_one_memory_connection(self):
        self.assertEqual(
            self.evaluated["defaults"],
            {
                "enable": False,
                "endpoint": FIXTURE_ENDPOINT,
                "databaseConnection": "memory",
            },
        )

    def test_personal_host_enables_one_endpoint_and_one_connection_name(self):
        self.assertEqual(
            self.evaluated["personal"],
            {
                "enable": True,
                "endpoint": ENDPOINT,
                "databaseConnection": "memory",
            },
        )

    def test_personal_host_declares_the_values_once_and_module_hardcodes_none(self):
        personal_source = PERSONAL_HOST.read_text(encoding="utf-8")
        module_source = MODULE.read_text(encoding="utf-8")

        self.assertEqual(personal_source.count(ENDPOINT), 1)
        self.assertEqual(personal_source.count('databaseConnection = "memory";'), 1)
        self.assertNotIn("tuxedo-musical", module_source)

    def test_common_module_imports_the_workstation_client(self):
        self.assertIn("./total-recall.nix", COMMON_DEFAULT.read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
