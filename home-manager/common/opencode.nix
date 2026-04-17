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
    programs.opencode = {
      enable = true;
      package = wrappedOpencode;
      rules = ./agents.md;

      agents = {
        nix-pkg = ./agents/nix-pkg.md;
        nvim-tailor = ./agents/nvim-tailor.md;
        security-auditor = ./agents/security-auditor.md;
        vault-curator = ./agents/vault-curator.md;
      };

      settings = {
        # Re-enable thinking output for Claude Opus 4.7, which omits it by default.
        # https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
        #
        # opencode 1.4.7+ auto-generates the low/medium/high/xhigh/max variants
        # with display=summarized for opus-4-7 through the Anthropic Messages API
        # (anomalyco/opencode#22833 + #22873). We only need the base options
        # override here, which applies when no variant is selected.
        provider.anthropic.models."claude-opus-4-7".options.thinking = {
          type = "adaptive";
          display = "summarized";
        };
      };
    };
  };
}
