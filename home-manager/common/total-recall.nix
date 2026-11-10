{
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;
in
{
  options.home.totalRecall = {
    enable = mkEnableOption "total-recall workstation capture and MCP clients";

    endpoint = mkOption {
      type = types.str;
      description = ''
        Tailnet WebSocket endpoint of the Fabro guest's `svc:total-recall`
        iii worker manager. Every workstation adapter and the stdio MCP
        worker derive their `III_URL` from this single value.
      '';
    };

    databaseConnection = mkOption {
      type = types.str;
      default = "memory";
      description = ''
        iii database connection name used by the guest's memory workers.
        The stdio MCP worker points at the same connection name so retrieval
        reads the guest's store.
      '';
    };

    harnessEvents = mkOption {
      type = types.package;
      default = pkgs.total-recall-harness-events;
      defaultText = lib.literalExpression "pkgs.total-recall-harness-events";
      description = ''
        Harness event capture CLI. Both harness adapters use its
        `harness-events` executable through `HARNESS_EVENTS_BIN`.
      '';
    };

    opencodePlugin = mkOption {
      type = types.package;
      default = pkgs.total-recall-opencode-plugin;
      defaultText = lib.literalExpression "pkgs.total-recall-opencode-plugin";
      description = "OpenCode capture plugin installed into the OpenCode config tree.";
    };

    piExtension = mkOption {
      type = types.package;
      default = pkgs.total-recall-pi-extension;
      defaultText = lib.literalExpression "pkgs.total-recall-pi-extension";
      description = "Pi capture extension package root added to the Pi extension list.";
    };

    mcpWorker = mkOption {
      type = types.package;
      default = pkgs.total-recall-mcp-worker;
      defaultText = lib.literalExpression "pkgs.total-recall-mcp-worker";
      description = "total-recall stdio MCP worker spawned by the MCP proxy.";
    };
  };
}
