#!/usr/bin/env python3
"""Evaluated contract tests for the harness ingestion and persistence services."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  guest = flake.nixosConfigurations.fabro-vm.config;
  names = [ "total-recall-harness-ingestion" "total-recall-harness-event-persistence" ];
  packages = {
    total-recall-harness-ingestion = flake.nixosConfigurations.fabro-vm.pkgs.total-recall-harness-ingestion;
    total-recall-harness-event-persistence = flake.nixosConfigurations.fabro-vm.pkgs.total-recall-harness-event-persistence;
  };
  service = name: guest.systemd.services.${name} or null;
  project = guest: builtins.listToAttrs (map (name: {
    inherit name;
    value = let unit = guest.systemd.services.${name} or null; in if unit == null then null else {
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
  customGuest = (flake.nixosConfigurations.fabro-vm.extendModules {
    modules = [ {
      fabro.totalRecall = {
        iiiHost = "192.0.2.55";
        iiiPort = 51321;
        queueTopic = "custom-topic";
        databaseConnection = "custom-memory";
      };
    } ];
  }).config;
in {
  services = project guest;
  customServices = project customGuest;
  packageExecs = builtins.mapAttrs (_: package: "${package}/bin/${package.meta.mainProgram}") packages;
}
'''


class HarnessWorkerServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"Nix worker evaluation failed:\n{result.stderr}")
        cls.evaluated = json.loads(result.stdout)

    def test_both_workers_are_pinned_distinct_services_enabled_and_supervised(self):
        services = self.evaluated["services"]
        self.assertEqual(
            set(services),
            {"total-recall-harness-ingestion", "total-recall-harness-event-persistence"},
        )

        for unit_name, package_name in (
            ("total-recall-harness-ingestion", "total-recall-harness-ingestion"),
            (
                "total-recall-harness-event-persistence",
                "total-recall-harness-event-persistence",
            ),
        ):
            with self.subTest(unit=unit_name):
                service = services[unit_name]
                self.assertIsNotNone(service, f"missing {unit_name}.service")
                self.assertEqual(service["execStart"], self.evaluated["packageExecs"][package_name])
                self.assertEqual(service["wantedBy"], ["multi-user.target"])
                self.assertEqual(service["user"], "total-recall")
                self.assertEqual(service["group"], "total-recall")
                self.assertEqual(service["stateDirectory"], "total-recall")
                self.assertEqual(service["restart"], "always")
                self.assertEqual(service["restartSec"], 2)

    def test_workers_share_module_endpoint_topic_and_registration_dependencies(self):
        services = self.evaluated["services"]
        dependencies = {
            "iii.service",
            "total-recall-migrate.service",
            "iii-database.service",
            "iii-queue.service",
            "iii-cron.service",
        }

        for unit_name, service in services.items():
            with self.subTest(unit=unit_name):
                self.assertEqual(
                    service["environment"].get("III_URL"), "ws://127.0.0.1:49134"
                )
                self.assertEqual(
                    service["environment"].get("TOTAL_RECALL_QUEUE_TOPIC"),
                    "harness-events",
                )
                self.assertTrue(dependencies.issubset(service["after"]))
                self.assertTrue(dependencies.issubset(service["requires"]))

        ingestion = services["total-recall-harness-ingestion"]["environment"]
        persistence = services["total-recall-harness-event-persistence"]["environment"]
        custom_services = self.evaluated["customServices"]
        custom_ingestion = custom_services["total-recall-harness-ingestion"]["environment"]
        custom_persistence = custom_services["total-recall-harness-event-persistence"]["environment"]

        for environment in (ingestion, persistence, custom_ingestion, custom_persistence):
            self.assertNotRegex(json.dumps(environment), r"(?i)embedding|database_url|secret://")
        self.assertEqual(
            {key for key in ingestion if key != "PATH"},
            {"III_URL", "TOTAL_RECALL_QUEUE_TOPIC"},
        )
        self.assertEqual(
            {key for key in persistence if key != "PATH"},
            {"III_URL", "TOTAL_RECALL_QUEUE_TOPIC", "TOTAL_RECALL_DATABASE"},
        )
        self.assertEqual(persistence["TOTAL_RECALL_DATABASE"], "memory")
        self.assertEqual(custom_ingestion["III_URL"], "ws://192.0.2.55:51321")
        self.assertEqual(custom_ingestion["TOTAL_RECALL_QUEUE_TOPIC"], "custom-topic")
        self.assertEqual(custom_persistence["III_URL"], "ws://192.0.2.55:51321")
        self.assertEqual(custom_persistence["TOTAL_RECALL_QUEUE_TOPIC"], "custom-topic")
        self.assertEqual(custom_persistence["TOTAL_RECALL_DATABASE"], "custom-memory")


if __name__ == "__main__":
    unittest.main()
