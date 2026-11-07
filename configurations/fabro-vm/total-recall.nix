{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.totalRecall;
in
{
  options.fabro.totalRecall = {
    enable = lib.mkEnableOption "the total-recall guest service account";

    iiiHost = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address used by the guest's iii worker-manager listener.";
    };

    iiiPort = lib.mkOption {
      type = lib.types.port;
      default = 49134;
      description = "Port used by the guest's iii worker-manager listener.";
    };

    streamHost = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = "Address used by the guest's iii stream listener.";
    };

    streamPort = lib.mkOption {
      type = lib.types.port;
      default = 3112;
      description = "Port used by the guest's iii stream listener.";
    };

    databaseName = lib.mkOption {
      type = lib.types.str;
      default = "memory";
      description = "PostgreSQL database used by total-recall.";
    };

    databaseConnection = lib.mkOption {
      type = lib.types.str;
      default = "memory";
      description = "iii database connection name used by total-recall workers.";
    };

    queueTopic = lib.mkOption {
      type = lib.types.str;
      default = "harness-events";
      description = "Durable queue topic shared by total-recall event workers.";
    };

    postProcessingModel = lib.mkOption {
      type = lib.types.str;
      default = "opencode-go/deepseek-v4.1-flash";
      description = "Model used by the total-recall post-processing worker.";
    };

    postProcessingBaseUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://127.0.0.1:4000/v1/";
      description = "OpenAI-compatible base URL for post-processing requests.";
    };
  };

  config = lib.mkIf cfg.enable {
    users.groups."total-recall" = { };
    users.users."total-recall" = {
      isSystemUser = true;
      group = "total-recall";
    };

    services.postgresql = {
      enable = true;
      package = pkgs.unstable.postgresql_17;
      extensions = ps: [
        ps.pg_textsearch
        ps.pgvector
        ps.pg_uuidv7
      ];
      ensureDatabases = [ "memory" ];
      ensureUsers = map (name: { inherit name; }) [
        "memory_migration"
        "memory_application"
        "session_post_processing_migrator"
        "session_post_processing_application"
      ];
      settings = {
        listen_addresses = lib.mkForce "127.0.0.1";
        shared_preload_libraries = "pg_textsearch";
      };
      authentication = lib.mkForce ''
        local all postgres peer map=postgres
        local all all peer
        host all memory_application 127.0.0.1/32 trust
        host all all 127.0.0.1/32 reject
      '';
    };

  };
}
