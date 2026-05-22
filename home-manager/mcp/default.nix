{
  pkgs,
  lib,
  config,
  ...
}:
let
  githubToken =
    if config.home.mcp.githubToken == null then
      builtins.throw "home.mcp.githubToken must be set"
    else
      config.home.mcp.githubToken;

  cfg = config.home.mcp;

  # Convert a SOPS-bridged keychain secret name (e.g. `mcp-github-token`)
  # to the env-var name the launchd wrapper exports for it
  # (e.g. `MCP_GITHUB_TOKEN`). Uppercase + hyphen→underscore.
  toEnvVarName = name: lib.toUpper (builtins.replaceStrings [ "-" ] [ "_" ] name);

  # Emit an mcpproxy `${env:<NAME_UPPERCASE>}` placeholder. The placeholder
  # is NOT resolved at Nix evaluation time and NOT at home-manager
  # activation time. The launchd wrapper (`mcpproxyWrapper` below) reads
  # each declared secret from the macOS Keychain at daemon startup and
  # exports it as an env var; mcpproxy then substitutes the placeholder
  # by reading its own process env at spawn time.
  #
  # mcpproxy v0.33.1 does NOT resolve `${keyring:...}` placeholders for
  # the top-level `api_key` field (only for per-server `env` and
  # `headers` fields), and its macOS Keychain backend refuses to write
  # under Nix packaging (the "refusing to write to avoid OS modal prompts"
  # safety check). Funneling every secret through `${env:...}` + a
  # launchd wrapper script eliminates both problems: the wrapper reads
  # the keychain via the Apple-signed `/usr/bin/security` binary, which
  # has reliable Keychain access regardless of how mcpproxy is packaged.
  #
  # See `mcpproxyWrapper` below and the SOPS bridge in
  # `configurations/common-darwin/mcp-sops-bridge.nix` +
  # `scripts/mcp-secrets-activate.nix` for the secret-flow contract.
  readKeychainSecret = name: "\${env:" + toEnvVarName name + "}";

  # Map a source extraServers attrset entry (or one of the base
  # upstreams below, built in the same attrset shape) to the array
  # entry mcpproxy expects. The attribute name becomes the `name`
  # field. The source `type` attribute (absent | "stdio" | "http" |
  # "streamable-http") becomes the explicit `protocol`. `enabled` and
  # `quarantined` are always set explicitly so the rendered config
  # cannot be misread; mcpproxy's per-server defaults are bypassed.
  protocolOf = serverCfg: serverCfg.type or "stdio";

  renderServer =
    name: serverCfg:
    let
      protocol = protocolOf serverCfg;
      isStdio = protocol == "stdio";
      isHttp = protocol == "http" || protocol == "streamable-http";
      stdioFields =
        if isStdio then
          {
            inherit (serverCfg) command;
            args = serverCfg.args or [ ];
          }
          // lib.optionalAttrs (serverCfg ? env) { inherit (serverCfg) env; }
        else
          { };
      httpFields =
        if isHttp then
          {
            inherit (serverCfg) url;
          }
          // lib.optionalAttrs (serverCfg ? headers) { inherit (serverCfg) headers; }
        else
          { };
    in
    {
      inherit name protocol;
      enabled = true;
      quarantined = false;
    }
    // stdioFields
    // httpFields;

  # The four base upstream MCP servers always present on every host.
  # They flow through the same `renderServer` translator as
  # `home.mcp.extraServers` entries so the array-emission logic stays
  # uniform. The `nixos` server in the legacy mcphub config is renamed
  # to `mcp-nixos` here (R2.1).
  baseServers = {
    obsidian = {
      command = "${pkgs.mcp-obsidian}/bin/mcp-obsidian";
      args = [ cfg.obsidianVaultPath ];
    };

    github = {
      command = "${pkgs.github-mcp-server}/bin/github-mcp-server";
      args = [
        "stdio"
        "--toolsets=all"
      ];
      env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
    };

    mcp-nixos = {
      command = "${pkgs.mcp-nixos}/bin/mcp-nixos";
      args = [ "--" ];
    };
  };

  mergedServers = baseServers // cfg.extraServers;

  renderedConfig = {
    listen = "127.0.0.1:${toString cfg.listenPort}";
    data_dir = "${config.home.homeDirectory}/.mcpproxy";
    routing_mode = "retrieve_tools";
    quarantine_enabled = false;
    api_key = readKeychainSecret "mcpproxy-api-key";
    require_mcp_auth = false;
    mcpServers = lib.mapAttrsToList renderServer mergedServers;
  };

  # Every operator-declared MCP secret that the mcpproxy daemon
  # actually consumes (top-level api_key + per-server env/header
  # placeholders), plus the bridge-owned `mcpproxy-api-key`. The
  # launchd wrapper iterates this list and exports each value from
  # the macOS Keychain as an env var.
  #
  # The `sqlite-backup-*` filter matches the routing in
  # `scripts/mcp-secrets-activate.nix`'s `route_service` helper: those
  # secrets are written under `-s nix-config-secrets` (for the
  # sqlite-backup CLI / verify pipeline), not under `-s mcpproxy`, so
  # the wrapper must not try to read them under the mcpproxy service.
  # The mcpproxy daemon does not reference sqlite-backup secrets in
  # any rendered `mcp_config.json` placeholder anyway. Keep this
  # predicate in sync with the activation script.
  daemonSecretNames = [
    "mcpproxy-api-key"
  ]
  ++ builtins.filter (name: !(lib.hasPrefix "sqlite-backup-" name)) (
    builtins.attrNames cfg.keychainSecrets
  );

  # Launchd wrapper around `mcpproxy serve`. Reads every declared
  # MCP secret from the macOS Keychain via Apple's `/usr/bin/security`
  # binary, exports each as the env var the rendered `mcp_config.json`
  # references via `${env:NAME}` placeholders, then exec's mcpproxy.
  #
  # This is a workaround for two mcpproxy v0.33.1 limitations:
  #
  #   1. The top-level `api_key` field is read from the config file
  #      before the secret-resolution pipeline runs, so
  #      `${keyring:mcpproxy-api-key}` is treated as a literal string
  #      and the daemon rejects every request with `Invalid API key`.
  #   2. mcpproxy's macOS Keychain backend (via go-keyring) refuses to
  #      write under Nix-packaged binaries that aren't codesigned with
  #      a developer identity; it can read, but reads are also flaky
  #      under launchd's user-agent context when the keychain isn't
  #      yet unlocked (race vs login-completion).
  #
  # Funnelling secret resolution through this wrapper (which uses the
  # Apple-signed `security` binary) makes both problems disappear: the
  # daemon never has to talk to the macOS Keychain directly. Failure of
  # any keychain read aborts the wrapper before mcpproxy starts, so the
  # daemon never launches with literal placeholder strings.
  mcpproxyWrapper = pkgs.writeShellApplication {
    name = "mcpproxy-launchd-wrapper";
    runtimeInputs = [ ];
    text = ''
      set -eu

      ${lib.concatMapStringsSep "\n" (
        name:
        let
          envName = toEnvVarName name;
        in
        ''
          if ! ${envName}="$(/usr/bin/security find-generic-password -s mcpproxy -a "${name}" -w 2>/dev/null)"; then
            echo "mcpproxy-launchd-wrapper: failed to read '${name}' from macOS Keychain (-s mcpproxy -a ${name})" >&2
            echo "  ensure the SOPS bridge has populated this entry; re-run \`darwin-rebuild switch\` and check" >&2
            echo "  /var/log/install.log for mcp-secrets-activate errors." >&2
            exit 1
          fi
          export ${envName}
        ''
      ) daemonSecretNames}

      exec ${lib.getExe pkgs.mcpproxy-go} "$@"
    '';
  };
