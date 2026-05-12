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

  # Generate a ${cmd:} string that reads a secret from the macOS Keychain at runtime.
  # Works in launchd environments where op CLI is not available.
  #
  # The Keychain entries this string reads are populated at activation time
  # by the sops-nix bridge (see configurations/common-darwin/mcp-sops-bridge.nix
  # and scripts/mcp-secrets-activate.nix). The string shape is preserved
  # verbatim from the prior implementation so existing mcphub server
  # definitions don't need to change (R7.1, R7.2).
  readKeychainSecret =
    service: "\${cmd: /usr/bin/security find-generic-password -s '${service}' -a mcp-hub -w}";
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
      description = "Additional MCP servers to add to mcphub configuration";
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

    enable = lib.mkEnableOption "MCP hub configuration" // {
      default = true;
    };
  };

  options.home.mcp.readKeychainSecret = lib.mkOption {
    type = lib.types.raw;
    default = readKeychainSecret;
    readOnly = true;
    description = "Function that generates a mcphub cmd string to read a secret from the macOS Keychain";
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

    xdg.configFile."mcphub/servers.json" = {
      enable = true;
      text = builtins.toJSON {
        servers = {
          nixos = {
            command = "${pkgs.mcp-nixos}/bin/mcp-nixos";
            args = [ "--" ];
          };

          github = {
            command = "${pkgs.github-mcp-server}/bin/github-mcp-server";
            args = [
              "stdio"
              "--toolsets=all"
            ];
            env.GITHUB_PERSONAL_ACCESS_TOKEN = githubToken;
          };

          obsidian = {
            command = "${pkgs.mcp-obsidian}/bin/mcp-obsidian";
            args = [ config.home.mcp.obsidianVaultPath ];
          };

        }
        // config.home.mcp.extraServers;
      };
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
