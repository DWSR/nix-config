#!/usr/bin/env python3
"""Evaluated contract tests for the guest post-processing sops template."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EXPRESSION = r'''
let
  lib = (builtins.getFlake (toString ./.)).inputs.nixpkgs.lib;
  vm = (builtins.getFlake (toString ./.)).nixosConfigurations.fabro-vm.config;
  tokenVariable = "TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN";
  services = builtins.mapAttrs (_: unit:
    builtins.hasAttr tokenVariable (unit.environment or { })
    || lib.hasInfix tokenVariable (builtins.toJSON (unit.serviceConfig.Environment or null))
  ) vm.systemd.services;
in {
  placeholder = vm.sops.placeholder."litellm-master-key";
  template = vm.sops.templates."total-recall-env" or null;
  services = services;
}
'''


class TotalRecallSopsTemplateTests(unittest.TestCase):
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

    def test_template_contains_only_the_existing_litellm_placeholder(self):
        template = self.evaluated["template"]
        self.assertIsNotNone(template, "missing sops.templates.total-recall-env")
        self.assertEqual(
            template["content"],
            "TOTAL_RECALL_POST_PROCESSING_OPENAI_API_TOKEN="
            + self.evaluated["placeholder"]
            + "\n",
        )
        self.assertEqual(
            template["restartUnits"],
            ["total-recall-session-post-processing.service"],
        )

    def test_template_path_is_runtime_state_and_no_unit_environment_has_token(self):
        template = self.evaluated["template"]
        self.assertIsNotNone(template, "missing sops.templates.total-recall-env")
        self.assertTrue(
            template["path"].startswith("/run/secrets/rendered/"),
            f"template path is not outside the Nix store: {template['path']}",
        )
        self.assertNotIn("/nix/store/", template["path"])

        offenders = [
            name for name, contains_token in self.evaluated["services"].items() if contains_token
        ]
        self.assertEqual(offenders, [], f"token leaked into unit Environment=: {offenders}")


if __name__ == "__main__":
    unittest.main()
