# The `software-factory` iii Compose project on the fabro host: the first
# project worker is the pinned `llm-router` binary (overlays/iii-workers.nix),
# configured to route through the loopback LiteLLM proxy. LiteLLM is
# OpenAI-compatible, so the provider is the pinned `provider-openai` worker
# pointed at LiteLLM's Chat Completions endpoint (`/v1/chat/completions`; any
# endpoint not ending in `/responses` selects that wire format). The project
# also runs the pinned `state` worker, which llm-router and provider-openai
# need for their registry, catalog, and registration-token state.
#
# The project is generated as `software-factory/worker-compose.yaml` and
# started with `--engine` pointing at the loopback engine from `iii.service`,
# so Compose connects to the existing engine instead of owning a second one.
# Every worker is a `path://` container executing a Nix-pinned package
# directly, so Compose never resolves the worker registry or downloads an
# artifact at runtime.
#
# llm-router reads its settings from the engine's `llm-router` configuration
# entry, not from a file. The entry's provider slice (the LiteLLM `api_url`)
# is supplied as the container's `config_override`, delivered to the
# configuration worker before the worker starts. The provider credential is
# deliberately absent from the entry: provider-openai falls back to the
# `OPENAI_API_KEY` variable read in llm-router's process, which the unit takes
# from the sops `iii-software-factory-env` template (the LiteLLM master key,
# mapped to the provider's expected variable). No secret enters the store.
#
# Runtime state lives in the systemd state directory
# `/var/lib/iii-software-factory`: Compose's per-project state
# (`III_COMPOSE_STATE_DIR`), the copied `software-factory` project (so Compose
# can write `worker-compose.lock` beside the compose file), and the state
# worker's file-backed `kv` store at `/var/lib/iii-software-factory/state`
# (the default `data/state` path is relative to `III_COMPOSE_DIR`, which is
# re-copied on every start; the absolute path keeps the llm-router registry and
# provider registration tokens across restarts).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.iiiSoftwareFactory;
  stateDir = "iii-software-factory";
  configFormat = pkgs.formats.yaml { };

  # One empty directory per path:// worker: Compose requires the directory to
  # exist and runs the worker from it; `scripts.run` is the pinned executable.
  workerDirectories = [
    "llm-router"
    "provider-openai"
    "state"
  ];

  composeConfig = {
    namespace = "software-factory";
    startup_timeout = "60s";
    stop_timeout = "10s";

    containers = {
      state = {
        worker = "path://./state";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        scripts.run = lib.getExe cfg.statePackage;
        # Persist the kv store under the state directory, not the per-start
        # project copy in III_COMPOSE_DIR.
        config_override = {
          adapter = {
            name = "kv";
            config = {
              store_method = "file_based";
              file_path = "/var/lib/${stateDir}/state";
            };
          };
        };
      };

      llm-router = {
        worker = "path://./llm-router";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        start_after = [ "state" ];
        # The router reads this exact entry id (`III_CONFIG_NAME`); without an
        # explicit name Compose would use `software-factory-llm-router`.
        config_name = "llm-router";
        scripts.run = lib.getExe cfg.llmRouterPackage;
        # Maps merge onto the stored entry. The credential stays out: the
        # router resolves provider-openai's `OPENAI_API_KEY` fallback from its
        # process environment (the sops template on the unit).
        config_override = {
          default_provider = "openai";
          providers.openai.api_url = cfg.litellmApiUrl;
        };
      };

      provider-openai = {
        worker = "path://./provider-openai";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        start_after = [
          "state"
          "llm-router"
        ];
        scripts.run = lib.getExe cfg.providerOpenaiPackage;
      };
    };
  };

  # The project name is the resolved compose-file directory's name, so the
  # generated `software-factory/` directory is what makes this the
  # `software-factory` project.
  project = pkgs.runCommand "iii-software-factory-project" { } ''
    mkdir -p "$out/software-factory"
    ${lib.concatMapStringsSep "\n" (
      name: ''mkdir -p "$out/software-factory/${name}"''
    ) workerDirectories}
    cp ${configFormat.generate "worker-compose.yaml" composeConfig} "$out/software-factory/worker-compose.yaml"
  '';

  # Compose writes `worker-compose.lock` beside the compose file, so the
  # project cannot run from the read-only store path. Each start copies the
  # generated `software-factory/` project into the writable state directory.
  runtimeProject = "/var/lib/${stateDir}/software-factory";
