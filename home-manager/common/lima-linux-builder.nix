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

  };
}
