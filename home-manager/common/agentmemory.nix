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
  memoryBackend =
    if config.home ? opencode && config.home.opencode ? memoryBackend then
      config.home.opencode.memoryBackend
    else
      "cavemem";
  isAgentMemory = memoryBackend == "agentmemory";
  statusPackage = pkgs.callPackage ../../scripts/agentmemory-status.nix {
    inherit (cfg)
      bearerReference
      dataDir
      enginePort
      logDir
      restPort
      streamPort
      viewerPort
      ;
    iiiRevision = cfg.package.iiiRevision or "unknown";
    opencodeBackend = memoryBackend;
    sourceRevision = cfg.package.sourceRevision or "unknown";
  };

  importPackage = pkgs.callPackage ../../scripts/agentmemory-import-cavemem.nix {
    inherit (cfg) bearerReference;
    restEndpoint = "http://127.0.0.1:${toString cfg.restPort}";
  };

  obsidianImportPackage = pkgs.callPackage ../../scripts/agentmemory-import-obsidian.nix {
    inherit (cfg) bearerReference;
    restEndpoint = "http://127.0.0.1:${toString cfg.restPort}";
  };

  envLine = name: value: "${name}=${lib.escapeShellArg (toString value)}";

  settingsText =
    lib.concatStringsSep "\n" [
      (envLine "AGENTMEMORY_DATA_DIR" cfg.dataDir)
      (envLine "AGENTMEMORY_RUNTIME_DIR" cfg.runtimeDir)
      (envLine "AGENTMEMORY_URL" "http://127.0.0.1:${toString cfg.restPort}")
      (envLine "AGENTMEMORY_VIEWER_URL" "http://127.0.0.1:${toString cfg.viewerPort}")
      (envLine "AGENTMEMORY_SECRET_REFERENCE" cfg.bearerReference)
      (envLine "AGENTMEMORY_TOOLS" "core")
      (envLine "AGENTMEMORY_BM25_MAX_ENTRIES" cfg.bm25MaxEntries)
      (envLine "AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES" cfg.bm25PersistMaxEntries)
      (envLine "III_REST_PORT" cfg.restPort)
      (envLine "III_STREAM_PORT" cfg.streamPort)
      (envLine "III_VIEWER_PORT" cfg.viewerPort)
      (envLine "III_ENGINE_PORT" cfg.enginePort)
    ]
    + "\n";

  agentmemoryLauncher = pkgs.writeShellApplication {
    name = "agentmemory";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      set -eu

      security_bin="''${AGENTMEMORY_SECURITY_BIN:-/usr/bin/security}"
      agentmemory_secret=$(${pkgs.coreutils}/bin/timeout --kill-after=2s 5s "$security_bin" find-generic-password -s mcpproxy -a ${lib.escapeShellArg cfg.bearerReference} -w 2>/dev/null) || agentmemory_secret=""
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
    enable = lib.mkEnableOption "AgentMemory runtime for OpenCode";

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

    bm25MaxEntries = mkOption {
      type = types.ints.positive;
      default = 100000;
      description = "Maximum observations retained in the in-memory BM25 index.";
    };

    bm25PersistMaxEntries = mkOption {
      type = types.ints.positive;
      default = 50000;
      description = "Maximum BM25 entries serialized for persistence.";
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

  };

  config = lib.mkIf (cfg.enable && options ? home) (
    {
      home = {
        packages = [
          agentmemoryLauncher
          cfg.statusPackage
          importPackage
          obsidianImportPackage
          (pkgs.callPackage ../../scripts/opencode-cache-validate.nix { })
        ];

        file."${cfg.runtimeDir}/.env".text = settingsText;

        activation.agentmemoryLogDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
          run mkdir -p "${cfg.logDir}"
        '';
      }
      // lib.optionalAttrs (options ? home && options.home ? mcp) {
        mcp.extraServers.agentmemory = {
          command = "${cfg.package}/bin/agentmemory-mcp";
          env = {
            AGENTMEMORY_URL = "http://127.0.0.1:${toString cfg.restPort}";
            AGENTMEMORY_TOOLS = "core";
            AGENTMEMORY_SECRET = config.home.mcp.readKeychainSecret cfg.bearerReference;
            AGENTMEMORY_BM25_MAX_ENTRIES = toString cfg.bm25MaxEntries;
            AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES = toString cfg.bm25PersistMaxEntries;
          };
        };
      };

      xdg.configFile = lib.mkIf isAgentMemory {
        "opencode/plugins/agentmemory-capture.ts".source =
          "${cfg.package}/lib/node_modules/@agentmemory/agentmemory/plugin/opencode/agentmemory-capture.ts";
      };

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
            AGENTMEMORY_BM25_MAX_ENTRIES = toString cfg.bm25MaxEntries;
            AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES = toString cfg.bm25PersistMaxEntries;
            III_REST_PORT = toString cfg.restPort;
            III_STREAM_PORT = toString cfg.streamPort;
            III_VIEWER_PORT = toString cfg.viewerPort;
            III_ENGINE_PORT = toString cfg.enginePort;
          };
          StandardOutPath = "${cfg.logDir}/agentmemory.log";
          StandardErrorPath = "${cfg.logDir}/agentmemory.error.log";
        };
      };
    }
    // lib.optionalAttrs (options ? assertions && options ? home && options.home ? mcp) {
      assertions = [
        {
          assertion = builtins.hasAttr cfg.bearerReference config.home.mcp.keychainSecrets;
          message = "programs.agentmemory.bearerReference must name a home.mcp.keychainSecrets entry.";
        }
      ];
    }
  );
}
