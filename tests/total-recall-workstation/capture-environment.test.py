#!/usr/bin/env python3
"""Evaluated contract tests for the workstation total-recall capture environment.

Task 8.3 exports `III_URL` and `HARNESS_EVENTS_BIN` through
`home.sessionVariables`, `home.opencode.wrapperCommands`, and
`programs.pi.coding-agent.environment`, all derived from the module's single
`endpoint` and `harnessEvents` option values.
"""

import json
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "home-manager" / "common" / "total-recall.nix"
FIXTURE_ENDPOINT = "wss://memory.example.invalid"

EXPRESSION = f'''
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  pathOf = value: builtins.unsafeDiscardStringContext (toString value);

  overlayPkgs = import flake.inputs.nixpkgs {{
    system = "aarch64-darwin";
    config.allowUnfree = true;
    overlays = [ flake.outputs.overlays.custom-packages ];
  }};

  fixtureModules = [
    {json.dumps(str(MODULE))}
    # The module writes the Pi environment, so the Pi home module must supply
    # that option in the isolated fixture.
    flake.inputs.pi.homeModules.default
    # `home.opencode.wrapperCommands` is declared by the common OpenCode
    # module on real hosts; stub only that surface here.
    ({{
      lib,
      ...
    }}: {{
      options.home.opencode.wrapperCommands = lib.mkOption {{
        type = lib.types.listOf lib.types.lines;
        default = [ ];
      }};
    }})
    {{
      home.username = "total-recall-test";
      home.homeDirectory = "/Users/total-recall-test";
      home.stateVersion = "26.05";
      home.totalRecall.endpoint = {json.dumps(FIXTURE_ENDPOINT)};
    }}
  ];

  mkFixture = extraModules: (flake.inputs.home-manager.lib.homeManagerConfiguration {{
    pkgs = overlayPkgs;
    modules = fixtureModules ++ extraModules;
  }}).config;

  personalSystem = flake.darwinConfigurations."Brandons-MacBook-Pro";
  personal = personalSystem.config.home-manager.users.brandonmcnama;
  personalDisabled = (personalSystem.extendModules {{
    modules = [
      ({{
        lib,
        ...
      }}: {{
        home-manager.users.brandonmcnama.home.totalRecall.enable = lib.mkForce false;
      }})
    ];
  }}).config.home-manager.users.brandonmcnama;

  piEnvironmentOf = hm:
    if hm.programs.pi.coding-agent.environment == null then
      {{ }}
    else
      builtins.mapAttrs
        (_name: value: if value ? value then value.value else null)
        hm.programs.pi.coding-agent.environment;

  environmentOf = hm: {{
    session = hm.home.sessionVariables;
    wrapper = builtins.concatStringsSep "\n" hm.home.opencode.wrapperCommands;
    wrapperCommandCount = builtins.length hm.home.opencode.wrapperCommands;
    pi = piEnvironmentOf hm;
  }};

  # The personal host launches OpenCode under nono, whose profiles admit only
  # the names in `environment.allowVars`. The capture variables exported by
  # the wrapper must be admitted to reach the sandboxed plugin.
  nonoAllowVarsOf = hm:
    builtins.mapAttrs (_: profile: profile.environment.allowVars) hm.programs.opencode-nono.profiles;

  enabledFixture = mkFixture [ {{ home.totalRecall.enable = true; }} ];
  disabledFixture = mkFixture [ ];
in {{
  personal = environmentOf personal;
  personalDisabled = environmentOf personalDisabled;
  personalNonoAllowVars = nonoAllowVarsOf personal;
  personalDisabledNonoAllowVars = nonoAllowVarsOf personalDisabled;
  personalEndpoint = personal.home.totalRecall.endpoint;
  personalHarnessEventsBin =
    "${{pathOf personal.home.totalRecall.harnessEvents}}/bin/harness-events";

  fixtureEndpoint = enabledFixture.home.totalRecall.endpoint;
  fixtureHarnessEventsBin =
    "${{pathOf enabledFixture.home.totalRecall.harnessEvents}}/bin/harness-events";
  enabled = environmentOf enabledFixture;
  disabled = environmentOf disabledFixture;
}}
'''


def export_pattern(name, value):
    return re.compile(rf"export\s+{name}=(?:\"[^\"]*\"|'[^']*'|\S*{re.escape(value)}\S*)")


class TotalRecallCaptureEnvironmentTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"Nix capture environment evaluation failed:\n{result.stderr}"
            )
        cls.evaluated = json.loads(result.stdout)
        cls.personal = cls.evaluated["personal"]
        cls.personal_disabled = cls.evaluated["personalDisabled"]
        cls.enabled = cls.evaluated["enabled"]
        cls.disabled = cls.evaluated["disabled"]

    def test_personal_shell_exports_the_shared_endpoint_and_cli(self):
        self.assertEqual(
            self.personal["session"].get("III_URL"),
            self.evaluated["personalEndpoint"],
        )
        self.assertEqual(
            self.personal["session"].get("HARNESS_EVENTS_BIN"),
            self.evaluated["personalHarnessEventsBin"],
        )

    def test_personal_opencode_wrapper_exports_both_variables(self):
        wrapper = self.personal["wrapper"]
        self.assertRegex(
            wrapper,
            export_pattern("III_URL", self.evaluated["personalEndpoint"]),
        )
        self.assertRegex(
            wrapper,
            export_pattern(
                "HARNESS_EVENTS_BIN", self.evaluated["personalHarnessEventsBin"]
            ),
        )

    def test_personal_pi_environment_carries_both_variables(self):
        self.assertEqual(
            self.personal["pi"].get("III_URL"),
            self.evaluated["personalEndpoint"],
        )
        self.assertEqual(
            self.personal["pi"].get("HARNESS_EVENTS_BIN"),
            self.evaluated["personalHarnessEventsBin"],
        )

    def test_fixture_values_come_from_the_two_option_values(self):
        self.assertEqual(
            self.enabled["session"].get("III_URL"),
            self.evaluated["fixtureEndpoint"],
        )
        self.assertEqual(
            self.enabled["session"].get("HARNESS_EVENTS_BIN"),
            self.evaluated["fixtureHarnessEventsBin"],
        )
        self.assertEqual(
            self.enabled["pi"].get("III_URL"),
            self.evaluated["fixtureEndpoint"],
        )
        self.assertEqual(
            self.enabled["pi"].get("HARNESS_EVENTS_BIN"),
            self.evaluated["fixtureHarnessEventsBin"],
        )
        self.assertRegex(
            self.enabled["wrapper"],
            export_pattern("III_URL", self.evaluated["fixtureEndpoint"]),
        )
        self.assertRegex(
            self.enabled["wrapper"],
            export_pattern(
                "HARNESS_EVENTS_BIN", self.evaluated["fixtureHarnessEventsBin"]
            ),
        )

    def test_module_adds_only_the_two_capture_variables(self):
        added_session = {
            name: value
            for name, value in self.personal["session"].items()
            if self.personal_disabled["session"].get(name) != value
        }
        self.assertEqual(
            sorted(added_session),
            ["HARNESS_EVENTS_BIN", "III_URL"],
        )

        added_pi = {
            name: value
            for name, value in self.personal["pi"].items()
            if self.personal_disabled["pi"].get(name) != value
        }
        self.assertEqual(
            sorted(added_pi),
            ["HARNESS_EVENTS_BIN", "III_URL"],
        )

    def test_module_adds_exactly_one_fail_open_wrapper_snippet(self):
        self.assertEqual(self.enabled["wrapperCommandCount"], 1)
        snippet = self.enabled["wrapper"]
        for forbidden in (
            "exit",
            "curl",
            "timeout",
            "until",
            "while ",
            "sleep",
            "retry",
        ):
            self.assertNotIn(forbidden, snippet)

    def test_personal_opencode_sandbox_admits_the_capture_variables(self):
        allow_vars = self.evaluated["personalNonoAllowVars"]
        for profile in (
            "opencode-audit",
            "opencode-managed",
            "opencode-review",
        ):
            self.assertIn(profile, allow_vars)
            self.assertIn("III_URL", allow_vars[profile], profile)
            self.assertIn("HARNESS_EVENTS_BIN", allow_vars[profile], profile)

    def test_disabled_module_does_not_admit_capture_variables_into_nono(self):
        allow_vars = self.evaluated["personalDisabledNonoAllowVars"]
        for profile, names in allow_vars.items():
            self.assertNotIn("III_URL", names, profile)
            self.assertNotIn("HARNESS_EVENTS_BIN", names, profile)

    def test_disabled_module_exports_nothing(self):
        self.assertEqual(self.disabled["wrapperCommandCount"], 0)
        self.assertNotIn("III_URL", self.disabled["session"])
        self.assertNotIn("HARNESS_EVENTS_BIN", self.disabled["session"])
        self.assertEqual(self.disabled["wrapper"], "")
        self.assertNotIn("III_URL", self.disabled["pi"])
        self.assertNotIn("HARNESS_EVENTS_BIN", self.disabled["pi"])

    def test_disabled_personal_host_has_no_capture_exports(self):
        self.assertNotIn("III_URL", self.personal_disabled["session"])
        self.assertNotIn("HARNESS_EVENTS_BIN", self.personal_disabled["session"])
        self.assertNotIn(
            f'export III_URL=',
            self.personal_disabled["wrapper"],
        )
        self.assertNotIn(
            f'export HARNESS_EVENTS_BIN=',
            self.personal_disabled["wrapper"],
        )
        self.assertNotIn("III_URL", self.personal_disabled["pi"])
        self.assertNotIn("HARNESS_EVENTS_BIN", self.personal_disabled["pi"])


if __name__ == "__main__":
    unittest.main()
