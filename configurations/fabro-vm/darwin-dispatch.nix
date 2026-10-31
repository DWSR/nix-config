# Darwin build dispatch for the fabro-vm guest
# (spec `mac-builder-for-fabro-nix-darwin-builds`, task 1.2; design
# "Component Contracts → Guest Dispatch → `fabro.darwinBuilder` module";
# requirements 1.1-1.3, 1.5-1.7, 2.7, 3.1-3.3, 3.6, 6.11, 7.5, 7.6).
#
# Fabro runs Nix inside sandboxes with `NIX_REMOTE=daemon`, so every build
# request ends at this guest's nix-daemon. This module makes that daemon the
# single dispatch client for `aarch64-darwin`: it enables distributed builds,
# points `nix.settings.builders` at a runtime-rendered machines file, and
# installs the oneshot unit that renders the file before the daemon starts.
#
# The machines file is rendered at boot rather than evaluated because the
# builder's pinned host key and the client key only exist after sops installs
# them. `nix.buildMachines` stays empty on purpose: nixpkgs would otherwise
# write an eval-time /etc/nix/machines, and the runtime renderer
# (scripts/fabro-darwin-machines.nix) is the only producer of the line. A
# renderer failure leaves an empty file and an unschedulable Darwin entry, but
# `nix-daemon.service` only *wants* the renderer, so local Linux builds keep
# working.
#
# Nothing here touches the sandbox mounts, the sandbox image environment, or
# the guest's own tailnet registration: every sandbox already reaches this
# daemon and uses its store, so no per-environment configuration is needed.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.darwinBuilder;

  renderer = import ../../scripts/fabro-darwin-machines.nix { inherit pkgs; };

  # sops-nix places a secret at /run/secrets/<name> by default. The guest
  # declares both build secrets in its sops store; the fallback keeps this
  # module evaluable on its own and resolves to the same runtime path.
  defaultClientKeyPath =
    config.sops.secrets."build-client-key".path or "/run/secrets/build-client-key";
  defaultHostKeyPath = config.sops.secrets."build-host-key".path or "/run/secrets/build-host-key";

  rendererCommand = lib.escapeShellArgs [
    "--output"
    cfg.machinesFile
    "--host-name"
    cfg.machine.hostName
    "--ssh-user"
    cfg.machine.sshUser
    "--system"
    cfg.machine.system
    "--max-jobs"
    (toString cfg.machine.maxJobs)
    "--speed-factor"
    (toString cfg.machine.speedFactor)
    "--client-key"
    cfg.clientKeyPath
    "--host-key"
    cfg.hostKeyPath
  ];
in
{
  options.fabro.darwinBuilder = {
    enable = lib.mkEnableOption ''
      `aarch64-darwin` build dispatch from the Fabro Guest's Nix daemon to the
      Builder Host
    '';

    machine = {
      hostName = lib.mkOption {
        type = lib.types.str;
        default = "mac-builder.tuxedo-musical.ts.net";
        description = ''
          The Builder Host's tailnet (MagicDNS) name. Build traffic must leave
          the guest as its own tailnet node and address the builder by this
          name, never through the LAN forward or a DHCP address.
        '';
      };

      sshUser = lib.mkOption {
        type = lib.types.str;
        default = "nix-builder";
        description = ''
          The Builder User the daemon authenticates as over ssh-ng.
        '';
      };

      system = lib.mkOption {
        type = lib.types.str;
        default = "aarch64-darwin";
        description = ''
          The only system scheduled on the Builder Host. A single Darwin entry
          means `aarch64-linux` requests never match it and stay local.
        '';
      };

      maxJobs = lib.mkOption {
        type = lib.types.int;
        default = 4;
        description = ''
          Number of concurrent build jobs the Builder Host accepts.
        '';
      };

      speedFactor = lib.mkOption {
        type = lib.types.int;
        default = 2;
        description = ''
          Relative speed of the Builder Host used by Nix's scheduler.
        '';
      };
    };

    clientKeyPath = lib.mkOption {
      type = lib.types.str;
      default = defaultClientKeyPath;
      defaultText = lib.literalExpression ''config.sops.secrets."build-client-key".path'';
      description = ''
        Root-only runtime path of the Build Client Key. The machines line
        references this path and never the key value.
      '';
    };

    hostKeyPath = lib.mkOption {
      type = lib.types.str;
      default = defaultHostKeyPath;
      defaultText = lib.literalExpression ''config.sops.secrets."build-host-key".path'';
      description = ''
        Runtime path of the pinned Builder Host public key. The renderer
        base64-encodes this file into the machines line, so the daemon refuses
        a builder whose host key does not match.
      '';
    };

    machinesFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/fabro-darwin-builders/machines";
      description = ''
        Runtime machines file selected by `nix.settings.builders`. It is
        created root-owned with mode 0600 and written atomically by
        `fabro-darwin-machines`.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # The daemon, not a wrapper, schedules and runs the build, so a connection
    # or rejection surfaces as Nix's own ssh-ng error naming the builder.
    nix.distributedBuilds = true;
    nix.settings = {
      builders = "@${cfg.machinesFile}";
      builders-use-substitutes = true;
    };

    systemd.services.fabro-darwin-builders = {
      description = "Render the Darwin build machines file for the Nix daemon";

      # The renderer reads the two sops-rendered secrets, so it must run after
      # secret installation and finish before the daemon reads the file.
      wants = [ "sops-install-secrets.service" ];
      after = [ "sops-install-secrets.service" ];
      before = [ "nix-daemon.service" ];

      serviceConfig = {
        Type = "oneshot";
        # Keep /run/fabro-darwin-builders (and the rendered file) for the
        # daemon's lifetime instead of removing it when the oneshot exits.
        RemainAfterExit = true;
        RuntimeDirectory = "fabro-darwin-builders";
        ExecStart = "${lib.getExe renderer} ${rendererCommand}";
      };
    };

    # `wants` (not `requires`): a failed renderer leaves Darwin builds
    # unschedulable but must not keep nix-daemon, and local Linux builds, down.
    systemd.services.nix-daemon = {
      wants = [ "fabro-darwin-builders.service" ];
      after = [ "fabro-darwin-builders.service" ];
    };

    # A readable, root-only file exists even before the renderer succeeds, so
    # the daemon never fails to open the configured builders path.
    systemd.tmpfiles.rules = [
      "f ${cfg.machinesFile} 0600 root root -"
    ];
  };
}