in
{
  options.fabro.iiiSoftwareFactory = {
    llmRouterPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.llm-router;
      description = ''
        Pinned llm-router worker package executed by the generated
        `software-factory` Compose project.
      '';
    };

    providerOpenaiPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.provider-openai;
      description = ''
        Pinned provider-openai worker package that plugs the OpenAI-compatible
        LiteLLM endpoint into llm-router.
      '';
    };

    statePackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.state;
      description = ''
        Pinned state worker package backing llm-router's registry and the
        provider registration tokens.
      '';
    };

    engineUrl = lib.mkOption {
      type = lib.types.str;
      default = "ws://${config.fabro.iii.host}:${toString config.fabro.iii.port}";
      description = ''
        Existing iii engine WebSocket URL the Compose project connects to.
      '';
    };

    litellmApiUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://${config.services.litellm.host}:${toString config.services.litellm.port}/v1/chat/completions";
      description = ''
        Full LiteLLM Chat Completions endpoint llm-router's `openai` provider
        slice points at. provider-openai derives `/v1/models` discovery from
        this URL.
      '';
    };

    projectDirectory = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = project;
      description = ''
        Read-only store path holding the generated `software-factory` project
        and its `worker-compose.yaml`.
      '';
    };

    composeConfig = lib.mkOption {
      type = lib.types.attrs;
      readOnly = true;
      default = composeConfig;
      description = ''
        Read-only `software-factory` Compose project rendered into
        {option}`fabro.iiiSoftwareFactory.projectDirectory`.
      '';
    };
  };

  config = {
    systemd.services.iii-software-factory = {
      description = "iii software-factory project (llm-router routed through LiteLLM)";
      wantedBy = [ "multi-user.target" ];
      after = [
        "iii.service"
        "litellm.service"
      ];
      requires = [ "iii.service" ];
      wants = [ "litellm.service" ];
      # Restart the project when the engine is restarted (a plain Requires
      # stops the project with the engine but does not bring it back).
      partOf = [ "iii.service" ];
      # Compose runs each container's `scripts.run` through `sh -c`; the
      # default unit PATH has no shell, so the pinned binaries die at spawn
      # with ENOENT before they are executed. bashInteractive supplies
      # the bin/sh those scripts need.
      path = [ pkgs.bashInteractive ];
      # A bounded start limit ends a permanently broken project in `failed`
      # instead of retrying forever at RestartSec=2.
      unitConfig.StartLimitIntervalSec = 120;
      unitConfig.StartLimitBurst = 5;
      # Compose keeps the project lock beside the compose file, so copy the
      # generated project into the state directory first. `cp -r` keeps the
      # store's 0555/0444 modes, so restore the write bit on every start:
      # Compose cannot create worker-compose.lock in a read-only directory,
      # and a later start's `rm -rf` cannot unlink the file inside it.
      preStart = ''
        ${lib.getExe' pkgs.coreutils "chmod"} -R u+w ${runtimeProject} 2>/dev/null || true
        ${lib.getExe' pkgs.coreutils "rm"} -rf ${runtimeProject}
        ${lib.getExe' pkgs.coreutils "cp"} -r ${cfg.projectDirectory}/software-factory ${runtimeProject}
        ${lib.getExe' pkgs.coreutils "chmod"} -R u+w ${runtimeProject}
      '';
      serviceConfig = {
        # Compose does not send sd_notify readiness; it starts its workers and
        # supervises them as child processes.
        Type = "simple";
        ExecStart = lib.escapeShellArgs [
          (lib.getExe config.fabro.iii.package)
          "compose"
          "--engine"
          cfg.engineUrl
          "--namespace"
          "software-factory"
          "--up"
          "-f"
          "${runtimeProject}/worker-compose.yaml"
        ];

        DynamicUser = true;
        StateDirectory = [ stateDir ];
        WorkingDirectory = "/var/lib/${stateDir}";

        # OPENAI_API_KEY (the LiteLLM master key) for provider-openai's
        # credential fallback; systemd reads the root-only sops template
        # before dropping to the dynamic user.
        EnvironmentFile = config.sops.templates."iii-software-factory-env".path;

        # Compose reads its state root from III_COMPOSE_STATE_DIR; the state
        # worker's kv store is pinned absolutely in the compose config.
        Environment = [
          "HOME=/var/lib/${stateDir}"
          "III_COMPOSE_STATE_DIR=/var/lib/${stateDir}"
          "III_TELEMETRY_ENABLED=false"
        ];

        Restart = "always";
        RestartSec = 2;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        RestrictAddressFamilies = [
          "AF_UNIX"
          "AF_INET"
          "AF_INET6"
          "AF_NETLINK"
        ];
        ReadWritePaths = [ "/var/lib/${stateDir}" ];
      };
    };
  };
}
