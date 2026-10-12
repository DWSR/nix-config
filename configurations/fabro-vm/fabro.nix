# Fabro server on the fabro host: the workflow engine's API server + web UI
# as a systemd service (the mac's `programs.fabro` launchd agent, minus its
# Keychain machinery). Depends on LiteLLM (model routing) and Docker (the
# docker sandbox provider) with hard `requires` semantics: stopping either
# stops fabro, and both are up before fabro starts.
#
# The ported settings keep the runtime-verified values the mac agent
# deployed (same fabro build channel), with the guest paths substituted:
#   * artifacts local.root: <FABRO_STORAGE_DIR>/objects (was the mac's
#     ~/.local/share/fabro/objects).
#   * `server.auth.methods = ["dev-token"]` is REQUIRED by fabro (the field
#     has no "none": the server refuses to start without a bootstrap
#     method, and dev-token start requires the SESSION_SECRET +
#     FABRO_DEV_TOKEN pair). The pair is NOT in the Nix store: systemd
#     loads it from the sops-nix-rendered env file
#     (`sops.templates."fabro-env"` in default.nix: decrypted from
#     secrets/fabro.fabro.yaml into /run/secrets at activation, then
#     rendered as an EnvironmentFile). The template carries the
#     1Password Fabro pair, so switching to it invalidates web/CLI
#     sessions bound to the pair the VM previously generated in-guest.
#
# settings.toml is installed into FABRO_HOME before every start (systemd
# StateDirectory owns /var/lib/fabro), preserving the ownership semantics
# the HM module had at activation time: declarative content wins over
# runtime wizard edits on every restart.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  tomlFormat = pkgs.formats.toml { };

  fabroStateDir = "/var/lib/fabro/home";
  fabroDataDir = "/var/lib/fabro/storage";

  fabroSettings = tomlFormat.generate "fabro-settings.toml" {
    llm.providers.litellm = {
      enabled = true;
      base_url = "http://127.0.0.1:4000/v1";
      default_model = "glm-5.3-flash";

      models = {
        "gpt-6-luna" = {
          display_name = "GPT-6 Luna (ChatGPT, xhigh)";
          api_model = "chatgpt/gpt-6-luna";
          limits = {
            context_tokens = 1050000;
            max_output_tokens = 128000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            reasoning_effort = {
              xhigh = true;
            };
          };
        };
        "gpt-6-luna-none" = {
          display_name = "GPT-6 Luna (ChatGPT, no thinking)";
          api_model = "chatgpt/gpt-6-luna";
          limits = {
            context_tokens = 1050000;
            max_output_tokens = 128000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            # lithos has no `none` effort (minimal..max), so no-think
            # stays the unset default: fabro sends no effort and
            # litellm's deployment default (`reasoning_effort = "none"`)
            # applies.
          };
        };
        "gpt-6-astra" = {
          display_name = "GPT-6 Astra (ChatGPT, xhigh)";
          api_model = "chatgpt/gpt-6-astra";
          limits = {
            context_tokens = 1050000;
            max_output_tokens = 128000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            reasoning_effort = {
              xhigh = true;
            };
          };
        };
        "gpt-6.1-sol" = {
          display_name = "GPT-6.1 Sol (ChatGPT, xhigh)";
          api_model = "chatgpt/gpt-6.1-sol";
          limits = {
            context_tokens = 1050000;
            max_output_tokens = 128000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            reasoning_effort = {
              xhigh = true;
            };
          };
        };
        "go-gpt-6-luna" = {
          display_name = "GPT-6 Luna (OpenCode Go)";
          api_model = "opencode-go/gpt-6-luna";
          limits = {
            context_tokens = 1050000;
            max_output_tokens = 128000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            reasoning_effort = {
              low = true;
              medium = true;
              high = true;
              xhigh = true;
              max = true;
            };
          };
        };
        "glm-5.3-flash" = {
          display_name = "GLM-5.3 Flash (OpenCode Go)";
          api_model = "opencode-go/glm-5.3-flash";
          small_default = true;
          limits = {
            context_tokens = 1000000;
            max_output_tokens = 131072;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
            reasoning_effort = {
              low = true;
              high = true;
              max = true;
            };
          };
        };
        "longcat-2.5" = {
          display_name = "LongCat 2.5 Preview Free (OpenCode Go)";
          api_model = "opencode-go/longcat-2.5-preview-free";
          # Same family tier and chat-model window as longcat-2.0's
          # serving; upstream publishes no separate hard output cap.
          limits = {
            context_tokens = 1000000;
            max_output_tokens = 131072;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
          };
        };
        "big-pickle" = {
          display_name = "Big Pickle (OpenCode Zen)";
          api_model = "opencode-zen/big-pickle";
          limits = {
            context_tokens = 200000;
            max_output_tokens = 32000;
          };
          capabilities = {
            text = true;
            tools = true;
            reasoning = true;
          };
        };
      };
    };

    cli = {
      exec.model = {
        provider = "litellm";
        name = "glm-5.3-flash";
      };

      target = {
        type = "http";
        url = "http://127.0.0.1:32276/api/v1";
      };
    };

    run = {
      environment.id = "default";
      model.name = "glm-5.3-flash";
    };

    server = {
      api.url = "http://127.0.0.1:32276/api/v1";

      artifacts = {
        prefix = "artifacts";
        provider = "local";
        local.root = "${fabroDataDir}/objects";
      };

      auth.methods = [ "dev-token" ];

      integrations.github.strategy = "token";

      listen = {
        address = "127.0.0.1:32276";
        type = "tcp";
      };

      sandbox.providers = {
        daytona.enabled = false;
        docker.enabled = true;
        local.enabled = true;
      };

      web = {
        enabled = true;
        # The tailnet-facing URL (svc:fabro is advertised at 443 by
        # tailscale.nix): the server redirects the web UI root here, and a
        # loopback self-reference would point tailnet clients at themselves.
        # The API URL below stays loopback-only — the in-guest CLI consumer
        # does not traverse the tailnet.
        url = "https://fabro.tuxedo-musical.ts.net";
      };
    };
  };
