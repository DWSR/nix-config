#!/usr/bin/env python3
"""Evaluated contract tests for the iii database, queue, and cron services."""

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
  names = [ "iii-database" "iii-queue" "iii-cron" ];
  service = name: guest.systemd.services.${name} or null;
  project = builtins.listToAttrs (map (name: {
    inherit name;
    value = let unit = service name; in if unit == null then null else {
      description = unit.description or null;
      wantedBy = unit.wantedBy;
      after = unit.after;
      requires = unit.requires;
      environment = unit.environment or { };
      execStart = unit.serviceConfig.ExecStart or null;
      user = unit.serviceConfig.User or null;
      group = unit.serviceConfig.Group or null;
      stateDirectory = unit.serviceConfig.StateDirectory or null;
      restart = unit.serviceConfig.Restart or null;
      restartSec = unit.serviceConfig.RestartSec or null;
    };
  }) names);
in project
'''


class IiiWorkerServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.services = json.loads(result.stdout)

    def test_each_worker_is_a_distinct_pinned_service_enabled_and_supervised(self):
        expected = {
            "iii-database": ("database", "0\\.5\\.26"),
            "iii-queue": ("queue", "0\\.21\\.26"),
            "iii-cron": ("cron", "0\\.21\\.28"),
        }
        self.assertEqual(set(self.services), set(expected))

        for unit_name, (binary, version) in expected.items():
            with self.subTest(unit=unit_name):
                service = self.services[unit_name]
                self.assertIsNotNone(service, f"missing {unit_name}.service")
                self.assertRegex(
                    service["execStart"],
                    rf'^/nix/store/[^ ]+-{binary}-{version}/bin/{binary}$',
                )
                self.assertEqual(service["wantedBy"], ["multi-user.target"])
                self.assertEqual(service["user"], "total-recall")
                self.assertEqual(service["group"], "total-recall")
                self.assertEqual(service["stateDirectory"], "total-recall")
                self.assertEqual(service["restart"], "always")
                self.assertEqual(service["restartSec"], 2)
                self.assertEqual(
                    service["environment"].get("III_URL"),
                    "ws://127.0.0.1:49134",
                )
                self.assertNotRegex(
                    json.dumps(service["environment"]),
                    r"(?i)(database_url|postgres_url|password|secret://)",
                )

    def test_worker_startup_requires_the_engine_and_database_waits_for_migrations(self):
        for unit_name, service in self.services.items():
            with self.subTest(unit=unit_name):
                self.assertIn("iii.service", service["after"])
                self.assertIn("iii.service", service["requires"])

        database = self.services["iii-database"]
        self.assertIn("total-recall-migrate.service", database["after"])
        self.assertIn("total-recall-migrate.service", database["requires"])

        for unit_name in ("iii-queue", "iii-cron"):
            with self.subTest(unit=unit_name):
                self.assertNotIn("total-recall-migrate.service", self.services[unit_name]["requires"])


if __name__ == "__main__":
    unittest.main()
