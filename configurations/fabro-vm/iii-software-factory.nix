# The `software-factory` iii Compose project on the fabro host: the first
# project worker is the pinned `llm-router` binary (overlays/iii-workers.nix),
# configured to route through the loopback LiteLLM proxy. LiteLLM is
# OpenAI-compatible, so the provider is the pinned `provider-openai` worker
# pointed at LiteLLM's Chat Completions endpoint (`/v1/chat/completions`; any
# endpoint not ending in `/responses` selects that wire format). The project
# also runs the pinned `state` worker, which llm-router and provider-openai
# need for their registry, catalog, and registration-token state, and the
# pinned `github` worker, which exposes the GitHub CLI as typed `github::*`
# functions. The github worker shells out to the pinned `gh` package: its
# absolute store path is the container's `gh_executable` setting, and the
# GitHub PAT reaches each child gh process as `GH_TOKEN` from the sops
# `iii-software-factory-env` template. PR webhooks stay disabled (the upstream
# default), so the project does not run the `http` or `queue` workers that path
# would need; the `cron` worker is included separately for scheduled functions.
#
# The same project runs the evaluation pair: the pinned `judge` hub and a
# source-built `judge-openai` provider whose fixed OpenAI Decisions endpoint
# is patched to LiteLLM's `/v1/decisions` (overlays/iii.nix). judge-openai
# authenticates to LiteLLM with the unit's `OPENAI_API_KEY` (the LiteLLM
# master key); the gateway owns the upstream ChatGPT subscription token.
# The hub's default provider is `openai`, so callers reach it through
# `judge::evaluate` without a per-session picker.
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
    "cron"
    "github"
    "judge"
    "judge-openai"
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

      # The cron worker hosts `cron::on-tick`, so factory functions can run on
      # schedules without the http/queue webhook path.
      cron = {
        worker = "path://./cron";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        scripts.run = lib.getExe cfg.cronPackage;
      };

      # The github worker exposes gh as typed github::* functions. It resolves
      # the pinned gh package from this absolute path and inherits GH_TOKEN
      # from the unit environment for its child gh processes.
      github = {
        worker = "path://./github";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        # Upstream's configuration entry is `github`; without this name
        # Compose would use `software-factory-github`.
        config_name = "github";
        scripts.run = lib.getExe cfg.githubPackage;
        config_override.gh_executable = lib.getExe cfg.ghPackage;
      };

      # The judge hub forwards typed Noul/Choice/Score questions to the
      # selected judge-<provider> worker. The default provider is the
      # `judge-openai` worker below; the provider is started first so the
      # hub has a registered target by the time callers arrive.
      judge = {
        worker = "path://./judge";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        start_after = [ "judge-openai" ];
        # The hub reads the `judge` configuration entry (`III_CONFIG_NAME`);
        # without this name Compose would use `software-factory-judge`.
        config_name = "judge";
        scripts.run = lib.getExe cfg.judgePackage;
        config_override.provider = "openai";
      };

      # `judge-openai` is built from the pinned 0.4.1 source with its fixed
      # OpenAI Decisions endpoint patched to LiteLLM's `/v1/decisions`
      # (overlays/iii.nix). It authenticates to the loopback proxy with the
      # LiteLLM master key from the unit's sops environment; LiteLLM owns
      # the upstream ChatGPT subscription token.
      judge-openai = {
        worker = "path://./judge-openai";
        required = true;
        restart = "always";
        startup_timeout = "60s";
        start_after = [ "state" ];
        # The provider reads its `judge-openai` configuration entry; the
        # model is the gateway-only Decisions logical model.
        config_name = "judge-openai";
        scripts.run = lib.getExe cfg.judgeOpenaiPackage;
        config_override.model = "gpt-6-luna-decisions";
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

    cronPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.cron;
      description = ''
        Pinned cron worker package hosting `cron::on-tick` schedules.
      '';
    };

    githubPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.github;
      description = ''
        Pinned github worker package exposing the GitHub CLI as typed
        `github::*` functions.
      '';
    };

    ghPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.gh;
      description = ''
        GitHub CLI the github worker shells out to. The absolute store path is
        supplied as the worker's `gh_executable` setting.
      '';
    };

    judgePackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.iii-workers.judge;
      description = ''
        Pinned `judge` hub worker package forwarding typed evaluations to a
        registered `judge-<provider>` worker.
      '';
    };

    judgeOpenaiPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.judgeOpenAiLitellm;
      description = ''
        Source-built `judge-openai` provider whose fixed Decisions endpoint is
        compiled as LiteLLM's `/v1/decisions` URL (overlays/iii.nix).
      '';
    };

    litellmDecisionsApiUrl = lib.mkOption {
      type = lib.types.str;
      default = "http://${config.services.litellm.host}:${toString config.services.litellm.port}/v1/decisions";
      description = ''
        LiteLLM Decisions endpoint the default `judgeOpenaiPackage` was built
        against. Overriding this URL requires overriding the package too.
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
    assertions = [
      {
        assertion =
          (cfg.judgeOpenaiPackage.passthru.endpoint or cfg.litellmDecisionsApiUrl)
          == cfg.litellmDecisionsApiUrl;
        message = "fabro.iiiSoftwareFactory: litellmDecisionsApiUrl must match the endpoint compiled into judgeOpenaiPackage (${
          toString (cfg.judgeOpenaiPackage.passthru.endpoint or "<unknown>")
        }).";
      }
    ];

    systemd.services.iii-software-factory = {
      description = "iii software-factory project (llm-router and judge routed through LiteLLM)";
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
        # credential fallback and judge-openai's proxy authentication, and
        # GH_TOKEN (the GitHub PAT) for the github worker's child gh
        # processes; systemd reads the root-only sops template before dropping
        # to the dynamic user.
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
