#!/usr/bin/env python3
"""Evaluated contract tests for the session post-processing worker."""

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
  names = [ "total-recall-session-post-processing" ];
  service = config: name: config.systemd.services.${name} or null;
  project = config: name:
    let unit = service config name;
    in if unit == null then null else {
      wantedBy = unit.wantedBy;
      after = unit.after;
      requires = unit.requires;
      environment = builtins.removeAttrs (unit.environment or { }) [ "PATH" ];
      environmentFile = unit.serviceConfig.EnvironmentFile or null;
      execStart = unit.serviceConfig.ExecStart or null;
      user = unit.serviceConfig.User or null;
      group = unit.serviceConfig.Group or null;
      stateDirectory = unit.serviceConfig.StateDirectory or null;
      restart = unit.serviceConfig.Restart or null;
      restartSec = unit.serviceConfig.RestartSec or null;
    };
  custom = (lib.nixosSystem {
    system = "aarch64-linux";
    pkgs = guestSystem.pkgs;
    specialArgs.totalRecall = flake.inputs.total-recall;
    modules = [
      ./configurations/fabro-vm/total-recall.nix
      ({ lib, ... }: {
        options.sops.templates."total-recall-env".path = lib.mkOption {
          type = lib.types.str;
        };
        config.sops.templates."total-recall-env".path = "/run/secrets/rendered/total-recall-env";
        config.fabro.totalRecall = {
          enable = true;
          iiiHost = "127.0.0.2";
          iiiPort = 49999;
          databaseConnection = "custom-memory";
          postProcessingModel = "test/model";
          postProcessingBaseUrl = "http://127.0.0.2:4100/v1/";
        };
      })
    ];
  }).config;
  name = builtins.head names;
in {
  executable = lib.getExe guestSystem.pkgs.total-recall-session-post-processing;
  default = project guest name;
  custom = project custom name;
  embeddingUnitExists = guest.systemd.services ? memory-embedding;
}
'''


class SessionPostProcessingServiceTests(unittest.TestCase):
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

    def test_unit_uses_the_pinned_worker_and_shared_supervision(self):
        unit = self.evaluated["default"]
        self.assertIsNotNone(unit, "missing total-recall-session-post-processing.service")
        self.assertEqual(unit["execStart"], self.evaluated["executable"])
        self.assertEqual(unit["wantedBy"], ["multi-user.target"])
        self.assertEqual(unit["user"], "total-recall")
        self.assertEqual(unit["group"], "total-recall")
        self.assertEqual(unit["stateDirectory"], "total-recall")
        self.assertEqual(unit["restart"], "always")
        self.assertEqual(unit["restartSec"], 2)

    def test_environment_file_and_dependency_chain_match_other_total_recall_workers(self):
        unit = self.evaluated["default"]
        self.assertIsNotNone(unit, "missing total-recall-session-post-processing.service")
        self.assertEqual(unit["environmentFile"], "/run/secrets/rendered/total-recall-env")
        prerequisites = [
            "iii.service",
            "total-recall-migrate.service",
            "iii-database.service",
            "iii-queue.service",
            "iii-cron.service",
        ]
        self.assertEqual(unit["after"], prerequisites)
        self.assertEqual(unit["requires"], prerequisites)

    def test_worker_uses_memory_and_configured_openai_gateway_without_embedding_or_token(self):
        unit = self.evaluated["default"]
        self.assertIsNotNone(unit, "missing total-recall-session-post-processing.service")
        self.assertEqual(
            unit["environment"],
            {
                "III_URL": "ws://127.0.0.1:49134",
                "TOTAL_RECALL_POST_PROCESSING_DATABASE": "memory",
                "TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE": "memory",
                "TOTAL_RECALL_POST_PROCESSING_PROVIDER": "openai",
                "TOTAL_RECALL_POST_PROCESSING_OPENAI_BASE_URL": "http://127.0.0.1:4000/v1/",
                "TOTAL_RECALL_POST_PROCESSING_OPENAI_MODEL": "opencode-go/deepseek-v4.1-flash",
                "TOTAL_RECALL_POST_PROCESSING_OPENAI_OUTPUT_MODE": "prompt",
            },
        )
        self.assertFalse(self.evaluated["embeddingUnitExists"])

    def test_connection_and_model_options_flow_to_unit_environment(self):
        unit = self.evaluated["custom"]
        self.assertIsNotNone(unit, "missing configured post-processing worker")
        self.assertEqual(unit["environment"]["III_URL"], "ws://127.0.0.2:49999")
        self.assertEqual(unit["environment"]["TOTAL_RECALL_POST_PROCESSING_DATABASE"], "custom-memory")
        self.assertEqual(unit["environment"]["TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE"], "custom-memory")
        self.assertEqual(unit["environment"]["TOTAL_RECALL_POST_PROCESSING_OPENAI_MODEL"], "test/model")
        self.assertEqual(unit["environment"]["TOTAL_RECALL_POST_PROCESSING_OPENAI_BASE_URL"], "http://127.0.0.2:4100/v1/")


if __name__ == "__main__":
    unittest.main()
