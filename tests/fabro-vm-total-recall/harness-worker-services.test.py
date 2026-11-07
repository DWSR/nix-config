#!/usr/bin/env python3
"""Evaluated contract tests for the harness ingestion and persistence services."""

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  guest = flake.nixosConfigurations.fabro-vm.config;
  names = [
    "total-recall-harness-ingestion"
    "total-recall-harness-event-persistence"
  ];
  packages = {
    total-recall-harness-ingestion = flake.nixosConfigurations.fabro-vm.pkgs.total-recall-harness-ingestion;
    total-recall-harness-event-persistence = flake.nixosConfigurations.fabro-vm.pkgs.total-recall-harness-event-persistence;
  };
  project = guest: builtins.listToAttrs (map (name: {
    inherit name;
    value = let unit = guest.systemd.services.${name} or null; in if unit == null then null else {
      wantedBy = unit.wantedBy;
      after = unit.after;
      requires = unit.requires;
      environment = unit.environment or { };
      execStart = unit.serviceConfig.ExecStart or null;
      execStartPre = unit.serviceConfig.ExecStartPre or null;
      execStartPost = unit.serviceConfig.ExecStartPost or [ ];
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
  customConfigScript = builtins.readFile customGuest.systemd.services.total-recall-config.serviceConfig.ExecStart;
  customQueuePath = builtins.head (builtins.match ".*(/nix/store/[a-z0-9]{32}-queue.yaml).*" customConfigScript);
  persistenceReadinessPath = guest.systemd.services.total-recall-harness-ingestion.serviceConfig.ExecStartPre;
in {
  services = project guest;
  customServices = project customGuest;
  customQueueConfig = builtins.readFile customQueuePath;
  readinessScript = builtins.readFile guest.systemd.services.total-recall-harness-ingestion.serviceConfig.ExecStartPre;
  customReadinessScript = builtins.readFile customGuest.systemd.services.total-recall-harness-ingestion.serviceConfig.ExecStartPre;
  persistenceReadinessScript = builtins.readFile persistenceReadinessPath;
  readinessExecutable = guest.systemd.services.total-recall-harness-ingestion.serviceConfig.ExecStartPre;
  persistenceReadinessExecutable = guest.systemd.services.total-recall-harness-event-persistence.serviceConfig.ExecStartPost;
  iiiExec = "${flake.nixosConfigurations.fabro-vm.pkgs.total-recall-iii}/bin/iii";
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

        for unit_name in (
            "total-recall-harness-ingestion",
            "total-recall-harness-event-persistence",
        ):
            service = services[unit_name]
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

        readiness = self.evaluated["readinessExecutable"]
        self.assertTrue(readiness)
        self.assertTrue(self.evaluated["persistenceReadinessExecutable"])
        self.assertNotEqual(
            services["total-recall-harness-ingestion"]["execStart"],
            readiness,
        )
        readiness_script = self.evaluated["readinessScript"]
        for function in (
            "engine::workers::list",
            "database::execute",
            "queue::define",
            "engine::triggers::list",
            "cron::on-tick",
            "engine::queue::list_topics",
        ):
            self.assertIn(function, readiness_script)
        self.assertIn("harness-events", readiness_script)
        self.assertIn(self.evaluated["iiiExec"], readiness_script)
        self.assertIn('"cron"', readiness_script)
        self.assertIn('"queue"', readiness_script)
        self.assertIn('"database"', readiness_script)
        self.assertTrue(services["total-recall-harness-ingestion"]["execStartPre"])
        self.assertTrue(services["total-recall-harness-event-persistence"]["execStartPost"])

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
        self.assertIn("192.0.2.55", self.evaluated["customReadinessScript"])
        self.assertIn("51321", self.evaluated["customReadinessScript"])
        self.assertIn('custom-topic: {}', self.evaluated["customQueueConfig"])
        self.assertNotEqual(
            self.evaluated["readinessScript"],
            self.evaluated["persistenceReadinessScript"],
        )

    def run_readiness_gate(self, *, has_topic, has_subscriber=True, persistence=False):
        with tempfile.TemporaryDirectory() as directory:
            fake_iii = Path(directory) / "iii"
            fake_iii.write_text(
                "#!/usr/bin/env python3\n"
                "import json, os, sys\n"
                "args = sys.argv[1:]\n"
                "function = args[args.index('--engine') + 2]\n"
                "if function == 'engine::workers::list':\n"
                "    result = {'workers': [\n"
                "        {'name': 'database', 'status': 'connected'},\n"
                "        {'name': 'queue', 'status': 'connected'},\n"
                "        {'name': 'cron', 'status': 'connected'},\n"
                "    ]}\n"
                "elif function == 'engine::functions::info':\n"
                "    result = {'functions': [\n"
                "        {'function_id': 'database::execute', 'worker_name': 'database'},\n"
                "        {'function_id': 'queue::define', 'worker_name': 'queue'},\n"
                "        {'function_id': 'iii::durable::publish', 'worker_name': 'queue'},\n"
                "        {'function_id': 'cron::on-tick', 'worker_name': 'cron'},\n"
                "    ]}\n"
                "elif function == 'engine::triggers::list':\n"
                "    result = {'triggers': [\n"
                "        {'id': 'durable:subscriber', 'worker_name': 'queue'},\n"
                "        {'id': 'cron', 'worker_name': 'cron'},\n"
                "    ]}\n"
                "elif function == 'engine::queue::list_topics':\n"
                "    result = [{'name': 'harness-events', 'broker_type': 'builtin'}] if os.environ['HAS_TOPIC'] == '1' else []\n"
                "elif function == 'engine::registered-triggers::list':\n"
                "    result = {'registered_triggers': [{'status': 'active', 'trigger_type': 'durable:subscriber', 'function_id': 'harness::persist_event'}]} if os.environ['HAS_SUBSCRIBER'] == '1' else {'registered_triggers': []}\n"
                "print(json.dumps(result))\n"
            )
            fake_iii.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                III_REGISTRY_III_BIN=str(fake_iii),
                III_REGISTRY_READINESS_ATTEMPTS="1",
                III_REGISTRY_READINESS_INTERVAL="0",
                HAS_TOPIC="1" if has_topic else "0",
                HAS_SUBSCRIBER="1" if has_subscriber else "0",
                READINESS_MODE="persistence-subscriber" if persistence else "",
            )
            executable = self.evaluated["readinessExecutable"]
            command = [executable]
            if persistence:
                command = ["bash", "-c", executable + " persistence-subscriber"]
            environment["III_REGISTRY_READINESS_ATTEMPTS"] = "1"
            result = subprocess.run(
                command,
                env=environment,
                capture_output=True,
                text=True,
                timeout=5,
            )
            return result

    def test_registry_gate_checks_live_registry_and_rejects_unready_topic(self):
        script = self.evaluated["readinessScript"]
        self.assertIn("engine::workers::list", script)
        self.assertIn("engine::functions::info", script)
        self.assertIn("engine::triggers::list", script)
        self.assertIn("engine::queue::list_topics", script)
        self.assertIn("harness::persist_event", script)
        self.assertIn("engine::registered-triggers::list", script)
        self.assertIn("harness-events", script)
        self.assertIn('"database::execute":"database"', script)
        self.assertIn('"iii::durable::publish":"queue"', script)
        self.assertIn("attempts=15", script)
        self.assertIn("--timeout-ms 1000", script)
        self.assertIn("timeout 3", script)
        self.assertIn("exit 1", script)
        ready_result = self.run_readiness_gate(has_topic=True)
        self.assertEqual(ready_result.returncode, 0, ready_result.stderr)
        missing_topic_result = self.run_readiness_gate(has_topic=False)
        self.assertNotEqual(missing_topic_result.returncode, 0)
        self.assertIn("topic 'harness-events'", missing_topic_result.stderr)
        missing_subscriber_result = self.run_readiness_gate(
            has_topic=True,
            has_subscriber=False,
            persistence=True,
        )
        self.assertNotEqual(missing_subscriber_result.returncode, 0)
        self.assertIn("persistence subscriber not ready", missing_subscriber_result.stderr)
        persistence_result = self.run_readiness_gate(
            has_topic=True,
            persistence=True,
        )
        self.assertEqual(persistence_result.returncode, 0, persistence_result.stderr)
        self.assertTrue(
            self.evaluated["services"]["total-recall-harness-ingestion"]["execStartPre"],
            "ingestion must wait for registry workers and the queue topic",
        )
        self.assertTrue(
            self.evaluated["services"]["total-recall-harness-event-persistence"]["execStartPost"],
            "persistence must report active only after its trigger is registered",
        )
        self.assertIn(
            "persistence-subscriber",
            self.evaluated["services"]["total-recall-harness-event-persistence"]["execStartPost"],
        )


if __name__ == "__main__":
    unittest.main()
