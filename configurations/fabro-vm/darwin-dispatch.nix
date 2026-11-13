{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.darwinBuilder;
  renderer = import ../../scripts/fabro-darwin-machines.nix { inherit pkgs; };
  buildSmoke = import ../../scripts/fabro-darwin-build-smoke.nix {
    inherit pkgs;
    inherit (cfg) clientKeyPath hostKeyPath machinesFile;
    imageName = config.fabro.sandboxImage.name;
    digestFile = "/run/fabro-sandbox/digest";
    podman = "${pkgs.podman}/bin/podman";
  };
in
{
  options.fabro.darwinBuilder = {
    enable = lib.mkEnableOption "Fabro Darwin remote builder dispatch";
    machine = {
      hostName = lib.mkOption {
        type = lib.types.str;
        default = "mac-builder.tuxedo-musical.ts.net";
      };
      sshUser = lib.mkOption {
        type = lib.types.str;
        default = "nix-builder";
      };
      system = lib.mkOption {
        type = lib.types.str;
        default = "aarch64-darwin";
      };
      maxJobs = lib.mkOption {
        type = lib.types.int;
        default = 4;
      };
      speedFactor = lib.mkOption {
        type = lib.types.int;
        default = 2;
      };
    };
    linuxMachine = {
      hostName = lib.mkOption {
        type = lib.types.str;
        default = "linux-builder.tuxedo-musical.ts.net";
      };
      system = lib.mkOption {
        type = lib.types.str;
        default = "aarch64-linux";
      };
      maxJobs = lib.mkOption {
        type = lib.types.int;
        default = 4;
      };
    };
    clientKeyPath = lib.mkOption {
      type = lib.types.str;
      default = config.sops.secrets.build-client-key.path;
    };
    hostKeyPath = lib.mkOption {
      type = lib.types.str;
      default = config.sops.secrets.build-host-key.path;
    };
    linuxClientKeyPath = lib.mkOption {
      type = lib.types.str;
      default = config.sops.secrets.build-client-key.path;
    };
    linuxHostKeyPath = lib.mkOption {
      type = lib.types.str;
      default = "${toString ../..}/certificates/linux-builder/ssh_host_ed25519_key.pub";
      description = "Pinned public SSH host key used to validate the Linux builder endpoint.";
    };
    machinesFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/fabro-darwin-builders/machines";
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ buildSmoke ];
    nix.distributedBuilds = true;
    nix.settings = {
      builders = "@${cfg.machinesFile}";
      builders-use-substitutes = true;
      max-jobs = 0;
    };
    systemd.services.fabro-darwin-builders = {
      description = "Render the Fabro Darwin Nix builder configuration";
      after = [ "sops-install-secrets.service" ];
      wants = [ "sops-install-secrets.service" ];
      before = [ "nix-daemon.service" ];
      wantedBy = [ "multi-user.target" ];
      serviceConfig = {
        Type = "oneshot";
        RuntimeDirectory = "fabro-darwin-builders";
        RuntimeDirectoryPreserve = "yes";
        ExecStart = ''
          ${renderer}/bin/fabro-darwin-machines \
            --output ${lib.escapeShellArg cfg.machinesFile} \
            --host-name ${lib.escapeShellArg cfg.machine.hostName} \
            --ssh-user ${lib.escapeShellArg cfg.machine.sshUser} \
            --system ${lib.escapeShellArg cfg.machine.system} \
            --max-jobs ${toString cfg.machine.maxJobs} \
            --speed-factor ${toString cfg.machine.speedFactor} \
            --client-key ${lib.escapeShellArg cfg.clientKeyPath} \
            --host-key ${lib.escapeShellArg cfg.hostKeyPath} \
            --linux-host-name ${lib.escapeShellArg cfg.linuxMachine.hostName} \
            --linux-system ${lib.escapeShellArg cfg.linuxMachine.system} \
            --linux-max-jobs ${toString cfg.linuxMachine.maxJobs} \
            --linux-client-key ${lib.escapeShellArg cfg.linuxClientKeyPath} \
            --linux-host-key ${lib.escapeShellArg cfg.linuxHostKeyPath}
        '';
      };
    };
    systemd.services.nix-daemon = {
      wants = [ "fabro-darwin-builders.service" ];
      after = [ "fabro-darwin-builders.service" ];
    };
    systemd.tmpfiles.rules = [ "f ${cfg.machinesFile} 0600 root root - -" ];
  };
}
