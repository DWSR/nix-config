{
  lib,
  ...
}:
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
      description = ''
        The `harness-events` capture CLI installed for the OpenCode and Pi
        harness adapters.
      '';
    };

    opencodePlugin = lib.mkOption {
      type = lib.types.package;
      description = ''
        The total-recall OpenCode capture plugin installed under
        `~/.config/opencode/plugins/`.
      '';
    };

    piExtension = lib.mkOption {
      type = lib.types.package;
      description = ''
        The total-recall Pi capture extension added to the Pi coding agent.
      '';
    };

    mcpWorker = lib.mkOption {
      type = lib.types.package;
      description = ''
        The stdio `mcp-worker` package that exposes total-recall memory
        tools through mcpproxy.
      '';
    };
  };
}
