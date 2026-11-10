#!/usr/bin/env python3
"""Evaluated contract tests for the harness ingestion and persistence units."""

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
  names = [ "total-recall-harness-ingestion" "total-recall-harness-event-persistence" ];
  service = config: name: config.systemd.services.${name} or null;
  project = config: builtins.listToAttrs (map (name:
    let unit = service config name;
    in {
      inherit name;
      value = if unit == null then null else {
        wantedBy = unit.wantedBy;
        after = unit.after;
        requires = unit.requires;
        environment = builtins.removeAttrs (unit.environment or { }) [ "PATH" ];
        execStart = unit.serviceConfig.ExecStart or null;
        user = unit.serviceConfig.User or null;
        group = unit.serviceConfig.Group or null;
        stateDirectory = unit.serviceConfig.StateDirectory or null;
        restart = unit.serviceConfig.Restart or null;
        restartSec = unit.serviceConfig.RestartSec or null;
      };
    }
  ) names);
  custom = (lib.nixosSystem {
    system = "aarch64-linux";
    pkgs = guestSystem.pkgs;
    specialArgs.totalRecall = flake.inputs.total-recall;
    modules = [
      ./configurations/fabro-vm/total-recall.nix
      ({ ... }: {
        fabro.totalRecall = {
          enable = true;
          iiiHost = "127.0.0.2";
          iiiPort = 49999;
          databaseConnection = "custom-memory";
          queueTopic = "custom-topic";
        };
      })
    ];
  }).config;
in {
  executables = {
    ingestion = lib.getExe guestSystem.pkgs.total-recall-harness-ingestion;
    persistence = lib.getExe guestSystem.pkgs.total-recall-harness-event-persistence;
  };
  defaults = project guest;
  custom = project custom;
}
'''


class TotalRecallWorkerServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        evaluated = json.loads(result.stdout)
        cls.executables = evaluated["executables"]
        cls.defaults = dict(evaluated["defaults"])
        cls.custom = dict(evaluated["custom"])

    def test_both_units_run_the_pinned_worker_packages_and_share_supervision(self):
        expected_executables = {
            "total-recall-harness-ingestion": self.executables["ingestion"],
            "total-recall-harness-event-persistence": self.executables["persistence"],
        }
        for name, executable in expected_executables.items():
            with self.subTest(unit=name):
                unit = self.defaults[name]
                self.assertIsNotNone(unit, f"missing {name}.service")
                self.assertEqual(unit["execStart"], executable)
                self.assertTrue(unit["execStart"].startswith("/nix/store/"))
                self.assertEqual(unit["wantedBy"], ["multi-user.target"])
                self.assertEqual(unit["user"], "total-recall")
                self.assertEqual(unit["group"], "total-recall")
                self.assertEqual(unit["stateDirectory"], "total-recall")
                self.assertEqual(unit["restart"], "always")
                self.assertEqual(unit["restartSec"], 2)

    def test_workers_require_the_engine_migration_and_all_registry_workers(self):
        prerequisites = [
            "iii.service",
            "total-recall-migrate.service",
            "iii-database.service",
            "iii-queue.service",
            "iii-cron.service",
        ]
        for name, unit in self.defaults.items():
            with self.subTest(unit=name):
                self.assertIsNotNone(unit, f"missing {name}.service")
                for prerequisite in prerequisites:
                    self.assertIn(prerequisite, unit["after"])
                    self.assertIn(prerequisite, unit["requires"])

    def test_worker_environments_use_module_options_without_extra_connections(self):
        expected = {
            "total-recall-harness-ingestion": {
                "III_URL": "ws://127.0.0.1:49134",
                "TOTAL_RECALL_QUEUE_TOPIC": "harness-events",
            },
            "total-recall-harness-event-persistence": {
                "III_URL": "ws://127.0.0.1:49134",
                "TOTAL_RECALL_QUEUE_TOPIC": "harness-events",
                "TOTAL_RECALL_DATABASE": "memory",
            },
        }
        for name, environment in expected.items():
            with self.subTest(unit=name):
                self.assertIsNotNone(self.defaults[name], f"missing {name}.service")
                self.assertEqual(self.defaults[name]["environment"], environment)

        custom_expected = {
            "total-recall-harness-ingestion": {
                "III_URL": "ws://127.0.0.2:49999",
                "TOTAL_RECALL_QUEUE_TOPIC": "custom-topic",
            },
            "total-recall-harness-event-persistence": {
                "III_URL": "ws://127.0.0.2:49999",
                "TOTAL_RECALL_QUEUE_TOPIC": "custom-topic",
                "TOTAL_RECALL_DATABASE": "custom-memory",
            },
        }
        for name, environment in custom_expected.items():
            with self.subTest(custom_unit=name):
                self.assertIsNotNone(self.custom[name], f"missing {name}.service")
                self.assertEqual(self.custom[name]["environment"], environment)


if __name__ == "__main__":
    unittest.main()
