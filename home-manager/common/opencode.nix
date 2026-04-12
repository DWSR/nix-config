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
    default = pkgs.unstable.opencode;
    description = "Base opencode package. Wrapped with mcphub health check automatically.";
  };

  config = {
    programs.opencode = {
      enable = true;
      package = wrappedOpencode;
      rules = ./agents.md;
    };
  };
}
