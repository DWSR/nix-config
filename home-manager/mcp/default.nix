{ pkgs, lib, config, ... }:
let
  githubToken = if config.home.mcp.githubToken == null
    then builtins.throw "home.mcp.githubToken must be set"
    else config.home.mcp.githubToken;

  # Generate a ${cmd:} string that reads a secret from the macOS Keychain at runtime.
  # Works in launchd environments where op CLI is not available.
  readKeychainSecret = service:
    "\${cmd: /usr/bin/security find-generic-password -s '${service}' -a mcp-hub -w}";

  # Script that copies secrets from 1Password to the macOS Keychain
  mcpSyncSecretsScript = pkgs.writeScriptBin "mcp-sync-secrets" (
    ''
      #!/bin/sh
      set -eu
    '' + lib.concatStringsSep "\n" (
      lib.mapAttrsToList (service: opUri: ''
        echo "Storing keychain secret: ${service}"
        __secret="$(${pkgs._1password-cli}/bin/op read --no-newline '${opUri}')"
        /usr/bin/security add-generic-password -U -s '${service}' -a mcp-hub -w "$__secret" login.keychain-db 2>/dev/null || \
        /usr/bin/security add-generic-password -s '${service}' -a mcp-hub -w "$__secret" login.keychain-db
        unset __secret
      '') config.home.mcp.keychainSecrets
    ) + ''
      echo "Done. All MCP secrets synced to keychain."
    ''
  );
in
{
  options.home.mcp = {
    githubToken = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      description = "GitHub personal access token for MCP server";
    };

    extraServers = lib.mkOption {
      type = lib.types.attrsOf lib.types.attrs;
      default = {};
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
      default = {};
      description = "Map of keychain service names to 1Password URIs. Secrets are read from op during activation and stored in the macOS Keychain for runtime access.";
      example = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
      };
    };

    enable = lib.mkEnableOption "MCP hub configuration" // { default = true; };
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
      (pkgs.writeScriptBin "restart-mcp-hub" ''
        #!/bin/sh
        exec launchctl kickstart -k "gui/$(id -u)/com.ravitemer.mcp-hub"
      '')
    ] ++ lib.optional (config.home.mcp.keychainSecrets != {}) mcpSyncSecretsScript;

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


        } // config.home.mcp.extraServers;
      };
    };

    home.activation.mcpKeychainSecrets = lib.mkIf (config.home.mcp.keychainSecrets != {}) (
      lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        echo "MCP secrets may need refreshing. Run 'mcp-sync-secrets' if MCP servers fail to authenticate."
      ''
    );

    launchd.agents.mcp-hub = {
      enable = true;
      config = {
        Label = "com.ravitemer.mcp-hub";
        ProgramArguments = [
          "${pkgs.mcp-hub}/bin/mcp-hub"
          "--port" "37373"
          "--config" "${config.xdg.configHome}/mcphub/servers.json"
          "--watch"
        ];
        RunAtLoad = true;
        KeepAlive = true;
        EnvironmentVariables.PATH = lib.makeBinPath [
          pkgs.unstable.google-cloud-sdk
          pkgs.git-lfs
        ] + ":/usr/bin:/bin";
        StandardOutPath = "/tmp/mcp-hub.log";
        StandardErrorPath = "/tmp/mcp-hub.error.log";
      };
    };
  };
}
