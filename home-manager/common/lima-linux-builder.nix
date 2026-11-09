{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.virtualisation.limaLinuxBuilder;
  yamlFormat = pkgs.formats.yaml { };
  limaHome = "${config.xdg.stateHome}/lima";
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

  limaConfigYaml = yamlFormat.generate "lima-${cfg.name}.yaml" {
    images = [
      {
        location = "https://github.com/nixos-lima/nixos-lima/releases/download/v0.2.2/nixos-lima-v0.2.2-aarch64.qcow2";
        arch = "aarch64";
        digest = "sha512:bfcb703cdbad28cfd27438dc009408a859f3c4f575d3598d9627ea712c66128e0fa015de2010ce42bb724abc49f45029a4fc81891fb1a04c567378a6fdf31903";
      }
    ];

    vmType = "vz";

    inherit (cfg) cpus memory disk;

    mounts = [ ];

    containerd = {
      system = false;
      user = false;
    };

    portForwards = [
      {
        proto = "udp";
        guestPort = 68;
        guestIP = "0.0.0.0";
        ignore = true;
      }
    ];

    provision = [
      {
        mode = "system";
        script = ''
          #!/bin/sh
          echo ${lib.escapeShellArg cfg.hostname} >/proc/sys/kernel/hostname
        '';
      }
    ];
  };

  supervisor = pkgs.writeShellApplication {
    name = "${agentName}-supervisor";
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

  deploy = pkgs.writeShellApplication {
    name = "linux-builder-deploy";
    runtimeInputs = [
      pkgs.gnutar
      pkgs.gzip
      pkgs.openssh
    ];
    text = ''
      export LIMA_HOME=${lib.escapeShellArg limaHome}

      repo=''${1:-$PWD}
      name=${lib.escapeShellArg cfg.name}
      system=${lib.escapeShellArg cfg.guestSystem}
      sshConfig="$LIMA_HOME/$name/ssh.config"
      remoteHost="lima-$name"
      scratch=/tmp/linux-builder-deploy

      if [ ! -f "$repo/flake.nix" ] || [ ! -f "$repo/flake.lock" ]; then
        echo "linux-builder-deploy: $repo is not a locked flake (usage: linux-builder-deploy [REPO])" >&2
        exit 1
      fi
      if [ ! -f "$sshConfig" ]; then
        echo "linux-builder-deploy: no ssh config at $sshConfig; is the instance running? try: limactl start $name" >&2
        exit 1
      fi

      remote() {
        ssh -F "$sshConfig" "$remoteHost" "$@"
      }

      remote "rm -rf '$scratch' && mkdir -p '$scratch'"

      tar --exclude=.git --exclude=.direnv --exclude=result --exclude='result-*' \
        --exclude=.pre-commit-config.yaml \
        --exclude='*.aac' --exclude='*.mp4*' --exclude='*.mp3' \
        -cf - -C "$repo" . \
        | gzip \
        | remote "tar -xzf - -C '$scratch'"

      remote "nixos-rebuild switch --sudo --no-update-lock-file --flake '$scratch#$system'"
      echo "linux-builder-deploy: switched guest to '$system'; scratch tree left at $scratch."
    '';
  };
in
{
  options.virtualisation.limaLinuxBuilder = {
    enable = mkEnableOption "the separate NixOS Linux builder Lima instance";

    name = mkOption {
      type = types.str;
      default = "linux-builder";
      description = "Lima instance name for the Linux builder.";
    };

    hostname = mkOption {
      type = types.str;
      default = "linux-builder";
      description = "Hostname provisioned inside the Linux builder guest.";
    };

    guestSystem = mkOption {
      type = types.str;
      default = "linux-builder";
      description = "NixOS flake configuration deployed to the Linux builder guest.";
    };

    package = mkOption {
      type = types.package;
      default = pkgs.unstable.lima;
      defaultText = "pkgs.unstable.lima";
      description = "The Lima package providing limactl.";
    };

    cpus = mkOption {
      type = types.ints.positive;
      default = 4;
      description = "CPU allocation for the Linux builder Lima instance.";
    };

    memory = mkOption {
      type = types.str;
      default = "8GiB";
      description = "Memory allocation for the Linux builder Lima instance.";
    };

    disk = mkOption {
      type = types.str;
      default = "128GiB";
      description = "Disk allocation for the Linux builder Lima instance.";
    };

    _configYaml = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      default = if cfg.enable then limaConfigYaml else null;
      description = "Rendered Lima configuration for the Linux builder instance.";
    };

    _supervisor = mkOption {
      type = types.path;
      internal = true;
      readOnly = true;
      description = "Internal launchd supervisor for the Linux builder instance.";
    };

    _deploy = mkOption {
      type = types.path;
      internal = true;
      readOnly = true;
      description = "Internal deployment command for the Linux builder guest.";
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = cfg.name == "linux-builder";
        message = "virtualisation.limaLinuxBuilder.name must be linux-builder.";
      }
      {
        assertion = cfg.hostname == "linux-builder";
        message = "virtualisation.limaLinuxBuilder.hostname must be linux-builder.";
      }
      {
        assertion = cfg.guestSystem == "linux-builder";
        message = "virtualisation.limaLinuxBuilder.guestSystem must be linux-builder.";
      }
      {
        assertion = pkgs.stdenv.hostPlatform.isAarch64;
        message = "virtualisation.limaLinuxBuilder requires a native aarch64 host.";
      }
    ];

    virtualisation.limaLinuxBuilder = {
      _supervisor = supervisor;
      _deploy = deploy;
    };

    home.packages = [
      cfg.package
      cfg._deploy
    ];

    launchd.agents.${agentName} = {
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

    home.activation.limaLinuxBuilderDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p ${
        lib.escapeShellArgs [
          limaHome
          logDir
        ]
      }
    '';
  };
}
