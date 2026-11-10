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
  guestSystem = flake.nixosConfigurations.fabro-vm;
  guest = guestSystem.config;
  service = guest.systemd.services.iii or null;
  customGuest = (flake.inputs.nixpkgs.lib.nixosSystem {
    system = "aarch64-linux";
    pkgs = guestSystem.pkgs;
    specialArgs.totalRecall = flake.inputs.total-recall;
    modules = [
      ./configurations/fabro-vm/total-recall.nix
      ({ ... }: { fabro.totalRecall = { enable = true; iiiHost = "127.0.0.2"; iiiPort = 49999; }; })
    ];
  }).config;
  gate = if service == null then "" else builtins.readFile service.serviceConfig.ExecStartPost;
  customGate = builtins.readFile customGuest.systemd.services.iii.serviceConfig.ExecStartPost;
in {
  service = if service == null then null else {
    description = service.description or null;
    wantedBy = service.wantedBy;
    after = service.after;
    requires = service.requires;
    execStart = service.serviceConfig.ExecStart or null;
    execStartPost = service.serviceConfig.ExecStartPost or null;
    workingDirectory = service.serviceConfig.WorkingDirectory or null;
    user = service.serviceConfig.User or null;
    group = service.serviceConfig.Group or null;
    restart = service.serviceConfig.Restart or null;
    restartSec = service.serviceConfig.RestartSec or null;
    stateDirectory = service.serviceConfig.StateDirectory or null;
    dynamicUserDeclared = builtins.hasAttr "DynamicUser" service.serviceConfig;
  };
  gate = gate;
  customGate = customGate;
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
        cls.service = cls.evaluated["service"]

    def test_engine_runs_pinned_binary_with_persistent_config_and_identity(self):
        service = self.service
        self.assertIsNotNone(service, "missing iii.service")
        self.assertRegex(
            service["execStart"],
            r'^"/nix/store/[^ ]+-iii-0\.24\.0/bin/iii" "--config" '
            r'"/var/lib/total-recall/iii/config\.yaml"$',
        )
        self.assertEqual(service["workingDirectory"], "/var/lib/total-recall/iii")
        self.assertEqual(service["user"], "total-recall")
        self.assertEqual(service["group"], "total-recall")
        self.assertFalse(service["dynamicUserDeclared"])

    def test_engine_is_enabled_supervised_and_gated_on_configuration(self):
        service = self.service
        self.assertEqual(service["wantedBy"], ["multi-user.target"])
        self.assertIn("total-recall-config.service", service["after"])
        self.assertIn("total-recall-config.service", service["requires"])
        self.assertEqual(service["restart"], "always")
        self.assertEqual(service["restartSec"], 2)
        self.assertEqual(
            service["stateDirectory"],
            [
                "total-recall",
                "total-recall/iii",
                "total-recall/config",
                "total-recall/queue",
                "total-recall/stream",
            ],
        )
        self.assertIsNotNone(service["execStartPost"], "missing iii worker-manager health gate")

    def test_health_gate_waits_for_the_configured_worker_manager_tcp_port(self):
        gate = self.evaluated["gate"]
        self.assertRegex(gate, r"/dev/tcp/127\.0\.0\.1/49134")
        self.assertRegex(gate, r"attempts=\d+")
        self.assertIn("exit 1", gate)
        self.assertNotRegex(gate, r"(?i)https?://|curl|0\.0\.0\.0")
        self.assertRegex(self.evaluated["customGate"], r"/dev/tcp/127\.0\.0\.2/49999")


if __name__ == "__main__":
    unittest.main()
