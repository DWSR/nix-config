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
# settings.toml is installed into FABRO_HOME before every start (the
# state root /var/lib/fabro is Lima's writable virtiofs share of the
# host's ~/.local/state/fabro, so the fabro state physically lives on
# the macOS host and survives VM recreation). VZ maps the whole share to
# the Lima cidata user (`brandonmcnama`), so the service runs as that
# identity rather than a DynamicUser, needs explicit ReadWritePaths
# under ProtectSystem=strict, and waits for lima-init's fstab-derived
# mount units; see the module comment in
# configurations/personal/home-manager/default.nix). The install keeps
# the declarative-wins semantics: the generated settings.toml overwrites
# runtime wizard edits on every start.
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
      default_model = "deepseek-v4.1-flash";

      # OpenCode's Go gateway rejects requests without a stable
      # x-opencode-session id; fabro never sends one itself (its lithos
      # client sends only content-type/authorization/accept/user-agent),
      # so attach a static id at the provider level. default_headers
      # interpolate only vault secrets here (env/vars/run context are
      # rejected or passed through literally on 0.382.0-nightly.0), so a
      # shared id is the only option: every fabro call lands in one
      # gateway session bucket, which coarsens prompt-cache routing
      # affinity but is accepted.
      default_headers."x-opencode-session" = "fabro-litellm";

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
        "deepseek-v4.1-flash" = {
          display_name = "DeepSeek V4.1 Flash (OpenCode Go)";
          api_model = "opencode-go/deepseek-v4.1-flash";
          # Same parity tier as the wire it shares with glm-5.3-flash, and
          # the cheap pick for fabro's small utility tasks (run titles and
          # other metadata calls).
          small_default = true;
          # DeepSeek's published V4 ceiling: 1M total context, 384k output.
          limits = {
            context_tokens = 1000000;
            max_output_tokens = 384000;
          };
          capabilities = {
            text = true;
            tools = true;
            # Reasoning effort is unset (DeepSeek carries no fabro-mapped
            # effort enum on this wire): fabro sends no effort and the
            # gateway's own default thinking mode applies.
            reasoning = true;
          };
        };
        "glm-5.3-flash" = {
          display_name = "GLM-5.3 Flash (OpenCode Go)";
          api_model = "opencode-go/glm-5.3-flash";
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
        name = "deepseek-v4.1-flash";
      };

      target = {
        type = "http";
        url = "http://127.0.0.1:32276/api/v1";
      };
    };

    run = {
      environment.id = "default";
      model.name = "deepseek-v4.1-flash";

      # Push every checkpoint: after each node commits to fabro/run/<id>,
      # publish the branch to origin so checkpoint timeline, fork, and
      # rewind can resolve checkpoints against the remote branch.
      run_branch = {
        enabled = true;
        push = true;
      };
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
  # ExecStartPost health gate (same contract as litellm.nix's
  # litellmHealthGate): poll the API's /api/v1/health so "active"
  # means the listener answers, not just that the process spawned.
  # Curl's -f fails on 4xx/5xx, so a not-yet-ready response loops too.
  fabroHealthGate = pkgs.writeShellApplication {
    name = "fabro-health-gate";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.curl
    ];
    text = ''
      attempts=30
      for (( i = 1; i <= attempts; i++ )); do
        if curl -fsS --connect-timeout 2 --max-time 4 -o /dev/null 'http://127.0.0.1:32276/api/v1/health'; then
          exit 0
        fi
        echo "fabro-health-gate: probe $i/$attempts failed, retrying" >&2
        sleep 2
      done
      echo "fabro-health-gate: /api/v1/health never returned 200" >&2
      exit 1
    '';
  };
in
{
  systemd.services.fabro = {
    description = "Fabro workflow engine server (API + web UI)";
    wantedBy = [ "multi-user.target" ];

    # Fabro relies on LiteLLM (model routing via llm.providers.litellm) and
    # Docker (the docker sandbox provider): hard dependencies, so either
    # stopping takes fabro down, and both boot before fabro. lima-init is
    # the unit that writes /etc/fstab entries for Lima's mounts and
    # restarts local-fs.target — the state share is guaranteed up only
    # after it (RequiresMountsFor below adds the mount-unit ordering too).
    after = [
      "docker.service"
      "litellm.service"
      "lima-init.service"
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

    # The state subpaths must be writable explicitly under
    # ProtectSystem=strict (StateDirectory is unusable on a mount it
    # would chown), and start-up must wait for the mount unit so a
    # failed share fails loudly instead of silently writing into the
    # guest's root filesystem. unitConfig is a SIBLING of serviceConfig —
    # RequiresMountsFor inside serviceConfig would fail the unit-file
    # render with a set-coercion error.
    unitConfig.RequiresMountsFor = "/var/lib/fabro";

    serviceConfig = {
      # The dev-token auth pair (SESSION_SECRET, FABRO_DEV_TOKEN) and the
      # GitHub PAT (GITHUB_TOKEN; the token-strategy GitHub integration
      # itself reads it from the server vault — see the github-token
      # comment in default.nix — this export is the rendered source for
      # that one imperative `fabro secret set`) from the sops-nix template
      # env (rendered at activation from secrets/fabro.fabro.yaml; see
      # default.nix). Missing entries fail start-up loudly: dev-token auth
      # refuses to run without them anyway.
      EnvironmentFile = config.sops.templates."fabro-env".path;
      ExecStartPre = [
        # The state subdirectories live inside the host-owned share and
        # must exist before the settings install (and before the first
        # start ever saw them); idempotent, runs as the service user who
        # owns the share.
        "${pkgs.coreutils}/bin/mkdir -p ${fabroStateDir} ${fabroDataDir}"
        "${pkgs.coreutils}/bin/install -m 0600 -T ${fabroSettings} ${fabroStateDir}/settings.toml"
      ];
      ExecStart = "${lib.getExe pkgs.fabro} server start --foreground";
      ExecStartPost = lib.getExe fabroHealthGate;

      # The state root is Lima's writable virtiofs share of the host's
      # ~/.local/state/fabro. VZ maps the whole share to the Lima cidata
      # user: any other identity (a DynamicUser above all) fails EPERM
      # against even a chown of the state dirs, so the service runs as
      # the cidata user, which the share's host directory is owned by
      # (see configurations/personal/home-manager/default.nix's mounts).
      User = "brandonmcnama";

      # explicit ReadWritePaths under ProtectSystem=strict.
      ReadWritePaths = [ "/var/lib/fabro" ];

      # The docker sandbox provider talks over /run/docker.sock (the
      # service user needs the docker gid regardless of /etc/group
      # membership).
      SupplementaryGroups = [ "docker" ];
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
