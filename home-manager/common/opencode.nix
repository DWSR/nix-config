{
  pkgs,
  lib,
  config,
  ...
}:
let
  wrappedOpencode = pkgs.symlinkJoin {
    name = "opencode-wrapped";
    paths = [ config.home.opencode.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/opencode \
        --run '
          if ! /usr/bin/curl -sf --max-time 2 http://localhost:37373/api/health >/dev/null 2>&1; then
            echo "ERROR: MCP hub is not running. Obsidian memory tools are unavailable." >&2
            echo "Start it with: launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub" >&2
            exit 1
          fi
        '
    '';
  };
in
{
  options.home.opencode.package = lib.mkOption {
    type = lib.types.package;
    default = pkgs.opencode-pinned;
    description = "Base opencode package. Wrapped with mcphub health check automatically.";
  };

  config = {
    home.packages = [ pkgs.ocmonitor ];

    programs.opencode = {
      enable = true;
      package = wrappedOpencode;
      rules = ./agents.md;

      agents = {
        nix-pkg = ./agents/nix-pkg.md;
        nvim-tailor = ./agents/nvim-tailor.md;
        security-auditor = ./agents/security-auditor.md;
      };

      settings = {
        # Re-enable thinking output for Claude Opus 4.7 which omits it by default.
        # https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
        provider.anthropic.models."claude-opus-4-7" = {
          variants = {
            low.thinking = {
              type = "adaptive";
              display = "summarized";
            };
            medium.thinking = {
              type = "adaptive";
              display = "summarized";
            };
            high.thinking = {
              type = "adaptive";
              display = "summarized";
            };
            xhigh.thinking = {
              type = "adaptive";
              display = "summarized";
            };
            max.thinking = {
              type = "adaptive";
              display = "summarized";
            };
          };
          options.thinking = {
            type = "adaptive";
            display = "summarized";
          };
        };
      };
    };
  };
}
