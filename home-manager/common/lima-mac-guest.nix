{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.virtualisation.limaMacGuest;

  nativeArch = if pkgs.stdenv.hostPlatform.isAarch64 then "aarch64" else "x86_64";

  yamlFormat = pkgs.formats.yaml { };

  limaYaml = {
    minimumLimaVersion = "2.3.0";
    os = "Darwin";
    arch = "aarch64";
    vmType = "vz";

    images = [
      (
        {
          inherit (cfg.image) location arch;
        }
        // lib.optionalAttrs (cfg.image.digest != null) {
          inherit (cfg.image) digest;
        }
      )
    ];

    video = {
      display = "default";
    };

    mounts = [ ];

    osOpts = {
      Darwin = {
        inherit (cfg) suppressFirstLoginSetup;
      };
    };

    inherit (cfg)
      cpus
      memory
      disk
      ;
  }
  // cfg.extraLimaConfig;

  limaConfigYaml = yamlFormat.generate "lima-${cfg.name}.yaml" limaYaml;

  inherit (cfg) limaHome;
  logDir = "${config.home.homeDirectory}/Library/Logs/lima-vm";
  agentName = "lima-${cfg.name}";

  servicePath = lib.concatStringsSep ":" [
    (lib.makeBinPath [
      cfg.package
      pkgs.openssh
    ])
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  ];

  supervisor = pkgs.writeShellApplication {
    name = "lima-${cfg.name}-supervisor";
    runtimeInputs = [
      cfg.package
      pkgs.openssh
    ];
    text = ''
      export LIMA_HOME=${lib.escapeShellArg limaHome}

      name=${lib.escapeShellArg cfg.name}
      config=${lib.escapeShellArg limaConfigYaml}

      if ! limactl list --json "$name" >/dev/null 2>&1; then
        limactl --tty=false create --name="$name" "$config"
      fi

      exec limactl --tty=false start --foreground "$name"
    '';
  };

  forwardAgentName = "lima-${cfg.name}-forward";

  forward = pkgs.writeShellApplication {
    name = "lima-${cfg.name}-forward";
    runtimeInputs = [
      pkgs.openssh
    ];
    text = ''
      export LIMA_HOME=${lib.escapeShellArg limaHome}

      exec ssh -F "$LIMA_HOME/${cfg.name}/ssh.config" -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L ${lib.escapeShellArg cfg.forward.bindAddress}:${toString cfg.forward.port}:127.0.0.1:22 lima-${cfg.name}
    '';
  };

  deployScript = pkgs.callPackage ../../scripts/mac-builder-deploy.nix { };
