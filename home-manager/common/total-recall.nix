{
  lib,
  pkgs,
  ...
}:
{
  options.home.totalRecall = {
    enable = lib.mkEnableOption "Total Recall workstation clients";

    endpoint = lib.mkOption {
      type = lib.types.str;
      description = "WebSocket endpoint shared by the Total Recall clients.";
    };

    databaseConnection = lib.mkOption {
      type = lib.types.str;
      default = "memory";
      description = "Database connection name shared by the Total Recall clients.";
    };

    harnessEvents = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-harness-events;
      description = "Pinned harness-events CLI package.";
    };

    opencodePlugin = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-opencode-plugin;
      description = "Pinned OpenCode capture plugin package.";
    };

    piExtension = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-pi-extension;
      description = "Pinned Pi capture extension package.";
    };

    mcpWorker = lib.mkOption {
      type = lib.types.package;
      default = pkgs.total-recall-mcp-worker;
      description = "Pinned stdio MCP worker package.";
    };
  };

}
