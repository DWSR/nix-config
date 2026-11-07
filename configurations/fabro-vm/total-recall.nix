{ config, lib, ... }:
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
  };
}
