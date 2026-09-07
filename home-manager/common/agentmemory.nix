{
  config,
  lib,
  options,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;

  cfg = config.programs.agentmemory;

  statusPackage = pkgs.callPackage ../../scripts/agentmemory-status.nix {
    inherit (cfg)
      dataDir
      enginePort
      logDir
      restPort
      streamPort
      viewerPort
      ;
    iiiRevision = cfg.package.iiiRevision or "unknown";
    sourceRevision = cfg.package.sourceRevision or "unknown";
  };

  envLine = name: value: "${name}=${lib.escapeShellArg (toString value)}";

  settingsText =
    lib.concatStringsSep "\n" (
      [
        (envLine "AGENTMEMORY_DATA_DIR" cfg.dataDir)
        (envLine "AGENTMEMORY_RUNTIME_DIR" cfg.runtimeDir)
        (envLine "AGENTMEMORY_URL" "http://127.0.0.1:${toString cfg.restPort}")
        (envLine "AGENTMEMORY_VIEWER_URL" "http://127.0.0.1:${toString cfg.viewerPort}")
        (envLine "AGENTMEMORY_SECRET_REFERENCE" cfg.bearerReference)
        (envLine "AGENTMEMORY_TOOLS" "core")
        (envLine "III_REST_PORT" cfg.restPort)
        (envLine "III_STREAM_PORT" cfg.streamPort)
        (envLine "III_VIEWER_PORT" cfg.viewerPort)
        (envLine "III_ENGINE_PORT" cfg.enginePort)
      ]
      ++ lib.optional (cfg.backupDestination != null) (
        envLine "AGENTMEMORY_BACKUP_DESTINATION" cfg.backupDestination
      )
    )
    + "\n";

  agentmemoryLauncher = pkgs.writeShellApplication {
    name = "agentmemory";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -eu

      agentmemory_secret=$(${pkgs.coreutils}/bin/timeout --kill-after=2s 5s /usr/bin/security find-generic-password -s mcpproxy -a ${lib.escapeShellArg cfg.bearerReference} -w 2>/dev/null) || agentmemory_secret=""
      if [ -z "$agentmemory_secret" ]; then
        echo "ERROR: AgentMemory bearer unavailable from macOS Keychain; daemon not started." >&2
        echo "Recover AgentMemory with: launchctl kickstart -k gui/$(id -u)/dev.dwsr.agentmemory" >&2
        exit 1
      fi

      export AGENTMEMORY_SECRET="$agentmemory_secret"
      exec ${cfg.package}/bin/agentmemory "$@"
    '';
  };
in
{
  options.programs.agentmemory = {
    enable = lib.mkEnableOption "AgentMemory runtime for the OpenCode harness";

    package = mkOption {
      type = types.package;
      readOnly = true;
      default = pkgs.agentmemory;
      description = "Pinned AgentMemory runtime package.";
    };

    statusPackage = mkOption {
      type = types.package;
      readOnly = true;
      default = statusPackage;
      description = "Redacted AgentMemory daemon health and status command.";
    };

    dataDir = mkOption {
      type = types.path;
      default = "${config.xdg.dataHome}/agentmemory";
      defaultText = lib.literalExpression ''"''${config.xdg.dataHome}/agentmemory"'';
      description = "Managed AgentMemory data directory.";
    };

    runtimeDir = mkOption {
      type = types.path;
      default = "${config.home.homeDirectory}/.agentmemory";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/.agentmemory"'';
      description = "Managed AgentMemory runtime and settings directory.";
    };

    logDir = mkOption {
      type = types.path;
      default = "${config.home.homeDirectory}/Library/Logs/agentmemory";
      defaultText = lib.literalExpression ''"''${config.home.homeDirectory}/Library/Logs/agentmemory"'';
      description = "Managed AgentMemory launchd log directory.";
    };

    restPort = mkOption {
      type = types.port;
      default = 3111;
      description = "Loopback REST and MCP HTTP port.";
    };

    streamPort = mkOption {
      type = types.port;
      default = 3112;
      description = "Loopback iii stream port.";
    };

    viewerPort = mkOption {
      type = types.port;
      default = 3113;
      description = "Loopback AgentMemory viewer port.";
    };

    enginePort = mkOption {
      type = types.port;
      default = 49134;
      description = "Loopback iii engine WebSocket port.";
    };

    bearerReference = mkOption {
      type = types.str;
      default = "agentmemory-bearer";
      description = ''
        Runtime reference for the AgentMemory bearer. This is a secret
        reference, not the bearer value; later integration layers resolve it
        through the existing Keychain secret plumbing.
      '';
    };

    backupDestination = mkOption {
      type = types.nullOr types.path;
      default = null;
      description = "Optional destination for the later stopped-runtime backup command.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = lib.optional (options.home ? mcp) {
      assertion = builtins.hasAttr cfg.bearerReference config.home.mcp.keychainSecrets;
      message = "programs.agentmemory.bearerReference must name a home.mcp.keychainSecrets entry.";
    };

    home = {
      packages = [
        cfg.package
        cfg.statusPackage
      ];

      file."${cfg.runtimeDir}/.env".text = settingsText;

      activation.agentmemoryLogDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        run mkdir -p "${cfg.logDir}"
      '';
    }
    // lib.optionalAttrs (options.home ? mcp) {
      mcp.extraServers.agentmemory = {
        command = "${cfg.package}/bin/agentmemory-mcp";
        env = {
          AGENTMEMORY_URL = "http://127.0.0.1:${toString cfg.restPort}";
          AGENTMEMORY_TOOLS = "core";
          AGENTMEMORY_SECRET = config.home.mcp.readKeychainSecret cfg.bearerReference;
        };
      };
    };

    xdg.configFile."opencode/plugins/agentmemory-capture.ts".source =
      "${cfg.package}/lib/node_modules/@agentmemory/agentmemory/plugin/opencode/agentmemory-capture.ts";

    launchd.agents.agentmemory = {
      enable = true;
      config = {
        Label = "dev.dwsr.agentmemory";
        ProgramArguments = [ "${agentmemoryLauncher}/bin/agentmemory" ];
        RunAtLoad = true;
        KeepAlive = true;
        WorkingDirectory = cfg.runtimeDir;
        EnvironmentVariables = {
          AGENTMEMORY_DATA_DIR = toString cfg.dataDir;
          AGENTMEMORY_RUNTIME_DIR = toString cfg.runtimeDir;
          AGENTMEMORY_SECRET_REFERENCE = cfg.bearerReference;
          AGENTMEMORY_TOOLS = "core";
          III_REST_PORT = toString cfg.restPort;
          III_STREAM_PORT = toString cfg.streamPort;
          III_VIEWER_PORT = toString cfg.viewerPort;
          III_ENGINE_PORT = toString cfg.enginePort;
        };
        StandardOutPath = "${cfg.logDir}/agentmemory.log";
        StandardErrorPath = "${cfg.logDir}/agentmemory.error.log";
      };
    };
  };
}
