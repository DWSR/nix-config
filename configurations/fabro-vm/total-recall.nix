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
  # Structured values rendered into the iii engine configuration and the
  # configuration worker's per-worker YAML files. They are also exposed as
  # read-only internal options so the pure-evaluation guest check can assert
  # loopback bindings without reading (or building) the YAML derivations.
  engineConfiguration = {
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
  iiiConfig = yamlFormat.generate "total-recall-iii-config.yaml" engineConfiguration;
  configurationEntry = id: description: value: {
    inherit id description value;
    name = id;
  };
  workerConfiguration = {
    database = configurationEntry "database" "PostgreSQL memory connection" {
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
    };
    queue = configurationEntry "queue" "Durable harness event queue" {
      adapter = {
        name = "builtin";
        config = {
          store_method = "file_based";
          file_path = "/var/lib/total-recall/queue";
        };
      };
    };
    cron = configurationEntry "cron" "Local scheduled worker triggers" {
      adapter.name = "local";
    };
  };
  workerConfigs = {
    database = yamlFormat.generate "database.yaml" workerConfiguration.database;
    queue = yamlFormat.generate "queue.yaml" workerConfiguration.queue;
    cron = yamlFormat.generate "cron.yaml" workerConfiguration.cron;
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

  # Loopback bindings and single-tailnet-exposure contract (spec
  # install-total-recall-on-fabro-vm, task 9.2; requirements 6.4, 9.2, 9.5;
  # design "C4: Tailscale Serve exposure" and "Testing Strategy →
  # Pure-evaluation checks"). NixOS evaluates these assertions when
  # `nix flake check` instantiates nixosConfigurations.fabro-vm, so a widened
  # bind, an added or reordered Serve entry, or a changed existing
  # advertisement fails evaluation with a message naming the port or service.
  # The values are the same structured seams the guest renders into its iii
  # engine and configuration-worker YAML files, so no YAML derivation is
  # built and no second NixOS configuration is instantiated.
  memoryPorts = [
    config.services.postgresql.settings.port
    cfg.iiiPort
    cfg.streamPort
  ];
  memoryPortList = lib.concatStringsSep ", " (map toString memoryPorts);

  # Recursively collect `(path, value)` for every attribute named `name` in a
  # structured configuration value (lists included).
  collectAttr =
    name: prefix: value:
    if builtins.isAttrs value then
      builtins.concatMap (
        childName:
        let
          child = value.${childName};
          path = if prefix == "" then childName else "${prefix}.${childName}";
        in
        (
          if childName == name then
            [
              {
                inherit path;
                value = child;
              }
            ]
          else
            [ ]
        )
        ++ collectAttr name path child
      ) (builtins.attrNames value)
    else if builtins.isList value then
      builtins.concatMap (collectAttr name prefix) value
    else
      [ ];

  # Recursively collect every string `(prefix, value)` pair.
  collectStrings =
    prefix: value:
    if builtins.isString value then
      [ { inherit prefix value; } ]
    else if builtins.isAttrs value then
      builtins.concatMap (
        childName:
        collectStrings (if prefix == "" then childName else "${prefix}.${childName}") value.${childName}
      ) (builtins.attrNames value)
    else if builtins.isList value then
      builtins.concatMap (collectStrings prefix) value
    else
      [ ];

  engineWorker =
    name:
    let
      matches = builtins.filter (worker: (worker.name or "") == name) (
        engineConfiguration.workers or [ ]
      );
    in
    if matches == [ ] then null else builtins.head matches;
  engineBindings = [
    {
      name = "iii-worker-manager";
      host = "127.0.0.1";
      port = cfg.iiiPort;
    }
    {
      name = "iii-stream";
      host = "127.0.0.1";
      port = cfg.streamPort;
    }
  ];
  engineBindingProblems = builtins.concatMap (
    binding:
    let
      worker = engineWorker binding.name;
      expected = "${binding.host}:${toString binding.port}";
      actualHost = if worker == null then null else worker.config.host or null;
      actualPort = if worker == null then null else worker.config.port or null;
    in
    if worker == null then
      [ "${binding.name} is missing (expected ${expected})" ]
    else
      lib.optional (actualHost != binding.host)
        "${binding.name} binds host ${builtins.toJSON actualHost} instead of ${binding.host} (expected ${expected})"
      ++
        lib.optional (actualPort != binding.port)
          "${binding.name} binds port ${builtins.toJSON actualPort} instead of ${toString binding.port} (expected ${expected})"
  ) engineBindings;
  engineOtherHosts = builtins.filter (entry: entry.value != "127.0.0.1") (
    collectAttr "host" "" engineConfiguration
  );

  expectedWorkerConfigFiles = [
    "database"
    "queue"
    "cron"
  ];
  workerConfigFiles = builtins.attrNames workerConfiguration;
  missingWorkerConfigFiles = builtins.filter (
    file: !(builtins.hasAttr file workerConfiguration)
  ) expectedWorkerConfigFiles;
  workerConfigOtherHosts = builtins.concatMap (
    file:
    map (entry: "${file}.yaml ${entry.path}=${builtins.toJSON entry.value}") (
      builtins.filter (entry: entry.value != "127.0.0.1") (
        collectAttr "host" "" workerConfiguration.${file}
      )
    )
  ) workerConfigFiles;
  workerConfigUrls = builtins.concatMap (
    file:
    map (entry: "${file}.yaml ${entry.prefix}=${entry.value}") (
      builtins.filter (entry: lib.hasInfix "://" entry.value) (
        collectStrings "" workerConfiguration.${file}
      )
    )
  ) workerConfigFiles;
  databaseConnection = workerConfiguration.database.value.databases.${cfg.databaseConnection} or null;
  databaseConnectionHost =
    if databaseConnection == null then null else databaseConnection.host or null;

  serveEntry =
    service: target:
    "${lib.getExe config.services.tailscale.package} serve --service=${service} --https=443 ${target}";
  expectedExistingServeEntries = [
    (serveEntry "svc:fabro" "http://127.0.0.1:32276")
    (serveEntry "svc:litellm" "http://127.0.0.1:4000")
    (serveEntry "svc:opencode" "http://127.0.0.1:4096")
  ];
  expectedEnabledServeEntries = expectedExistingServeEntries ++ [
    (serveEntry "svc:total-recall" "http://127.0.0.1:49134")
  ];
  # Disabled form after the production builder, so dropping its
  # `lib.optionals` gate (or adding a fourth existing entry) fails here.
  expectedDisabledServeEntries = import ./total-recall-serve.nix {
    inherit lib;
    inherit (cfg) iiiPort;
    tailscalePackage = config.services.tailscale.package;
    totalRecallEnable = false;
  };
  actualServeEntries = config.systemd.services.tailscale-serve.serviceConfig.ExecStart or [ ];
  serveMismatch =
    expected: actual:
    let
      expectedLength = builtins.length expected;
      actualLength = builtins.length actual;
      commonLength = lib.min expectedLength actualLength;
      mismatched = builtins.filter (
        index: builtins.elemAt actual index != builtins.elemAt expected index
      ) (lib.range 0 (commonLength - 1));
    in
    if mismatched != [ ] then
      let
        index = builtins.head mismatched;
      in
      "entry #${toString (index + 1)} is ${builtins.toJSON (builtins.elemAt actual index)} (expected ${builtins.toJSON (builtins.elemAt expected index)})"
    else if actualLength != expectedLength then
      "expected ${toString expectedLength} entries but ${toString actualLength} are declared: ${builtins.toJSON (lib.drop expectedLength actual)}"
    else
      null;

  firewall = config.networking.firewall;
  portInRange = ranges: port: builtins.any (range: port >= range.from && port <= range.to) ranges;
  firewallAllowsPort =
    port:
    builtins.elem port firewall.allowedTCPPorts
    || builtins.elem port firewall.allowedUDPPorts
    || portInRange firewall.allowedTCPPortRanges port
    || portInRange firewall.allowedUDPPortRanges port
    || builtins.any (
      interface:
      builtins.elem port interface.allowedTCPPorts
      || builtins.elem port interface.allowedUDPPorts
      || portInRange interface.allowedTCPPortRanges port
      || portInRange interface.allowedUDPPortRanges port
    ) (builtins.attrValues firewall.interfaces);
  firewallOpenPorts = builtins.filter firewallAllowsPort memoryPorts;
  firewallExtraCommands = lib.concatStringsSep "\n" [
    firewall.extraCommands
    firewall.extraStopCommands
    firewall.extraInputRules
    firewall.extraForwardRules
  ];
  firewallExtraMentions = builtins.filter (
    port: lib.hasInfix ":${toString port}" firewallExtraCommands
  ) memoryPorts;

  socketListenValues =
    name:
    let
      socket = config.systemd.sockets.${name};
      socketConfig = socket.socketConfig or { };
      asList = value: if builtins.isList value then value else [ value ];
    in
    (socket.listenStreams or [ ])
    ++ (socket.listenDatagrams or [ ])
    ++ asList (socketConfig.ListenStream or [ ])
    ++ asList (socketConfig.ListenDatagram or [ ]);
  socketListeners = builtins.concatMap (
    name:
    map (value: "${name} listens on ${builtins.toJSON value}") (
      builtins.filter (
        value:
        builtins.any (
          port:
          let
            text = toString value;
          in
          text == toString port || lib.hasInfix ":${toString port}" text
        ) memoryPorts
      ) (socketListenValues name)
    )
  ) (builtins.attrNames config.systemd.sockets);
  wildcardBindMarkers = port: [
    "0.0.0.0:${toString port}"
    "[::]:${toString port}"
    ":::${toString port}"
    "*:${toString port}"
  ];
  widenedBindUnits = builtins.concatMap (
    port:
    map (name: "${name} binds port ${toString port} on a wildcard address") (
      builtins.filter (
        name:
        builtins.any (marker: lib.hasInfix marker config.systemd.units.${name}.text) (
          wildcardBindMarkers port
        )
      ) (builtins.attrNames config.systemd.units)
    )
  ) memoryPorts;
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

    engineConfiguration = lib.mkOption {
      type = lib.types.anything;
      internal = true;
      readOnly = true;
      description = ''
        Structured value rendered into the iii engine configuration. Exposed
        for the pure-evaluation guest check (loopback bindings); not a
        user-facing option.
      '';
    };

    workerConfiguration = lib.mkOption {
      type = lib.types.anything;
      internal = true;
      readOnly = true;
      description = ''
        Structured values rendered into the configuration worker's
        per-worker YAML files. Exposed for the pure-evaluation guest check
        (loopback-only database host); not a user-facing option.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    fabro.totalRecall.engineConfiguration = engineConfiguration;
    fabro.totalRecall.workerConfiguration = workerConfiguration;

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

    systemd.services.total-recall-session-post-processing = {
      description = "Interpret completed total-recall sessions";
      wantedBy = [ "multi-user.target" ];
      after = harnessWorkerAfter;
      requires = harnessWorkerAfter;
      environment = {
        III_URL = "ws://${cfg.iiiHost}:${toString cfg.iiiPort}";
        TOTAL_RECALL_POST_PROCESSING_DATABASE = cfg.databaseConnection;
        TOTAL_RECALL_POST_PROCESSING_MEMORY_DATABASE = cfg.databaseConnection;
        TOTAL_RECALL_POST_PROCESSING_PROVIDER = "openai";
        TOTAL_RECALL_POST_PROCESSING_OPENAI_BASE_URL = cfg.postProcessingBaseUrl;
        TOTAL_RECALL_POST_PROCESSING_OPENAI_MODEL = cfg.postProcessingModel;
        TOTAL_RECALL_POST_PROCESSING_OPENAI_OUTPUT_MODE = "prompt";
      };
      serviceConfig = {
        User = "total-recall";
        Group = "total-recall";
        StateDirectory = "total-recall";
        ExecStart = lib.getExe pkgs.total-recall-session-post-processing;
        EnvironmentFile = config.sops.templates."total-recall-env".path;
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

    # Task 9.2 assertions, evaluated by `nix flake check` through
    # nixosConfigurations.fabro-vm.config.system.build.toplevel. Each message
    # names the port, service, or file at fault (requirement 9.11).
    assertions = [
      {
        assertion =
          config.services.postgresql.enable
          && config.services.postgresql.settings.listen_addresses == "127.0.0.1";
        message = "fabro-vm: services.postgresql.settings.listen_addresses must be exactly \"127.0.0.1\" so PostgreSQL (port ${toString config.services.postgresql.settings.port}) stays loopback-only; got ${builtins.toJSON config.services.postgresql.settings.listen_addresses}.";
      }
      {
        assertion = engineBindingProblems == [ ];
        message = "fabro-vm: the iii engine must bind its listeners to loopback: ${lib.concatStringsSep "; " engineBindingProblems}.";
      }
      {
        assertion = engineOtherHosts == [ ];
        message = "fabro-vm: the iii engine configuration names non-loopback hosts [ ${
          lib.concatStringsSep ", " (
            map (entry: "${entry.path}=${builtins.toJSON entry.value}") engineOtherHosts
          )
        } ]; worker-manager and stream must stay on 127.0.0.1.";
      }
      {
        assertion = missingWorkerConfigFiles == [ ];
        message = "fabro-vm: the configuration worker must seed [ ${
          lib.concatStringsSep ", " (map (file: "${file}.yaml") expectedWorkerConfigFiles)
        } ]; missing [ ${
          lib.concatStringsSep ", " (map (file: "${file}.yaml") missingWorkerConfigFiles)
        } ].";
      }
      {
        assertion = workerConfigOtherHosts == [ ];
        message = "fabro-vm: configuration-worker files must name only 127.0.0.1; found [ ${lib.concatStringsSep ", " workerConfigOtherHosts} ] across database/queue/cron.";
      }
      {
        assertion = workerConfigUrls == [ ];
        message = "fabro-vm: configuration-worker files must use the structured host/port entry, not a connection URL naming another host; found [ ${lib.concatStringsSep ", " workerConfigUrls} ].";
      }
      {
        assertion = databaseConnectionHost == "127.0.0.1";
        message = "fabro-vm: database.yaml must give connection \"${cfg.databaseConnection}\" host 127.0.0.1 so PostgreSQL stays loopback-only; got ${builtins.toJSON databaseConnectionHost}.";
      }
      {
        assertion = serveMismatch expectedEnabledServeEntries actualServeEntries == null;
        message = "fabro-vm: tailscale-serve must publish exactly four entries in order (svc:fabro→127.0.0.1:32276, svc:litellm→127.0.0.1:4000, svc:opencode→127.0.0.1:4096, then svc:total-recall→127.0.0.1:49134): ${serveMismatch expectedEnabledServeEntries actualServeEntries}.";
      }
      {
        assertion = serveMismatch expectedExistingServeEntries expectedDisabledServeEntries == null;
        message = "fabro-vm: with fabro.totalRecall.enable = false tailscale-serve must publish exactly the original three entries (svc:fabro→127.0.0.1:32276, svc:litellm→127.0.0.1:4000, svc:opencode→127.0.0.1:4096) and no svc:total-recall: ${serveMismatch expectedExistingServeEntries expectedDisabledServeEntries}.";
      }
      {
        assertion = firewall.enable && firewallOpenPorts == [ ] && firewallExtraMentions == [ ];
        message = "fabro-vm: the guest firewall must stay enabled and open no memory port (${memoryPortList}); firewall.enable=${builtins.toJSON firewall.enable}, allowed ports=[ ${lib.concatStringsSep ", " (map toString firewallOpenPorts)} ], extra-rule mentions=[ ${lib.concatStringsSep ", " (map toString firewallExtraMentions)} ].";
      }
      {
        assertion = socketListeners == [ ];
        message = "fabro-vm: no systemd socket unit may listen on a memory port (${memoryPortList}); found [ ${lib.concatStringsSep ", " socketListeners} ].";
      }
      {
        assertion = widenedBindUnits == [ ];
        message = "fabro-vm: no unit may bind a memory port (${memoryPortList}) on a wildcard address; found [ ${lib.concatStringsSep ", " widenedBindUnits} ].";
      }
    ];
  };
}
