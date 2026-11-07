#!/usr/bin/env python3
"""Evaluated contract tests for the Fabro guest PostgreSQL module."""

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPRESSION = r'''
let
  flake = builtins.getFlake (toString ./.);
  postgres = flake.nixosConfigurations.fabro-vm.config.services.postgresql;
in {
  enable = postgres.enable;
  version = postgres.package.version;
  packagePath = postgres.package.drvPath;
  unstablePackagePath = flake.nixosConfigurations.fabro-vm.pkgs.unstable.postgresql_17.drvPath;
  extensions = map (extension: extension.pname or extension.name)
    (postgres.extensions postgres.package.pkgs);
  allowedTcpPorts = flake.nixosConfigurations.fabro-vm.config.networking.firewall.allowedTCPPorts;
  databases = postgres.ensureDatabases;
  roles = map (role: role.name) postgres.ensureUsers;
  listenAddresses = postgres.settings.listen_addresses;
  sharedPreloadLibraries = postgres.settings.shared_preload_libraries;
  authentication = postgres.authentication;
}
'''


class FabroPostgresqlTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        result = subprocess.run(
            ["nix", "eval", "--impure", "--json", "--expr", EXPRESSION],
            cwd=ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        cls.postgres = json.loads(result.stdout)

    def test_postgresql_17_and_required_extensions_are_enabled(self):
        self.assertTrue(self.postgres["enable"])
        self.assertTrue(self.postgres["version"].startswith("17."))
        self.assertEqual(self.postgres["packagePath"], self.postgres["unstablePackagePath"])
        self.assertEqual(
            set(self.postgres["extensions"]),
            {"pg_textsearch", "pgvector", "pg_uuidv7"},
        )

    def test_memory_database_and_all_runtime_roles_are_declared(self):
        self.assertEqual(self.postgres["databases"], ["memory"])
        self.assertEqual(
            set(self.postgres["roles"]),
            {
                "memory_migration",
                "memory_application",
                "session_post_processing_migrator",
                "session_post_processing_application",
            },
        )

    def test_server_is_loopback_only_and_preloads_textsearch(self):
        self.assertEqual(self.postgres["listenAddresses"], "127.0.0.1")
        self.assertEqual(self.postgres["sharedPreloadLibraries"], "pg_textsearch")
        self.assertNotIn(5432, self.postgres["allowedTcpPorts"])

    def test_authentication_allows_only_peer_and_memory_application_loopback(self):
        lines = [line.split("#", 1)[0].split() for line in self.postgres["authentication"].splitlines()]
        rules = [line for line in lines if line]
        self.assertEqual(
            rules,
            [
                ["local", "all", "postgres", "peer", "map=postgres"],
                ["local", "all", "all", "peer"],
                ["host", "all", "memory_application", "127.0.0.1/32", "trust"],
                ["host", "all", "all", "127.0.0.1/32", "reject"],
            ],
        )


if __name__ == "__main__":
    unittest.main()
