#!/usr/bin/env python3
"""Evaluated contract tests for total-recall Tailscale Serve exposure."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  guestSystem = flake.nixosConfigurations.fabro-vm;
  enabled = guestSystem.config;
  disabled = (guestSystem.extendModules {
    modules = [ ({ lib, ... }: { fabro.totalRecall.enable = lib.mkForce false; }) ];
  }).config;
  project = config: let
    service = config.systemd.services.tailscale-serve;
  in {
    enabled = config.fabro.totalRecall.enable;
    execStart = service.serviceConfig.ExecStart;
    after = service.after;
    wants = service.wants or [ ];
    requires = service.requires;
    wantedBy = service.wantedBy;
    description = service.description;
    restart = service.serviceConfig.Restart;
    restartSec = service.serviceConfig.RestartSec;
    type = service.serviceConfig.Type;
  };
in {
  command = flake.inputs.nixpkgs.lib.getExe enabled.services.tailscale.package;
  enabled = project enabled;
  disabled = project disabled;
}
'''


class TailscaleServeTests(unittest.TestCase):
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

    def test_enabled_guest_appends_one_conditional_memory_advertisement(self):
        enabled = self.evaluated["enabled"]
        command = self.evaluated["command"]
        self.assertTrue(enabled["enabled"])
        self.assertIn("Tailscale Services", enabled["description"])
        self.assertEqual(
            enabled["execStart"],
            [
                f"{command} serve --service=svc:fabro --https=443 http://127.0.0.1:32276",
                f"{command} serve --service=svc:litellm --https=443 http://127.0.0.1:4000",
                f"{command} serve --service=svc:opencode --https=443 http://127.0.0.1:4096",
                f"{command} serve --service=svc:total-recall --https=443 http://127.0.0.1:49134",
            ],
        )

    def test_memory_workers_are_soft_prerequisites_and_serve_stays_enabled_at_boot(self):
        enabled = self.evaluated["enabled"]
        memory_units = [
            "iii.service",
            "total-recall-harness-ingestion.service",
            "total-recall-harness-event-persistence.service",
            "total-recall-session-post-processing.service",
        ]
        self.assertEqual(enabled["type"], "oneshot")
        self.assertEqual(enabled["restart"], "on-failure")
        self.assertEqual(enabled["restartSec"], 5)
        self.assertEqual(enabled["wantedBy"], ["multi-user.target"])
        for unit in memory_units:
            with self.subTest(unit=unit):
                self.assertIn(unit, enabled["after"])
                self.assertIn(unit, enabled["wants"])
                self.assertNotIn(unit, enabled["requires"])
        self.assertIn("tailscaled-autoconnect.service", enabled["after"])
        self.assertIn("tailscaled-autoconnect.service", enabled["requires"])

    def test_advertisement_is_absent_when_total_recall_is_disabled(self):
        disabled = self.evaluated["disabled"]
        self.assertFalse(disabled["enabled"])
        self.assertEqual(len(disabled["execStart"]), 3)
        self.assertTrue(
            all("svc:total-recall" not in entry for entry in disabled["execStart"])
        )
        memory_units = [
            "iii.service",
            "total-recall-harness-ingestion.service",
            "total-recall-harness-event-persistence.service",
            "total-recall-session-post-processing.service",
        ]
        self.assertTrue(all(unit not in disabled["after"] for unit in memory_units))
        self.assertTrue(all(unit not in disabled["wants"] for unit in memory_units))
        self.assertEqual(disabled["wantedBy"], ["multi-user.target"])


if __name__ == "__main__":
    unittest.main()
