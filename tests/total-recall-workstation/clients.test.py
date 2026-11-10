#!/usr/bin/env python3
"""Evaluated contract tests for the workstation total-recall client packages."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "home-manager" / "common" / "total-recall.nix"
PERSONAL_HOST = ROOT / "configurations" / "personal" / "home-manager" / "default.nix"
FIXTURE_ENDPOINT = "wss://memory.example.invalid"
PLUGIN_KEY = "opencode/plugins/total-recall-harness-events.js"

EXPRESSION = f'''
let
  flake = builtins.getFlake (toString ./.);
  lib = flake.inputs.nixpkgs.lib;
  pathOf = value: builtins.unsafeDiscardStringContext (toString value);
  pluginKey = {json.dumps(PLUGIN_KEY)};

  overlayPkgs = import flake.inputs.nixpkgs {{
    system = "aarch64-darwin";
    config.allowUnfree = true;
    overlays = [ flake.outputs.overlays.custom-packages ];
  }};

  clientPackages = hm: {{
    harnessEvents = pathOf hm.home.totalRecall.harnessEvents;
    opencodePlugin = pathOf hm.home.totalRecall.opencodePlugin;
    piExtension = pathOf hm.home.totalRecall.piExtension;
    mcpWorker = pathOf hm.home.totalRecall.mcpWorker;
  }};

  pluginOf = hm:
    if hm.xdg.configFile ? ${{pluginKey}} then {{
      declared = true;
      source = pathOf hm.xdg.configFile.${{pluginKey}}.source;
      target = hm.xdg.configFile.${{pluginKey}}.target;
    }} else {{
      declared = false;
      source = "";
      target = "";
    }};

  piExtensionsOf = hm: map pathOf hm.programs.pi.coding-agent.extensions;
  packagePathsOf = hm: map pathOf hm.home.packages;
  packageNamesOf = hm: map (pkg: pkg.name or "") hm.home.packages;

  fixtureModules = [
    {json.dumps(str(MODULE))}
    # The module writes the Pi environment alongside the extension list, so
    # the fixture imports the Pi home module that declares both options.
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
      ({{ lib, ... }}: {{
        home-manager.users.brandonmcnama.home.totalRecall.enable = lib.mkForce false;
      }})
    ];
  }}).config.home-manager.users.brandonmcnama;

  enabledFixture = mkFixture [ {{ home.totalRecall.enable = true; }} ];
  disabledFixture = mkFixture [ ];
in {{
  personal = {{
    enable = personal.home.totalRecall.enable;
    homeDirectory = personal.home.homeDirectory;
    xdgConfigHome = personal.xdg.configHome;
    clientPackages = clientPackages personal;
    packagePaths = packagePathsOf personal;
    packageNames = packageNamesOf personal;
    plugin = pluginOf personal;
    piExtensions = piExtensionsOf personal;
    agentMemoryPiExtension =
      pathOf "${{personal.programs.agentmemory.package}}/lib/node_modules/@agentmemory/agentmemory/integrations/pi/index.ts";
    totalRecallLaunchdAgents =
      builtins.filter (name: lib.hasInfix "total-recall" name) (builtins.attrNames personal.launchd.agents);
  }};
  personalDisabled = {{
    enable = personalDisabled.home.totalRecall.enable;
    packagePaths = packagePathsOf personalDisabled;
    plugin = pluginOf personalDisabled;
    piExtensions = piExtensionsOf personalDisabled;
  }};
  defaults = {{
    harnessEventsMatches = enabledFixture.home.totalRecall.harnessEvents == overlayPkgs.total-recall-harness-events;
    opencodePluginMatches = enabledFixture.home.totalRecall.opencodePlugin == overlayPkgs.total-recall-opencode-plugin;
    piExtensionMatches = enabledFixture.home.totalRecall.piExtension == overlayPkgs.total-recall-pi-extension;
    mcpWorkerMatches = enabledFixture.home.totalRecall.mcpWorker == overlayPkgs.total-recall-mcp-worker;
    harnessInPackages = builtins.elem
      (pathOf enabledFixture.home.totalRecall.harnessEvents)
      (packagePathsOf enabledFixture);
    plugin = pluginOf enabledFixture;
    piExtensions = piExtensionsOf enabledFixture;
  }};
  disabledFixture = {{
    enable = disabledFixture.home.totalRecall.enable;
    harnessInPackages = builtins.elem
      (pathOf disabledFixture.home.totalRecall.harnessEvents)
      (packagePathsOf disabledFixture);
    plugin = pluginOf disabledFixture;
    piExtensions = piExtensionsOf disabledFixture;
  }};
}}
'''

RUNTIME_PACKAGE_NAMES = (
    "iii",
    "postgresql",
    "total-recall-iii",
    "total-recall-database",
    "total-recall-queue",
    "total-recall-cron",
)


class TotalRecallWorkstationClientTests(unittest.TestCase):
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
                f"Nix workstation client evaluation failed:\n{result.stderr}"
            )
        cls.evaluated = json.loads(result.stdout)
        cls.personal = cls.evaluated["personal"]
        cls.personal_disabled = cls.evaluated["personalDisabled"]
        cls.defaults = cls.evaluated["defaults"]
        cls.disabled_fixture = cls.evaluated["disabledFixture"]

    def test_personal_host_installs_the_pinned_capture_cli(self):
        self.assertTrue(self.personal["enable"])
        self.assertIn(
            self.personal["clientPackages"]["harnessEvents"],
            self.personal["packagePaths"],
        )
        self.assertIn(
            "total-recall-harness-events",
            self.personal["clientPackages"]["harnessEvents"],
        )

    def test_personal_host_installs_the_opencode_plugin_under_xdg_config(self):
        self.assertEqual(
            self.personal["xdgConfigHome"],
            self.personal["homeDirectory"] + "/.config",
        )
        self.assertTrue(self.personal["plugin"]["declared"])
        self.assertEqual(
            self.personal["plugin"]["source"],
            self.personal["clientPackages"]["opencodePlugin"] + "/dist/index.js",
        )
        self.assertEqual(
            self.personal["plugin"]["target"],
            ".config/opencode/plugins/total-recall-harness-events.js",
        )

    def test_personal_host_adds_the_pi_extension_package_root(self):
        pi_extension = self.personal["clientPackages"]["piExtension"]
        self.assertIn(pi_extension, self.personal["piExtensions"])
        self.assertIn("pi-harness-events", pi_extension)
        self.assertNotIn("/src/index.ts", pi_extension)

    def test_personal_host_keeps_the_existing_pi_and_launchd_wiring(self):
        self.assertIn(
            self.personal["agentMemoryPiExtension"],
            self.personal["piExtensions"],
        )
        self.assertEqual(
            sorted(self.personal["piExtensions"]),
            sorted(
                self.personal_disabled["piExtensions"]
                + [self.personal["clientPackages"]["piExtension"]]
            ),
        )
        self.assertEqual(self.personal["totalRecallLaunchdAgents"], [])

    def test_personal_host_adds_only_the_cli_to_home_packages(self):
        def without_capture_derivatives(paths):
            # The Pi wrapper, the OpenCode wrapper, and the generated
            # session-vars file are rebuilt whenever the capture environment
            # changes, so exclude that expected churn.
            return {
                path
                for path in paths
                if not path.endswith(("-pi", "-opencode", "-hm-session-vars.sh"))
            }

        self.assertEqual(
            without_capture_derivatives(self.personal["packagePaths"])
            - without_capture_derivatives(self.personal_disabled["packagePaths"]),
            {self.personal["clientPackages"]["harnessEvents"]},
        )
        self.assertFalse(self.personal_disabled["plugin"]["declared"])

    def test_package_options_default_to_the_pinned_overlay_packages(self):
        for key in (
            "harnessEventsMatches",
            "opencodePluginMatches",
            "piExtensionMatches",
            "mcpWorkerMatches",
            "harnessInPackages",
        ):
            self.assertTrue(self.defaults[key], key)
        self.assertTrue(self.defaults["plugin"]["declared"])
        self.assertEqual(
            self.defaults["plugin"]["target"],
            ".config/opencode/plugins/total-recall-harness-events.js",
        )
        self.assertTrue(
            self.defaults["plugin"]["source"].endswith("/dist/index.js")
        )
        self.assertIn("opencode-harness-events", self.defaults["plugin"]["source"])
        self.assertEqual(len(self.defaults["piExtensions"]), 1)
        self.assertIn("pi-harness-events", self.defaults["piExtensions"][0])

    def test_disabled_module_installs_no_client_wiring(self):
        self.assertFalse(self.disabled_fixture["enable"])
        self.assertFalse(self.disabled_fixture["harnessInPackages"])
        self.assertFalse(self.disabled_fixture["plugin"]["declared"])
        self.assertEqual(self.disabled_fixture["piExtensions"], [])

    def test_personal_host_has_no_local_memory_runtime(self):
        for name in self.personal["packageNames"]:
            for runtime in RUNTIME_PACKAGE_NAMES:
                self.assertNotIn(runtime, name)
        module_source = MODULE.read_text(encoding="utf-8")
        for forbidden in (
            "services.postgresql",
            "systemd.services",
            "launchd.agents",
            "total-recall-iii",
            "total-recall-database",
            "total-recall-queue",
            "total-recall-cron",
        ):
            self.assertNotIn(forbidden, module_source)

    def test_personal_host_needs_no_package_overrides(self):
        personal_source = PERSONAL_HOST.read_text(encoding="utf-8")
        for option in (
            "harnessEvents",
            "opencodePlugin",
            "piExtension",
            "mcpWorker",
        ):
            self.assertNotIn(option, personal_source)


if __name__ == "__main__":
    unittest.main()
