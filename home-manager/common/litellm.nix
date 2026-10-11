{
  config,
  lib,
  options,
  pkgs,
  ...
}:
# litellm: local LiteLLM gateway for subscription-backed models. The
# launchd user agent fronts paid subscriptions (e.g. the ChatGPT Plus/Pro
# Codex backend via `chatgpt/` OAuth, OpenCode Go/Zen via its
# OpenAI-compatible endpoint) and exposes them as one loopback
# OpenAI-compatible API, so local consumers (total-recall, fabro, opencode)
# never each need their own subscription integration.
#
# Usage contract for consumers:
#   base URL        http://127.0.0.1:<port> (OpenAI /v1 plus the
#                   Anthropic-style /v1/messages, both proxied)
#   auth            `Authorization: Bearer <key>` where <key> is the
#                   Keychain entry named by masterKeyReference (service
#                   `mcpproxy`, account `<masterKeyReference>` — the same
#                   Keychain layout mcp-secrets-activate writes)
#   chatgpt models  require a one-time interactive sign-in: run
#                   `litellm-chatgpt-login` in a terminal, then
#                   `launchctl kickstart -k gui/$(id -u)/dev.dwsr.litellm`.
#                   The device flow cannot run inside the proxy.
#
# Secrets flow through the same SOPS -> /run/secrets -> macOS Keychain ->
# launchd-wrapper-env pipeline as the mcp servers; nothing secret is
# rendered into the Nix store (config.yaml carries `os.environ/...`
# references only).
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.programs.litellm;

  logDir = "${config.home.homeDirectory}/Library/Logs/litellm";
  serviceStateDir = "${config.xdg.stateHome}/litellm";
  settingsPath = "${config.xdg.configHome}/litellm/config.yaml";
  keychainPath = "${config.home.homeDirectory}/Library/Keychains/login.keychain-db";

  yamlFormat = pkgs.formats.yaml { };

  settingsManaged = cfg.settings != { };
  settingsFile = yamlFormat.generate "litellm-config.yaml" cfg.settings;

  # Shell PATH for anything litellm spawns as a subprocess (canonical
  # refilenames, custom guardrail CLIs, ...). Mirrors home-manager/common/fabro.nix.
  servicePath = lib.concatStringsSep ":" (
    (lib.optionals (cfg.path != [ ]) [ (lib.makeBinPath cfg.path) ])
    ++ [
      "${config.home.path}/bin"
      "/usr/local/bin"
      "/usr/bin"
      "/bin"
      "/usr/sbin"
      "/sbin"
    ]
  );

  serviceEnv = {
    # litellm restructures its packaged Next.js admin UI into extensionless
    # routes on startup; the Nix store copy is read-only, so point the
    # runtime UI copy at a writable state directory. Same treatment as the
    # NixOS module (nixos/modules/services/misc/litellm.nix).
    LITELLM_NON_ROOT = "true";
    LITELLM_UI_PATH = "${serviceStateDir}/ui";
    # Seed tiktoken's on-demand encoding cache; without it the first token
    # count for each encoding downloads over the network at request time.
    CUSTOM_TIKTOKEN_CACHE_DIR = "${serviceStateDir}/tiktoken-cache";
    # Suppress the CLI feedback box in the launchd stdout (proxy_server.py
    # honours this variable; the shell convention DO_NOT_TRACK does not
    # reach launchd agents).
    LITELLM_DONT_SHOW_FEEDBACK_BOX = "true";
    DO_NOT_TRACK = "1";
    PATH = servicePath;
  }
  // cfg.environment;

  # tiktoken encoding files litellm fetches from openaipublic.blob.core.windows.net
  # on first use, seeded into CUSTOM_TIKTOKEN_CACHE_DIR at activation. The key
  # is tiktoken's own cache name: sha1 of the source URL.
  tiktokenEncodings = {
    cl100k_base = "https://openaipublic.blob.core.windows.net/encodings/cl100k_base.tiktoken";
    o200k_base = "https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken";
  };
  tiktokenCacheSeeds = lib.mapAttrsToList (name: url: {
    inherit url;
    hash =
      if name == "cl100k_base" then
        # Same fetch the NixOS litellm module seeds.
        "sha256-Ijkht27pm96ZW3/3OFE+7xAPtR0YyTWXoRO8/+hlsqc="
      else
        "sha256-RGqVOMtsNI41FhINfAiwn1fDZJXirP/+WaW/iwz7Gi0=";
    cacheKey = builtins.hashString "sha1" url;
  }) tiktokenEncodings;

  # Secrets the wrapper resolves from the mcpproxy-routed Keychain layout
  # (see scripts/mcp-secrets-activate.nix): the master key and any provider
  # credentials declared via providerKeys.
  wrapperKeychainSecrets =
    lib.optionals (cfg.masterKeyReference != null) [
      {
        envName = "LITELLM_MASTER_KEY";
        secretName = cfg.masterKeyReference;
        fatal = true;
      }
    ]
    ++ lib.mapAttrsToList (envName: secretName: {
      inherit envName secretName;
      fatal = false;
    }) cfg.providerKeys;
  wrapperResolvesKeychain = wrapperKeychainSecrets != [ ];

  # Bash parameter reference defaulting to empty, built by concatenation so
  # the indented wrapper text can interpolate the env-var NAME without the
  # `''` string-from-shell escaping swallowing the `${`.
  envRef = name: "\${" + name + ":-}";

  litellmWrapper = pkgs.writeShellApplication {
    name = "litellm-launchd-wrapper";
    text = ''
      set -eu

      ${lib.optionalString wrapperResolvesKeychain "keychain_path=${lib.escapeShellArg keychainPath}"}

      ${lib.concatMapStringsSep "\n" (
        {
          envName,
          secretName,
          fatal,
        }:
        ''
          if ! ${envName}="$(/usr/bin/security find-generic-password -s mcpproxy -a ${lib.escapeShellArg secretName} -w "$keychain_path" 2>/dev/null)" || [ -z "${envRef envName}" ]; then
            ${
              if fatal then
                ''
                  echo "ERROR: ${envName} (${secretName}) unavailable from macOS Keychain; not starting without it." >&2
                  echo "  Provision it via the 1Password item declared in home.mcp.keychainSecrets," >&2
                  echo "  then refresh the Keychain with a switch and restart:" >&2
                  echo "  launchctl kickstart -k gui/\$(id -u)/dev.dwsr.litellm" >&2
                  exit 1
                ''
              else
                ''
                  echo "WARNING: ${secretName} unavailable from macOS Keychain; ${envName} unset until the next switch provisions it." >&2
                ''
            }
          else
            export ${envName}
          fi
        ''
      ) wrapperKeychainSecrets}

      exec ${lib.getExe cfg.package} ${
        lib.escapeShellArgs (
          [
            "--config"
            settingsPath
            "--host"
            cfg.host
            "--port"
            (toString cfg.port)
          ]
          ++ cfg.extraArgs
        )
      }
    '';
  };

  # The ChatGPT-subscription OAuth device flow cannot run inside the proxy:
  # litellm 1.86 holds proxy startup on each chatgpt/ deployment waiting for
  # a human to answer the prompt (docs/providers/chatgpt). Sign in once from
  # an interactive terminal with this helper — tokens land in
  # ~/.config/litellm/chatgpt/auth.json (litellm's default; the proxy reads
  # and refreshes the same file in place) — then restart the agent.
  litellmChatGptLogin = pkgs.writeShellApplication {
    name = "litellm-chatgpt-login";
    text = ''
      exec ${
        (pkgs.python3Packages.python.withPackages (pythonPackages: [ pythonPackages.litellm ])).interpreter
      } -c "from litellm.llms.chatgpt.authenticator import Authenticator; Authenticator().get_access_token()"
    '';
  };
