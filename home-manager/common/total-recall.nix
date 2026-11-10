{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.home.totalRecall;
  harnessEventsBin = "${cfg.harnessEvents}/bin/harness-events";
in
{
  options.home.totalRecall = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Whether this host's harnesses capture sessions into the shared
        total-recall memory service on the Fabro guest.
      '';
    };

    endpoint = lib.mkOption {
      type = lib.types.str;
      description = ''
        WebSocket endpoint of the shared total-recall iii service
        (`svc:total-recall` over the tailnet). The OpenCode adapter, the Pi
        extension, and the `mcp-worker` upstream all read this value instead
        of declaring their own endpoint.
      '';
    };

    databaseConnection = lib.mkOption {
      type = lib.types.str;
      default = "memory";
      description = ''
        iii database connection name every total-recall consumer uses. It
        must match the guest workers' connection name so clients and the
        guest read the same memory store.
      '';
    };

    harnessEvents = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-harness-events;
      defaultText = lib.literalExpression "pkgs.total-recall-harness-events";
      description = ''
        The `harness-events` capture CLI installed for the OpenCode and Pi
        harness adapters.
      '';
    };

    opencodePlugin = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-opencode-plugin;
      defaultText = lib.literalExpression "pkgs.total-recall-opencode-plugin";
      description = ''
        The total-recall OpenCode capture plugin installed under
        `~/.config/opencode/plugins/`.
      '';
    };

    piExtension = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-pi-extension;
      defaultText = lib.literalExpression "pkgs.total-recall-pi-extension";
      description = ''
        The total-recall Pi capture extension added to the Pi coding agent.
      '';
    };

    mcpWorker = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-mcp-worker;
      defaultText = lib.literalExpression "pkgs.total-recall-mcp-worker";
      description = ''
        The stdio `mcp-worker` package that exposes total-recall memory
        tools through mcpproxy.
      '';
    };
  };

  # Install the client packages only on hosts that opt in. The Pi option is
  # declared by the Pi module, which every wired host imports alongside this
  # one.
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.harnessEvents ];

    # Both harness adapters and interactive shells read the same capture
    # endpoint and CLI path from the module's option values. The shell
    # export is unconditional and fail-open: an unreachable guest endpoint
    # never blocks a session, it only loses capture.
    home.sessionVariables = {
      III_URL = cfg.endpoint;
      HARNESS_EVENTS_BIN = harnessEventsBin;
    };

    home.opencode.wrapperCommands = [
      ''
        export III_URL="${cfg.endpoint}"
        export HARNESS_EVENTS_BIN="${harnessEventsBin}"
      ''
    ];

    programs.pi.coding-agent.environment = {
      III_URL.value = cfg.endpoint;
      HARNESS_EVENTS_BIN.value = harnessEventsBin;
    };

    # OpenCode auto-loads global plugins from
    # `$XDG_CONFIG_HOME/opencode/plugins/`; ship the pinned upstream adapter
    # file unchanged.
    xdg.configFile."opencode/plugins/total-recall-harness-events.js".source =
      "${cfg.opencodePlugin}/dist/index.js";

    # Pi reads the extension manifest from the package root, which points at
    # `./src/index.ts`; pass the root, not the source file.
    programs.pi.coding-agent.extensions = [ "${cfg.piExtension}" ];
  };
}