in
{
  systemd.services.fabro = {
    description = "Fabro workflow engine server (API + web UI)";
    wantedBy = [ "multi-user.target" ];

    # Fabro relies on LiteLLM (model routing via llm.providers.litellm) and
    # Docker (the docker sandbox provider): hard dependencies, so either
    # stopping takes fabro down, and both boot before fabro.
    after = [
      "docker.service"
      "litellm.service"
    ];
    requires = [
      "docker.service"
      "litellm.service"
    ];

    environment = {
      # Same FABRO_HOME/FABRO_STORAGE_DIR split the upstream Docker image
      # performs and the mac HM module mirrored.
      FABRO_HOME = fabroStateDir;
      FABRO_STORAGE_DIR = fabroDataDir;
      # Log to stdout so journald captures the stream.
      FABRO_LOG_DESTINATION = "stdout";
      # The store-path binary cannot self-upgrade; suppress the upgrade
      # check (same value the upstream CLI env docs document).
      FABRO_NO_UPGRADE_CHECK = "true";
      # Suppress Segment telemetry for the supervised server.
      FABRO_TELEMETRY = "off";
      HOME = "/var/lib/fabro";
    };

    # Workflow nodes (shell executors spawned by fabro runs) resolve PATH
    # here; git mirrors the dependency the upstream Docker image installs.
    path = [ pkgs.git ];

    serviceConfig = {
      # The dev-token auth pair (SESSION_SECRET, FABRO_DEV_TOKEN) from
      # the sops-nix template env (rendered at activation from
      # secrets/fabro.fabro.yaml; see default.nix). Missing entries fail
      # start-up loudly: dev-token auth refuses to run without them
      # anyway.
      EnvironmentFile = config.sops.templates."fabro-env".path;
      ExecStartPre = "${pkgs.coreutils}/bin/install -m 0600 -T ${fabroSettings} ${fabroStateDir}/settings.toml";
      ExecStart = "${lib.getExe pkgs.fabro} server start --foreground";
      StateDirectory = [
        "fabro/home"
        "fabro/storage"
      ];
      # The docker sandbox provider talks over /run/docker.sock (the
      # docker group is dropped from DynamicUser's dynamic user unless
      # listed here).
      SupplementaryGroups = [ "docker" ];
      DynamicUser = true;
      Restart = "on-failure";
      RestartSec = 5;
      NoNewPrivileges = true;
      PrivateTmp = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      RestrictAddressFamilies = [
        "AF_UNIX"
        "AF_INET"
        "AF_INET6"
      ];
    };
  };
}