in
{
  options.home.mcp = {
    githubToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "GitHub personal access token for MCP server";
    };

    ghAuthToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = ''
        1Password URI for the gh CLI auth token (e.g.,
        `op://Employee/...` on Shopify hosts, `op://Private/...` on
        personal hosts). Sourced via the same per-host SOPS+1Password
        pipeline as `home.mcp.keychainSecrets`; the bridge module reads
        this URI to materialize the gh token at activation time.
      '';
    };

    obsidianVaultPath = lib.mkOption {
      type = lib.types.str;
      description = "Absolute path to the Obsidian vault for agent memory and conversation logs";
    };

    extraServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      default = { };
      description = ''
        Additional MCP servers to add to the mcpproxy configuration.
        Entries keep an attrset shape (the attribute name becomes the
        server `name` in the rendered array). Stdio servers use
        `command`, `args`, and optional `env`; HTTP and
        streamable-HTTP servers set `type = "http"` or
        `type = "streamable-http"`, `url`, and optional `headers`.
        The renderer translates this attrset into mcpproxy's
        `mcpServers` array shape and appends `enabled = true` and
        `quarantined = false` to every entry.
      '';
      example = {
        custom-server = {
          command = "\${pkgs.custom-mcp}/bin/custom-mcp";
          args = [ "arg1" ];
          env.CUSTOM_VAR = "value";
        };
      };
    };

    keychainSecrets = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      description = "Map of keychain service names to 1Password URIs. Secrets are read from op during activation and stored in the macOS Keychain for runtime access.";
      example = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
      };
    };

    listenPort = lib.mkOption {
      type = lib.types.port;
      default = 8080;
      description = ''
        TCP port on which the mcpproxy daemon listens on 127.0.0.1.
        Consumers (opencode wrapper, memory-sync CLI, cavemem wrapper)
        derive their probe URLs from this value via the rendered
        mcp_config.json.
      '';
    };

    enable = lib.mkEnableOption "MCP hub configuration" // {
      default = true;
    };
  };

  options.home.mcp.readKeychainSecret = lib.mkOption {
    type = lib.types.raw;
    default = readKeychainSecret;
    readOnly = true;
    description = ''
      Function that returns an `${"\${env:NAME}"}` placeholder for use
      in rendered MCP server `env` and `headers` values, where `NAME`
      is the secret name uppercased and with `-` replaced by `_`
      (e.g. `mcp-github-token` → `${"\${env:MCP_GITHUB_TOKEN}"}`).
      mcpproxy resolves the placeholder at server-spawn time by
      reading the matching env var from its own process environment;
      the launchd wrapper (see `mcpproxyWrapper` in this module)
      sources every required env var from the macOS Keychain at
      daemon startup. The placeholder is never expanded at Nix
      evaluation or home-manager activation time, so no secret
      material appears in `mcp_config.json` or the Nix store.
    '';
  };

  config = lib.mkIf config.home.mcp.enable {
    home.packages = [
      pkgs.mcpproxy-go
      pkgs.github-mcp-server
      pkgs.mcp-nixos
      pkgs.mcp-obsidian
      (pkgs.writeScriptBin "restart-mcpproxy" ''
        #!/bin/sh
        exec launchctl kickstart -k "gui/$(id -u)/com.smart-mcp-proxy.mcpproxy"
      '')
    ];

    xdg.configFile."mcpproxy/mcp_config.json" = {
      enable = true;
      text = builtins.toJSON renderedConfig;
    };

    # launchd refuses to auto-create StandardOutPath / StandardErrorPath
    # parent directories; ensure ~/Library/Logs/mcpproxy exists before
    # the agent starts.
    home.activation.mcpproxyLogDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p "${config.home.homeDirectory}/Library/Logs/mcpproxy"
    '';

    launchd.agents.mcpproxy = {
      enable = true;
      config = {
        Label = "com.smart-mcp-proxy.mcpproxy";
        ProgramArguments = [
          # The wrapper reads every MCP secret from the macOS Keychain
          # (via Apple's signed `/usr/bin/security`) and exports each as
          # an env var BEFORE exec'ing mcpproxy. This bypasses two
          # mcpproxy v0.33.1 quirks: the top-level `api_key` field is
          # not run through the secret-resolution pipeline (so
          # `${keyring:...}` would never resolve), and the daemon's own
          # macOS Keychain backend is unreliable under Nix packaging.
          # See the `mcpproxyWrapper` definition in this file for the
          # full rationale.
          (lib.getExe mcpproxyWrapper)
          "serve"
          "--config=${config.xdg.configHome}/mcpproxy/mcp_config.json"
          "--log-to-file=false"
          # Prevent runtime mutation of mcp_config.json. mcpproxy
          # v0.33.1's DELETE /api/v1/servers/{id} and POST
          # /api/v1/servers paths persist their changes back to the
          # config file, detaching home-manager's symlink and turning
          # the file into a regular operator-writable copy. Disabling
          # the add/remove paths leaves the runtime API read-only for
          # server inventory while keeping OAuth login, quarantine
          # approval, and per-server enable/disable available.
          "--allow-server-add=false"
          "--allow-server-remove=false"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables.PATH =
          lib.makeBinPath [
            pkgs.unstable.google-cloud-sdk
            pkgs.git-lfs
          ]
          + ":/usr/bin:/bin";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/mcpproxy/launchd.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/mcpproxy/launchd.error.log";
      };
    };
  };
}
