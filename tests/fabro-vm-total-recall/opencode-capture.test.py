#!/usr/bin/env python3
"""Evaluated contract tests for guest OpenCode capture wiring."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  guestSystem = flake.nixosConfigurations.fabro-vm;
  guest = guestSystem.config;
  disabled = (guestSystem.extendModules {
    modules = [ ({ lib, ... }: { fabro.totalRecall.enable = lib.mkForce false; }) ];
  }).config;
  project = vm:
    let service = vm.systemd.services.opencode;
    in {
      environment = service.environment or { };
      path = map toString (service.path or [ ]);
      after = service.after or [ ];
      wants = service.wants or [ ];
      requires = service.requires or [ ];
      execStartPre = service.serviceConfig.ExecStartPre or [ ];
    };
in {
  enabled = project guest;
  disabled = project disabled;
  plugin = toString guestSystem.pkgs.total-recall-opencode-plugin;
  cli = toString guestSystem.pkgs.total-recall-harness-events;
}
'''


class OpenCodeCaptureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.evaluated = json.loads(result.stdout)

    def test_enabled_service_gets_capture_endpoint_cli_and_soft_ordering(self):
        service = self.evaluated["enabled"]
        self.assertEqual(
            service["environment"].get("III_URL"), "ws://127.0.0.1:49134"
        )
        self.assertEqual(
            service["environment"].get("HARNESS_EVENTS_BIN"),
            self.evaluated["cli"] + "/bin/harness-events",
        )
        self.assertIn(self.evaluated["cli"], service["path"])
        for unit in ("after", "wants"):
            self.assertIn("total-recall-harness-ingestion.service", service[unit])
        self.assertNotIn(
            "total-recall-harness-ingestion.service", service.get("requires", [])
        )

    def test_enabled_config_tree_copies_the_upstream_plugin(self):
        source = (ROOT / "configurations/fabro-vm/opencode.nix").read_text()
        self.assertIn(
            'cp ${pkgs.total-recall-opencode-plugin}/dist/index.js '
            '$out/opencode/plugins/total-recall-harness-events.js',
            source,
        )
        self.assertIn("lib.optionalString config.fabro.totalRecall.enable", source)

    def test_disabled_service_has_no_capture_runtime_or_ordering(self):
        service = self.evaluated["disabled"]
        self.assertNotIn("III_URL", service["environment"])
        self.assertNotIn("HARNESS_EVENTS_BIN", service["environment"])
        self.assertFalse(
            any("total-recall-harness-events" in path for path in service["path"])
        )
        for unit in ("after", "wants", "requires"):
            self.assertNotIn("total-recall-harness-ingestion.service", service[unit])



if __name__ == "__main__":
    unittest.main()
