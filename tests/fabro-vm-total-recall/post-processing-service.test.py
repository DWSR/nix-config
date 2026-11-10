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
  project = config:
    let unit = config.systemd.services.total-recall-session-post-processing or null;
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
      ({ ... }: {
        fabro.totalRecall = {
          enable = true;
          iiiHost = "127.0.0.2";
          iiiPort = 49999;
          databaseConnection = "custom-memory";
          postProcessingModel = "custom/model";
          postProcessingBaseUrl = "http://127.0.0.2:5000/v1/";
        };
      })
      ({ lib, ... }: {
        options.sops.templates = lib.mkOption {
          type = lib.types.attrsOf (lib.types.submodule ({ name, ... }: {
            options.path = lib.mkOption {
              type = lib.types.str;
              default = "/run/secrets/rendered/${name}";
            };
          }));
          default = { };
        };
        config.sops.templates."total-recall-env".path = "/run/secrets/rendered/custom-total-recall-env";
      })
    ];
  }).config;
in {
  default = project guest;
  custom = project custom;
  executable = lib.getExe guestSystem.pkgs.total-recall-session-post-processing;
  hasMemoryEmbedding = guest.systemd.services ? memory-embedding;
  envFile = guest.sops.templates."total-recall-env".path;
  customEnvFile = custom.sops.templates."total-recall-env".path;
}
'''


class PostProcessingServiceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(f"Nix post-processing evaluation failed:\n{result.stderr}")
        cls.evaluated = json.loads(result.stdout)

    def test_unit_runs_enabled_with_shared_supervision_and_secret_file(self):
        unit = self.evaluated["default"]
        self.assertIsNotNone(unit, "missing total-recall-session-post-processing.service")
        self.assertEqual(unit["execStart"], self.evaluated["executable"])
        self.assertTrue(unit["execStart"].startswith("/nix/store/"))
        self.assertEqual(unit["wantedBy"], ["multi-user.target"])
        self.assertEqual(unit["user"], "total-recall")
        self.assertEqual(unit["group"], "total-recall")
        self.assertEqual(unit["stateDirectory"], "total-recall")
        self.assertEqual(unit["restart"], "always")
        self.assertEqual(unit["restartSec"], 2)
        self.assertEqual(unit["environmentFile"], self.evaluated["envFile"])
        self.assertEqual(self.evaluated["custom"]["environmentFile"], self.evaluated["customEnvFile"])
        self.assertTrue(unit["environmentFile"].startswith("/run/secrets/rendered/"))

        prerequisites = [
            "iii.service",
            "total-recall-migrate.service",
            "iii-database.service",
            "iii-queue.service",
            "iii-cron.service",
        ]
        for prerequisite in prerequisites:
            with self.subTest(prerequisite=prerequisite):
                self.assertIn(prerequisite, unit["after"])
                self.assertIn(prerequisite, unit["requires"])

    def test_environment_uses_options_and_no_embedding_or_schedule_overrides(self):
        expected = {
            "III_URL": "ws://127.0.0.1:49134",
            "TOTAL_RECALL_POST_PROCESSING_DATABASE": "memory",
            "TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE": "memory",
            "TOTAL_RECALL_POST_PROCESSING_PROVIDER": "openai",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_BASE_URL": "http://127.0.0.1:4000/v1/",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_MODEL": "opencode-go/deepseek-v4.1-flash",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_OUTPUT_MODE": "prompt",
        }
        self.assertEqual(self.evaluated["default"]["environment"], expected)

        custom_expected = {
            "III_URL": "ws://127.0.0.2:49999",
            "TOTAL_RECALL_POST_PROCESSING_DATABASE": "custom-memory",
            "TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE": "custom-memory",
            "TOTAL_RECALL_POST_PROCESSING_PROVIDER": "openai",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_BASE_URL": "http://127.0.0.2:5000/v1/",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_MODEL": "custom/model",
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_OUTPUT_MODE": "prompt",
        }
        self.assertEqual(self.evaluated["custom"]["environment"], custom_expected)

        self.assertFalse(self.evaluated["hasMemoryEmbedding"], "unexpected memory-embedding unit")
        self.assertNotIn("TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN", self.evaluated["default"]["environment"])
        self.assertNotIn("TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN", self.evaluated["custom"]["environment"])
        for unit in (self.evaluated["default"], self.evaluated["custom"]):
            with self.subTest(environment=unit["environment"]):
                self.assertFalse(
                    any("CRON" in name or "INACTIVITY" in name for name in unit["environment"]),
                    "worker schedule/inactivity overrides must stay at the upstream defaults",
                )


if __name__ == "__main__":
    unittest.main()