in
{
  options.virtualisation.limaMacGuest = {
    enable = mkEnableOption "the macOS Lima guest for the mac-builder";

    name = mkOption {
      type = types.str;
      default = "mac-builder";
      description = ''
        Lima instance name. Must be valid for `limactl` (lowercase
        alphanumeric plus `-`, `_`, and `.` separators, no leading or
        trailing separator); enforced with an assertion.
      '';
    };

    package = mkOption {
      type = types.package;
      default = pkgs.unstable.lima;
      defaultText = "pkgs.unstable.lima";
      description = ''
        The lima package providing `limactl`. Must be Lima >= 2.3 for
        macOS guests.
      '';
    };

    limaHome = mkOption {
      type = types.str;
      default = "${config.xdg.stateHome}/lima";
      defaultText = lib.literalExpression ''"''${config.xdg.stateHome}/lima"'';
      description = ''
        Shared LIMA_HOME for the managed macOS guest instance.
      '';
    };

    image = mkOption {
      description = ''
        The macOS guest boot image (pinned Apple `.ipsw`).
      '';
      type = types.submodule {
        options = {
          location = mkOption {
            type = types.str;
            default = "https://updates.cdn-apple.com/2026FallFCS/59241290-5d51-4ca8-9df4-31624b9a4eac/UniversalMac_27.0.1_26A434_Restore.ipsw";
            description = "Image URL or local file path passed as `images[0].location`.";
          };

          digest = mkOption {
            type = types.nullOr types.str;
            default = "sha256:2f016638293c3e641b8b25391a76fbc16563b3711915a5551cf8aa0f5598a5c1";
            description = ''
              Digest for `images[0].digest` (`sha256:` prefix). Null skips
              verification.
            '';
          };

          arch = mkOption {
            type = types.enum [
              "aarch64"
              "x86_64"
            ];
            default = "aarch64";
            defaultText = "aarch64";
            description = "Guest architecture for `images[0].arch`.";
          };
        };
      };
    };

    cpus = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "Lima `cpus`.";
    };

    memory = mkOption {
      type = types.str;
      default = "8GiB";
      description = "Lima `memory`.";
    };

    disk = mkOption {
      type = types.str;
      default = "64GiB";
      description = "Lima `disk` (root disk size).";
    };

    suppressFirstLoginSetup = mkOption {
      type = types.bool;
      default = true;
      description = ''
        Set `osOpts.Darwin.suppressFirstLoginSetup` to skip the macOS
        First Run Experience.
      '';
    };

    extraLimaConfig = mkOption {
      inherit (yamlFormat) type;
      default = { };
      description = ''
        Freeform Lima YAML configuration merged over the module-rendered
        root keys.
      '';
    };

    forward = mkOption {
      description = "Host-side SSH forward exposing the guest sshd.";
      type = types.submodule {
        options = {
          enable = mkOption {
            type = types.bool;
            default = true;
            description = "Enable the host-side SSH forward launchd agent.";
          };

          bindAddress = mkOption {
            type = types.str;
            default = "127.0.0.1";
            description = "Address the forward binds on the host.";
          };

          port = mkOption {
            type = types.port;
            default = 2222;
            description = "Host port the forward binds.";
          };
        };
      };
    };

    deploy = mkOption {
      description = "Deploy/bootstrap wiring for the builder host.";
      type = types.submodule {
        options = {
          enable = mkOption {
            type = types.bool;
            default = false;
            description = "Enable deploy wiring.";
          };

          hostName = mkOption {
            type = types.str;
            default = "";
            description = "Builder host name used by deploy.";
          };

          ageKeySecretRef = mkOption {
            type = types.str;
            default = "";
            description = "1Password reference for the builder age key.";
          };
        };
      };
    };

    _configYaml = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal rendered Lima YAML. Null when disabled.";
    };

    _supervisor = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal supervisor script. Null when disabled.";
    };

    _forward = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal forward script/agent. Null when disabled.";
    };

    _deploy = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal deploy script. Null when disabled.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isDarwin;
        message = "virtualisation.limaMacGuest manages the guest through a launchd agent and is darwin-only.";
      }
      {
        assertion = builtins.match "[a-zA-Z0-9]+([-._][a-zA-Z0-9]+)*" cfg.name != null;
        message = "virtualisation.limaMacGuest.name must be a valid lima instance name (alphanumeric with - . _ separators).";
      }
      {
        assertion = cfg.image.arch == nativeArch;
        message = "virtualisation.limaMacGuest: the VZ driver requires a native-architecture guest (image.arch \"${cfg.image.arch}\" on ${nativeArch}).";
      }
    ];

    virtualisation.limaMacGuest = {
      _configYaml = limaConfigYaml;
      _supervisor = supervisor;
      _forward = if cfg.forward.enable then forward else null;
      _deploy = if cfg.deploy.enable then deployScript else null;
    };

    home.packages = lib.optional (cfg._deploy != null) cfg._deploy;

    launchd.agents = {
      ${agentName} = {
        enable = true;
        config = {
          Label = "dev.dwsr.${agentName}";
          ProgramArguments = [ (lib.getExe supervisor) ];
          RunAtLoad = true;
          KeepAlive = {
            SuccessfulExit = false;
          };
          ProcessType = "Background";
          EnvironmentVariables = {
            LIMA_HOME = limaHome;
            HOME = config.home.homeDirectory;
            PATH = servicePath;
          };
          StandardOutPath = "${logDir}/${agentName}.log";
          StandardErrorPath = "${logDir}/${agentName}.error.log";
        };
      };
    }
    // lib.optionalAttrs cfg.forward.enable {
      ${forwardAgentName} = {
        enable = true;
        config = {
          Label = "dev.dwsr.${forwardAgentName}";
          ProgramArguments = [ (lib.getExe forward) ];
          RunAtLoad = true;
          KeepAlive = true;
          ProcessType = "Background";
          EnvironmentVariables = {
            LIMA_HOME = limaHome;
            HOME = config.home.homeDirectory;
            PATH = servicePath;
          };
          StandardOutPath = "${logDir}/${forwardAgentName}.log";
          StandardErrorPath = "${logDir}/${forwardAgentName}.error.log";
        };
      };
    };

    home.activation.limaMacGuestDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p ${
        lib.escapeShellArgs [
          limaHome
          logDir
        ]
      }
    '';
  };

}
