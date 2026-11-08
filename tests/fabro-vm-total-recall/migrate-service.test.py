#!/usr/bin/env python3
"""Evaluated contract tests for the guest migration service."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  guestSystem = flake.nixosConfigurations.fabro-vm;
  guest = guestSystem.config;
  migration = guest.systemd.services.total-recall-migrate;
  postgresql = guest.systemd.services.postgresql;
  customGuest = (lib.nixosSystem {
    system = "aarch64-linux";
    pkgs = guestSystem.pkgs;
    specialArgs.totalRecall = flake.inputs.total-recall;
    modules = [
      ./configurations/fabro-vm/total-recall.nix
      ({ ... }: { fabro.totalRecall = { enable = true; databaseName = "custom_memory"; }; })
    ];
  }).config;
in {
  type = migration.serviceConfig.Type or null;
  user = migration.serviceConfig.User or null;
  wantedBy = migration.wantedBy;
  after = migration.after;
  requires = migration.requires;
  execStart = migration.serviceConfig.ExecStart or null;
  restart = migration.serviceConfig.Restart or null;
  stateDirectory = migration.serviceConfig.StateDirectory or null;
  postgresqlAfter = postgresql.after or [ ];
  postgresqlRequires = postgresql.requires or [ ];
  customExecStart = customGuest.systemd.services.total-recall-migrate.serviceConfig.ExecStart;
}
'''


class MigrationServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.service = json.loads(result.stdout)

    def test_service_is_a_boot_enabled_postgres_oneshot(self):
        self.assertEqual(self.service["type"], "oneshot")
        self.assertEqual(self.service["user"], "postgres")
        self.assertEqual(self.service["wantedBy"], ["multi-user.target"])
        self.assertIn("postgresql.service", self.service["after"])
        self.assertIn("postgresql.service", self.service["requires"])

    def test_service_executes_the_packaged_runner_with_database_name(self):
        self.assertRegex(
            self.service["execStart"],
            r'^"/nix/store/[^ ]+-total-recall-migrate-1/bin/migrate\.sh" "memory"$',
        )

    def test_exec_start_uses_the_configured_database_name(self):
        self.assertTrue(self.service["customExecStart"].endswith('/bin/migrate.sh" "custom_memory"'))

    def test_service_retries_failures_without_owning_state_or_gating_postgresql(self):
        self.assertEqual(self.service["restart"], "on-failure")
        self.assertIsNone(self.service["stateDirectory"])
        self.assertNotIn("total-recall-migrate.service", self.service["postgresqlAfter"])
        self.assertNotIn("total-recall-migrate.service", self.service["postgresqlRequires"])


if __name__ == "__main__":
    unittest.main()
