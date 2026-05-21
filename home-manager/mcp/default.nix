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

  # Emit an mcpproxy `${keyring:<name>}` placeholder. The placeholder is
  # NOT resolved at Nix evaluation time and NOT at home-manager
  # activation time; mcpproxy resolves it at server-spawn time by
  # reading the macOS Keychain entry written by the sops-nix bridge
  # (see configurations/common-darwin/mcp-sops-bridge.nix and
  # scripts/mcp-secrets-activate.nix). The keychain layout is
  # `service = "mcpproxy"`, `account = "<name>"`.
  readKeychainSecret = name: "\${keyring:" + name + "}";

  cfg = config.home.mcp;

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
      Function that returns an `${"\${keyring:<name>}"}` placeholder
      for use in rendered MCP server `env` and `headers` values.
      mcpproxy resolves the placeholder at server-spawn time by
      reading the matching macOS Keychain entry; the placeholder is
      never expanded at Nix evaluation or activation time, so no
      secret material appears in `mcp_config.json` or the Nix store.
    '';
  };

  config = lib.mkIf config.home.mcp.enable {
    home.packages = [
      pkgs.mcp-hub
      pkgs.github-mcp-server
      pkgs.mcp-nixos
      pkgs.mcp-obsidian
      (pkgs.writeScriptBin "restart-mcp-hub" ''
        #!/bin/sh
        exec launchctl kickstart -k "gui/$(id -u)/com.ravitemer.mcp-hub"
      '')
    ];

    xdg.configFile."mcpproxy/mcp_config.json" = {
      enable = true;
      text = builtins.toJSON renderedConfig;
    };

    launchd.agents.mcp-hub = {
      enable = true;
      config = {
        Label = "com.ravitemer.mcp-hub";
        ProgramArguments = [
          "${pkgs.mcp-hub}/bin/mcp-hub"
          "--port"
          "37373"
          "--config"
          "${config.xdg.configHome}/mcphub/servers.json"
          "--watch"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables.PATH =
          lib.makeBinPath [
            pkgs.unstable.google-cloud-sdk
            pkgs.git-lfs
          ]
          + ":/usr/bin:/bin";
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/mcp-hub.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/mcp-hub-error.log";
      };
    };
  };
}
