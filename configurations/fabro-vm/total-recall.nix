{
  config,
  lib,
  pkgs,
  totalRecall,
  utils,
  ...
}:
let
  cfg = config.fabro.totalRecall;
  yamlFormat = pkgs.formats.yaml { };
  iiiConfig = yamlFormat.generate "total-recall-iii-config.yaml" {
    workers = [
      {
        name = "iii-worker-manager";
        config = {
          host = cfg.iiiHost;
          port = cfg.iiiPort;
        };
      }
      {
        name = "iii-stream";
        config = {
          host = cfg.streamHost;
          port = cfg.streamPort;
          adapter = {
            name = "kv";
            config = {
              store_method = "file_based";
              file_path = "/var/lib/total-recall/stream";
            };
          };
        };
      }
      {
        name = "configuration";
        config.adapter = {
          name = "fs";
          config.directory = "/var/lib/total-recall/config";
        };
      }
    ];
  };
  configurationEntry = id: description: value: {
    inherit id description value;
    name = id;
  };
  workerConfigs = {
    database = yamlFormat.generate "database.yaml" (
      configurationEntry "database" "PostgreSQL memory connection" {
        databases.${cfg.databaseConnection} = {
          driver = "postgres";
          host = "127.0.0.1";
          port = 5432;
          user = "memory_application";
          database = cfg.databaseName;
          tls.mode = "disable";
          pool.max = 10;
        };
        history_max_entries = 0;
      }
    );
    queue = yamlFormat.generate "queue.yaml" (
      configurationEntry "queue" "Durable harness event queue" {
        adapter = {
          name = "builtin";
          config = {
            store_method = "file_based";
            file_path = "/var/lib/total-recall/queue";
          };
        };
      }
    );
    cron = yamlFormat.generate "cron.yaml" (
      configurationEntry "cron" "Local scheduled worker triggers" {
        adapter.name = "local";
      }
    );
  };
  installWorkerConfig = name: path: ''
    install -D -m 0644 ${lib.escapeShellArg (toString path)} \
      "/var/lib/total-recall/config/${name}.yaml"
  '';
  installConfig = pkgs.writeShellScript "total-recall-install-config" ''
    set -eu
    install -D -m 0644 ${lib.escapeShellArg (toString iiiConfig)} \
      /var/lib/total-recall/iii/config.yaml
    ${installWorkerConfig "database" workerConfigs.database}
    ${installWorkerConfig "queue" workerConfigs.queue}
    ${installWorkerConfig "cron" workerConfigs.cron}
  '';
  iiiHealthGate = pkgs.writeShellApplication {
    name = "iii-health-gate";
    runtimeInputs = [
      pkgs.bash
      pkgs.coreutils
    ];
    text = ''
      attempts=20
      for (( attempt = 1; attempt <= attempts; attempt++ )); do
        if timeout 1 bash -c ${lib.escapeShellArg "exec 3<>/dev/tcp/${cfg.iiiHost}/${toString cfg.iiiPort}"} 2>/dev/null; then
          exit 0
        fi
        echo "iii-health-gate: probe $attempt/$attempts failed, retrying" >&2
        sleep 2
      done
      echo "iii-health-gate: ${cfg.iiiHost}:${toString cfg.iiiPort} did not accept connections" >&2
      exit 1
    '';
  };
  harnessWorkerAfter = [
    "iii.service"
    "total-recall-migrate.service"
    "iii-database.service"
    "iii-queue.service"
    "iii-cron.service"
  ];
  harnessWorkerEnvironment = {
    III_URL = "ws://${cfg.iiiHost}:${toString cfg.iiiPort}";
    TOTAL_RECALL_QUEUE_TOPIC = cfg.queueTopic;
  };
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

    systemd.services.total-recall-config = {
      description = "Install iii engine and worker configuration";
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = [
          "total-recall"
          "total-recall/iii"
          "total-recall/config"
          "total-recall/queue"
          "total-recall/stream"
        ];
        ExecStart = installConfig;
      };
    };

    systemd.services.iii = {
      description = "iii worker engine";
      wantedBy = [ "multi-user.target" ];
      after = [ "total-recall-config.service" ];
      requires = [ "total-recall-config.service" ];
      serviceConfig = {
        WorkingDirectory = "/var/lib/total-recall/iii";
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = [
          "total-recall"
          "total-recall/iii"
          "total-recall/config"
          "total-recall/queue"
          "total-recall/stream"
        ];
        ExecStart = utils.escapeSystemdExecArgs [
          (lib.getExe pkgs.total-recall-iii)
          "--config"
          "/var/lib/total-recall/iii/config.yaml"
        ];
        ExecStartPost = lib.getExe iiiHealthGate;
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.iii-database = {
      description = "iii PostgreSQL database worker";
      wantedBy = [ "multi-user.target" ];
      after = [
        "iii.service"
        "total-recall-migrate.service"
      ];
      requires = [
        "iii.service"
        "total-recall-migrate.service"
      ];
      environment = {
        III_URL = "ws://${cfg.iiiHost}:${toString cfg.iiiPort}";
      };
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-database;
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.iii-queue = {
      description = "iii durable queue worker";
      wantedBy = [ "multi-user.target" ];
      after = [ "iii.service" ];
      requires = [ "iii.service" ];
      environment = {
        III_URL = "ws://${cfg.iiiHost}:${toString cfg.iiiPort}";
      };
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-queue;
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.iii-cron = {
      description = "iii scheduled task worker";
      wantedBy = [ "multi-user.target" ];
      after = [ "iii.service" ];
      requires = [ "iii.service" ];
      environment = {
        III_URL = "ws://${cfg.iiiHost}:${toString cfg.iiiPort}";
      };
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-cron;
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.total-recall-migrate = {
      description = "Apply the total-recall database migrations";
      wantedBy = [ "multi-user.target" ];
      after = [ "postgresql.service" ];
      requires = [ "postgresql.service" ];
      serviceConfig = {
        Type = "oneshot";
        User = "postgres";
        ExecStart = utils.escapeSystemdExecArgs [
          (lib.getExe (
            pkgs.callPackage ./total-recall/migrate.nix {
              totalRecall = totalRecall.packages.${pkgs.stdenv.hostPlatform.system};
            }
          ))
          cfg.databaseName
        ];
        Restart = "on-failure";
      };
    };

    systemd.services.total-recall-harness-ingestion = {
      description = "Validate and enqueue total-recall harness events";
      wantedBy = [ "multi-user.target" ];
      after = harnessWorkerAfter;
      requires = harnessWorkerAfter;
      environment = harnessWorkerEnvironment;
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-harness-ingestion;
        Restart = "always";
        RestartSec = 2;
      };
    };

    systemd.services.total-recall-harness-event-persistence = {
      description = "Persist queued total-recall harness events";
      wantedBy = [ "multi-user.target" ];
      after = harnessWorkerAfter;
      requires = harnessWorkerAfter;
      environment = harnessWorkerEnvironment // {
        TOTAL_RECALL_DATABASE = cfg.databaseConnection;
      };
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-harness-event-persistence;
        Restart = "always";
        RestartSec = 2;
      };
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