in
{
  options.programs.litellm = {
    enable = mkEnableOption "the LiteLLM proxy launchd user agent";

    package = mkOption {
      type = types.package;
      default = pkgs.litellm;
      defaultText = "pkgs.litellm";
      description = ''
        The litellm package providing the `litellm` binary. Defaults to the
        nixpkgs wrapper package, which includes every proxy extra set, plus
        the a2a-sdk test fix from overlays/default.nix.
      '';
    };

    host = mkOption {
      type = types.str;
      default = "127.0.0.1";
      description = ''
        Host the proxy binds to. Defaults to loopback so only local consumers
        (total-recall, fabro, opencode, curl) reach the gateway.
      '';
    };

    port = mkOption {
      type = types.port;
      default = 4000;
      description = "Port the proxy binds to (litellm's own default).";
    };

    settings = mkOption {
      inherit (yamlFormat) type;
      default = { };
      example = {
        model_list = [
          {
            model_name = "chatgpt/gpt-5.4";
            model_info.mode = "responses";
            litellm_params.model = "chatgpt/gpt-5.4";
          }
          {
            model_name = "go/glm-5.3-flash";
            litellm_params = {
              model = "openai/glm-5.3-flash";
              api_base = "https://opencode.ai/zen/go/v1";
              api_key = "os.environ/OPENCODE_API_KEY";
            };
          }
        ];
      };
      description = ''
        LiteLLM proxy `config.yaml` contents, written to
        {file}`~/.config/litellm/config.yaml`. Must be non-empty when the
        module is enabled; without a model_list litellm starts serving an
        empty gateway whose only working route is the admin UI.

        The config must not contain secret material: it is rendered into the
        Nix store at build time. Reference provider credentials with
        `os.environ/<VAR NAME>` for names declared via {option}`providerKeys`
        (the launchd wrapper exports them from the Keychain before exec).
      '';
    };

    masterKeyReference = mkOption {
      type = types.nullOr types.str;
      default = "litellm-master-key";
      description = ''
        Home `home.mcp.keychainSecrets` entry holding the proxy master key
        (the `Authorization: Bearer <key>` value all local consumers use).
        The wrapper aborts at startup when the entry is missing so launchd
        never runs an unauthenticated proxy. Set to `null` to run without
        authentication — every local process can then spend the
        subscriptions behind the proxy, so prefer keeping a master key.
      '';
    };

    providerKeys = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        OPENCODE_API_KEY = "opencode-api-key";
      };
      description = ''
        Map of environment variable name → `home.mcp.keychainSecrets`
        entry name for upstream provider credentials. The launchd wrapper
        resolves each entry from the Keychain at startup and exports it, so
        litellm `os.environ/<VAR NAME>` references in {option}`settings`
        resolve without secrets entering the Nix store. Missing entries
        log a warning and the matching deployments fail per-request; the
        proxy and the other subscriptions keep working.
      '';
    };

    path = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = ''
        Packages prepended to the service PATH before the user's home
        packages and the standard system directories.
      '';
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      description = ''
        Additional command-line arguments appended to `litellm --config`
        after the config, host, and port arguments.
      '';
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      description = ''
        Extra environment variables for the service, merged over the
        module-provided LITELLM_* variables. Provider credentials normally
        belong in {option}`providerKeys` instead; use this for provider
        options (e.g. a custom `CHATGPT_API_BASE`).
      '';
    };

    _settingsFile = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = ''
        Internal rendered settings file consumed by the activation step and
        tests. Null when settings are not declared.
      '';
    };

    _wrapper = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal launchd wrapper consumed by the agent config and tests.";
    };
  };

  config = lib.mkIf (cfg.enable && options ? home) {
    assertions = [
      {
        assertion = settingsManaged;
        message = "programs.litellm.settings must be non-empty (a model_list) when programs.litellm.enable is true.";
      }
    ]
    ++ lib.optionals (options.home ? mcp && cfg.masterKeyReference != null) [
      {
        assertion = builtins.hasAttr cfg.masterKeyReference config.home.mcp.keychainSecrets;
        message = "programs.litellm.masterKeyReference must name a home.mcp.keychainSecrets entry, or set programs.litellm.masterKeyReference to null.";
      }
    ]
    ++ lib.optionals (options.home ? mcp) (
      lib.mapAttrsToList (envName: secretName: {
        assertion = builtins.hasAttr secretName config.home.mcp.keychainSecrets;
        message = "programs.litellm.providerKeys.${envName} must name a home.mcp.keychainSecrets entry (\"${secretName}\").";
      }) cfg.providerKeys
    );

    programs.litellm = {
      _settingsFile = if settingsManaged then settingsFile else null;
      _wrapper = litellmWrapper;
    };

    home = {
      packages = [
        cfg.package
        litellmChatGptLogin
      ];

      # launchd refuses to auto-create StandardOutPath / StandardErrorPath
      # parent directories, and litellm expects its UI/tiktoken runtime
      # directories to exist (same static seeding as the NixOS module).
      activation.litellmState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p ${
          lib.escapeShellArgs [
            logDir
            "${serviceStateDir}/ui"
            "${serviceStateDir}/tiktoken-cache"
          ]
        }
        ${lib.concatMapStringsSep "\n" (seed: ''
          run install -Dm0644 -T ${
            lib.concatStringsSep " " [
              (toString (
                pkgs.fetchurl {
                  inherit (seed) url hash;
                }
              ))
              (lib.escapeShellArg "${serviceStateDir}/tiktoken-cache/${seed.cacheKey}")
            ]
          }
        '') tiktokenCacheSeeds}
        ${lib.optionalString settingsManaged ''
          run install -Dm600 -T "${settingsFile}" ${lib.escapeShellArg settingsPath}
        ''}
      '';
    };

    xdg.configFile = lib.optionalAttrs settingsManaged {
      "litellm/config.yaml".source = settingsFile;
    };

    launchd.agents.litellm = {
      enable = true;
      config = {
        Label = "dev.dwsr.litellm";
        ProgramArguments = [ "${litellmWrapper}/bin/litellm-launchd-wrapper" ];
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables = serviceEnv;
        StandardOutPath = "${logDir}/litellm.log";
        StandardErrorPath = "${logDir}/litellm.error.log";
      };
    };
  };
}
