{ repoRoot }:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  modulePath = repoRoot + "/home-manager/common/pi-agent/default.nix";
  validServer = pkgs.writeTextFile {
    name = "pi-agent-managed-typescript-lsp";
    destination = "/bin/typescript-language-server";
    executable = true;
    text = "#!${pkgs.nodejs}/bin/node\n" + builtins.readFile ./code-intelligence/fake-lsp.cjs;
  };
  failingServer = pkgs.writeTextFile {
    name = "pi-agent-managed-python-lsp";
    destination = "/bin/pyright-langserver";
    executable = true;
    text = "#!${pkgs.nodejs}/bin/node\n" + builtins.readFile ./code-intelligence/failing-lsp.cjs;
  };
  crashingServer = pkgs.writeTextFile {
    name = "pi-agent-managed-crashing-python-lsp";
    destination = "/bin/pyright-langserver";
    executable = true;
    text = "#!${pkgs.nodejs}/bin/node\n" + builtins.readFile ./code-intelligence/crashing-lsp.cjs;
  };
  evaluate =
    languageServers:
    pkgs.lib.evalModules {
      modules = [
        modulePath
        {
          programs.pi-agent = {
            enable = true;
            package = pkgs.pi-agent;
            extensions.codeIntelligence = {
              package = pkgs.pi-agent-extensions;
              relativePath = "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts";
            };
            manifests = [
              {
                package = pkgs.pi-agent-extensions;
                relativePath = "share/pi-agent/extensions.json";
              }
            ];
            inherit languageServers;
            provider = {
              mode = "personal";
              defaultModel = {
                provider = "openai";
                modelId = "gpt-5.6-sol";
              };
            };
          };
        }
      ];
      specialArgs = {
        inherit pkgs;
        piAgentAdvisoryDate = "2026-08-12";
      };
    };
  healthy = evaluate {
    typescript = {
      package = validServer;
      relativePath = "bin/typescript-language-server";
    };
  };
  degraded = evaluate {
    typescript = {
      package = validServer;
      relativePath = "bin/typescript-language-server";
    };
    python = {
      package = failingServer;
      relativePath = "bin/pyright-langserver";
    };
  };
  crashing = evaluate {
    typescript = {
      package = validServer;
      relativePath = "bin/typescript-language-server";
    };
    python = {
      package = crashingServer;
      relativePath = "bin/pyright-langserver";
    };
  };
in
{
  inherit crashingServer failingServer validServer;
  crashingManagedConfig = crashing.config.programs.pi-agent.internal.managedConfig;
  healthyManagedConfig = healthy.config.programs.pi-agent.internal.managedConfig;
  degradedManagedConfig = degraded.config.programs.pi-agent.internal.managedConfig;
}
