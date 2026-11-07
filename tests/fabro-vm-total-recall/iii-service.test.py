#!/usr/bin/env python3
"""Evaluated contract tests for the iii engine service."""

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  guest = flake.nixosConfigurations.fabro-vm.config;
  unit = guest.systemd.services.iii or null;
  gate = if unit == null then "" else builtins.readFile unit.serviceConfig.ExecStartPost;
in {
  unit = if unit == null then null else {
    execStart = unit.serviceConfig.ExecStart or null;
    execStartPost = unit.serviceConfig.ExecStartPost or null;
    workingDirectory = unit.serviceConfig.WorkingDirectory or null;
    user = unit.serviceConfig.User or null;
    group = unit.serviceConfig.Group or null;
    stateDirectory = unit.serviceConfig.StateDirectory or [ ];
    restart = unit.serviceConfig.Restart or null;
    restartSec = unit.serviceConfig.RestartSec or null;
    wantedBy = unit.wantedBy or [ ];
    after = unit.after or [ ];
    requires = unit.requires or [ ];
  };
  gate = gate;
}
'''


class IiiServiceTests(unittest.TestCase):
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

    def test_engine_runs_pinned_iii_with_the_persisted_config(self):
        unit = self.evaluated["unit"]
        self.assertIsNotNone(unit, "missing iii.service")
        self.assertRegex(
            unit["execStart"],
            r'^/nix/store/[^ ]+-iii-0\.24\.0/bin/iii --config /var/lib/total-recall/iii/config\.yaml$',
        )
        self.assertEqual(unit["workingDirectory"], "/var/lib/total-recall/iii")
        self.assertEqual(unit["user"], "total-recall")
        self.assertEqual(unit["group"], "total-recall")

    def test_engine_owns_all_runtime_state_and_restarts_at_boot(self):
        unit = self.evaluated["unit"]
        self.assertEqual(
            unit["stateDirectory"],
            [
                "total-recall",
                "total-recall/iii",
                "total-recall/config",
                "total-recall/queue",
                "total-recall/stream",
            ],
        )
        self.assertEqual(unit["wantedBy"], ["multi-user.target"])
        self.assertEqual(unit["restart"], "always")
        self.assertEqual(unit["restartSec"], 2)

    def test_engine_waits_for_configuration_and_worker_manager_readiness(self):
        unit = self.evaluated["unit"]
        self.assertIn("total-recall-config.service", unit["after"])
        self.assertIn("total-recall-config.service", unit["requires"])
        self.assertIsNotNone(unit["execStartPost"], "missing iii worker-manager health gate")
        gate = self.evaluated["gate"]
        self.assertIn("127.0.0.1", gate)
        self.assertIn("49134", gate)
        self.assertRegex(gate, r"(?m)\bnc\s+-z\b")
        self.assertRegex(gate, r"(?m)\bexit 1\b")


if __name__ == "__main__":
    unittest.main()
