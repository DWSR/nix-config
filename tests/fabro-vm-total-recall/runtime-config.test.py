#!/usr/bin/env python3
"""Evaluated contract tests for the rendered iii engine configuration."""

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
  unit = guest.systemd.services.total-recall-config or null;
  script = if unit == null then "" else builtins.readFile unit.serviceConfig.ExecStart;
  paths = if unit == null then { } else {
    engine = builtins.head (builtins.match ".*(/nix/store/[a-z0-9]{32}-total-recall-iii-config.yaml).*" script);
    database = builtins.head (builtins.match ".*(/nix/store/[a-z0-9]{32}-database.yaml).*" script);
    queue = builtins.head (builtins.match ".*(/nix/store/[a-z0-9]{32}-queue.yaml).*" script);
    cron = builtins.head (builtins.match ".*(/nix/store/[a-z0-9]{32}-cron.yaml).*" script);
  };
in {
  unit = if unit == null then null else {
    type = unit.serviceConfig.Type or null;
    remainAfterExit = unit.serviceConfig.RemainAfterExit or false;
    wantedBy = unit.wantedBy;
    environment = builtins.attrNames unit.environment;
    systemdEnvironment = unit.serviceConfig.Environment or [ ];
    environmentFile = unit.serviceConfig.EnvironmentFile or [ ];
    stateDirectory = unit.serviceConfig.StateDirectory or [ ];
  };
  script = script;
  rendered = builtins.mapAttrs (_: path: builtins.readFile path) paths;
}
'''


class RuntimeConfigTests(unittest.TestCase):
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

    def test_config_unit_is_a_persistent_boot_oneshot_without_environment(self):
        unit = self.evaluated["unit"]
        self.assertIsNotNone(unit, "missing total-recall-config.service")
        self.assertEqual(unit["type"], "oneshot")
        self.assertTrue(unit["remainAfterExit"])
        self.assertIn("multi-user.target", unit["wantedBy"])
        self.assertEqual(unit["environment"], ["PATH"])
        self.assertEqual(unit["systemdEnvironment"], [])
        self.assertEqual(unit["environmentFile"], [])
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

    def test_engine_config_has_only_loopback_runtime_workers_and_file_state(self):
        rendered = self.evaluated["rendered"]
        engine = rendered["engine"]
        self.assertRegex(engine, r"host: 127\.0\.0\.1\n\s+port: 49134\n\s+name: iii-worker-manager")
        self.assertRegex(engine, r"host: 127\.0\.0\.1\n\s+port: 3112\n\s+name: iii-stream")
        self.assertRegex(engine, r"store_method: file_based\n\s+name: kv")
        self.assertIn("file_path: /var/lib/total-recall/stream", engine)
        self.assertRegex(engine, r"directory: /var/lib/total-recall/config\n\s+name: fs")
        self.assertIn("name: configuration", engine)
        worker_names = re.findall(r"^  name: ([^\n]+)$", engine, re.MULTILINE)
        self.assertEqual(worker_names, ["iii-worker-manager", "iii-stream", "configuration"])
        self.assertNotRegex(engine, r"(?im)^\s+name: (state|secrets|http)\s*$")
        self.assertNotIn("0.0.0.0", engine)

    def test_database_queue_and_cron_worker_entries_are_complete_and_credential_free(self):
        rendered = self.evaluated["rendered"]
        database = rendered["database"]
        for fragment in (
            "id: database", "name: database", "databases:", "memory:",
            "driver: postgres", "host: 127.0.0.1", "port: 5432",
            "user: memory_application", "database: memory", "mode: disable",
            "max: 10", "history_max_entries: 0",
        ):
            self.assertIn(fragment, database)
        self.assertIn("id: queue", rendered["queue"])
        self.assertIn("name: builtin", rendered["queue"])
        self.assertIn("store_method: file_based", rendered["queue"])
        self.assertIn("file_path: /var/lib/total-recall/queue", rendered["queue"])
        self.assertIn("id: cron", rendered["cron"])
        self.assertIn("name: local", rendered["cron"])
        for content in rendered.values():
            self.assertNotRegex(content, r"(?i)password|secret://|secret:|token")

    def test_oneshot_installs_rendered_files_and_configures_writable_state_paths(self):
        script = self.evaluated["script"]
        self.assertIn("/var/lib/total-recall/iii/config.yaml", script)
        self.assertIn("/var/lib/total-recall/config/database.yaml", script)
        self.assertIn("/var/lib/total-recall/config/queue.yaml", script)
        self.assertIn("/var/lib/total-recall/config/cron.yaml", script)
        self.assertIn("total-recall", script)
        self.assertIn("install", script)
        self.assertNotIn("Environment=", script)
        self.assertNotIn("EnvironmentFile=", script)


if __name__ == "__main__":
    unittest.main()
