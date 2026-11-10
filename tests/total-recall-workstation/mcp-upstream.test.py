#!/usr/bin/env python3
"""Evaluated contract tests for the workstation total-recall MCP upstream.

Task 8.4 adds `home.mcp.extraServers.total-recall` as a stdio upstream that
spawns the pinned `mcp-worker` and derives its endpoint and connection name
from the module's single `endpoint` and `databaseConnection` option values.
"""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MODULE = ROOT / "home-manager" / "common" / "total-recall.nix"
SERVER_NAME = "total-recall"

EXPRESSION = f'''
let
  flake = builtins.getFlake (toString ./.);
  pathOf = value: builtins.unsafeDiscardStringContext (toString value);

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

  renderedConfigOf =
    hm:
    builtins.fromJSON (
      builtins.unsafeDiscardStringContext hm.xdg.configFile."mcpproxy/mcp_config.json".text
    );

  findServer = servers: name:
    let
      matches = builtins.filter (server: server.name == name) servers;
    in
    if matches == [] then null else builtins.head matches;

  serverNamesOf = hm: map (server: server.name) (renderedConfigOf hm).mcpServers;

  sourceEntryOf = hm: hm.home.mcp.extraServers.total-recall or null;

  describe = hm: {{
    endpoint = hm.home.totalRecall.endpoint;
    databaseConnection = hm.home.totalRecall.databaseConnection;
    mcpWorker = pathOf hm.home.totalRecall.mcpWorker;
    source = sourceEntryOf hm;
    rendered = findServer (renderedConfigOf hm).mcpServers "{SERVER_NAME}";
    serverNames = serverNamesOf hm;
    listen = (renderedConfigOf hm).listen;
  }};
in {{
  personal = describe personal;
  personalDisabled = describe personalDisabled;
  personalDisabledHasSource =
    personalDisabled.home.mcp.extraServers ? total-recall;
}}
'''


class TotalRecallMcpUpstreamTests(unittest.TestCase):
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
                f"Nix workstation MCP evaluation failed:\n{result.stderr}"
            )
        cls.evaluated = json.loads(result.stdout)
        cls.personal = cls.evaluated["personal"]
        cls.personal_disabled = cls.evaluated["personalDisabled"]

    def test_personal_host_declares_one_stdio_total_recall_upstream(self):
        source = self.personal["source"]
        self.assertIsNotNone(source, "home.mcp.extraServers.total-recall is missing")
        self.assertEqual(sorted(source), ["command", "env"])
        self.assertEqual(
            source["command"],
            self.personal["mcpWorker"] + "/bin/mcp-worker",
        )

    def test_upstream_derives_endpoint_and_connection_from_shared_options(self):
        env = self.personal["source"]["env"]
        self.assertEqual(
            sorted(env), ["III_URL", "TOTAL_RECALL_MEMORY_DATABASE"]
        )
        self.assertEqual(env["III_URL"], self.personal["endpoint"])
        self.assertEqual(env["III_URL"], "wss://total-recall.tuxedo-musical.ts.net")
        self.assertEqual(
            env["TOTAL_RECALL_MEMORY_DATABASE"],
            self.personal["databaseConnection"],
        )
        self.assertEqual(env["TOTAL_RECALL_MEMORY_DATABASE"], "memory")

    def test_rendered_proxy_config_contains_the_stdio_upstream(self):
        rendered = self.personal["rendered"]
        self.assertIsNotNone(
            rendered,
            "mcpproxy/mcp_config.json has no total-recall server",
        )
        self.assertEqual(rendered["name"], SERVER_NAME)
        self.assertEqual(rendered["protocol"], "stdio")
        self.assertTrue(rendered["enabled"])
        self.assertFalse(rendered["quarantined"])
        self.assertEqual(
            rendered["command"],
            self.personal["mcpWorker"] + "/bin/mcp-worker",
        )
        self.assertNotIn("url", rendered)
        self.assertEqual(rendered["args"], [])

    def test_rendered_proxy_config_carries_the_shared_values(self):
        env = self.personal["rendered"]["env"]
        self.assertEqual(env["III_URL"], self.personal["endpoint"])
        self.assertEqual(env["TOTAL_RECALL_MEMORY_DATABASE"], "memory")

    def test_mcpproxy_remains_the_only_loopback_listener(self):
        self.assertTrue(self.personal["listen"].startswith("127.0.0.1:"))
        self.assertEqual(
            self.personal["serverNames"].count(SERVER_NAME), 1
        )

    def test_existing_upstreams_remain_configured(self):
        for name in ("github", "time", "instances-mcp", "git-mcp"):
            self.assertIn(name, self.personal["serverNames"], name)

    def test_disabled_module_declares_no_total_recall_upstream(self):
        self.assertFalse(self.evaluated["personalDisabledHasSource"])
        self.assertIsNone(self.personal_disabled["source"])
        self.assertIsNone(self.personal_disabled["rendered"])
        self.assertNotIn(SERVER_NAME, self.personal_disabled["serverNames"])

    def test_module_adds_no_service_or_http_transport(self):
        module_source = MODULE.read_text(encoding="utf-8")
        for forbidden in (
            "services.postgresql",
            "systemd.services",
            "launchd.agents",
            'type = "http"',
            'type = "streamable-http"',
        ):
            self.assertNotIn(forbidden, module_source)


if __name__ == "__main__":
    unittest.main()
