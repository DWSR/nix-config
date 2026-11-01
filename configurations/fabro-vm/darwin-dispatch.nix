# fabro.darwinBuilder: make the guest's nix-daemon the only client that
# dispatches `aarch64-darwin` builds to the builder host
# (mac-builder-for-fabro-nix-darwin-builds, task 1.2; design "Component
# Contracts → Guest Dispatch → `fabro.darwinBuilder` module"; requirements
# 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.7, 3.1, 3.2, 3.3, 3.6, 6.11, 7.5, 7.6).
#
# The machine entry cannot be rendered at evaluation time: the pinned builder
# host key only exists after the builder boots, and neither key may enter the
# Nix store. So the module declares only the path contract —
#
#   nix.distributedBuilds = true
#   nix.settings.builders = "@<machinesFile>"
#   nix.settings.builders-use-substitutes = true
#
# — and `systemd.services.fabro-darwin-builders` renders the single machines
# line at boot with scripts/fabro-darwin-machines.nix. `nix.buildMachines`
# stays empty, so nixpkgs generates no `/etc/nix/machines` from evaluation and
# the only entry is the rendered one.
#
# One entry, `machine.system = "aarch64-darwin"`, means `aarch64-linux`
# requests never match it and build locally. The daemon keeps Nix's own
# ssh-ng client and error reporting: nothing here wraps `nix`.
#
# The sandbox mounts and image environment (./sandbox.nix, ./sandbox-image.nix)
# and the guest's tailnet registration (./tailscale.nix) are deliberately
# untouched, so every sandbox keeps using this daemon without per-environment
# configuration.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.darwinBuilder;

  # Only the renderer reads the two secrets' contents; the module passes paths
  # and plain machine attributes, never key material.
  renderer = pkgs.callPackage ../../scripts/fabro-darwin-machines.nix { };

  # sops-nix materialises each secret at `/run/secrets/<name>` unless its
  # declaration overrides `path`. Follow the declaration when it exists (task
  # 1.3 declares both on this host) and fall back to sops-nix's default path so
  # the module still evaluates when the declarations are absent.
  sopsSecrets = config.sops.secrets or { };
  secretPath =
    name: if sopsSecrets ? ${name} then sopsSecrets.${name}.path else "/run/secrets/${name}";
in
{
  options.fabro.darwinBuilder = {
    enable = lib.mkEnableOption "dispatch of aarch64-darwin builds from the guest nix-daemon to the builder host";

    machine = {
      hostName = lib.mkOption {
        type = lib.types.str;
        default = "mac-builder.tuxedo-musical.ts.net";
        description = ''
          Builder Host tailnet name (MagicDNS FQDN) the daemon dials. Never a
          LAN forward or a DHCP address.
        '';
      };

      sshUser = lib.mkOption {
        type = lib.types.str;
        default = "nix-builder";
        description = ''
          Builder Host user the ssh-ng session runs as.
        '';
      };

      system = lib.mkOption {
        type = lib.types.str;
        default = "aarch64-darwin";
        description = ''
          The only system scheduled on the builder, so `aarch64-linux`
          requests stay local.
        '';
      };

      maxJobs = lib.mkOption {
        type = lib.types.int;
        default = 4;
        description = ''
          Concurrent build jobs the builder accepts.
        '';
      };

      speedFactor = lib.mkOption {
        type = lib.types.int;
        default = 2;
        description = ''
          Relative builder speed passed to the daemon.
        '';
      };
    };

    clientKeyPath = lib.mkOption {
      type = lib.types.str;
      default = secretPath "build-client-key";
      defaultText = lib.literalExpression ''config.sops.secrets."build-client-key".path'';
      description = ''
        Path of the private Build Client Key, referenced in the machines line
        by path only. The key value never enters the Nix store or the line.
      '';
    };

    hostKeyPath = lib.mkOption {
      type = lib.types.str;
      default = secretPath "build-host-key";
      defaultText = lib.literalExpression ''config.sops.secrets."build-host-key".path'';
      description = ''
        Path of the pinned Builder Host public key the renderer base64-encodes
        into the machines line.
      '';
    };

    machinesFile = lib.mkOption {
      type = lib.types.str;
      default = "/run/fabro-darwin-builders/machines";
      description = ''
        Runtime machines file selected by `nix.settings.builders`. It lives
        outside the Nix store and `/etc`, so no secret-bearing line can be
        captured by evaluation.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # The daemon, not the sandbox or any wrapper, is the build client. The
    # `@<path>` form makes it re-read the rendered line; `buildMachines` stays
    # empty so nixpkgs emits no evaluation-time /etc/nix/machines.
    nix.distributedBuilds = true;
    nix.settings = {
      builders = "@${cfg.machinesFile}";
      # Let the builder substitute its own inputs instead of uploading them
      # from the guest (requirements 7.5, 7.6).
      builders-use-substitutes = true;
    };

    systemd.services.fabro-darwin-builders = {
      description = "Render the Darwin build machines file for the nix-daemon";

      # sops-install-secrets materialises both secrets before this unit runs.
      # A failed renderer must not block the daemon, so this is `wants`, not
      # `requires`, and `nix-daemon` keeps `wants`/`after` without `requires`.
      after = [ "sops-install-secrets.service" ];
      wants = [ "sops-install-secrets.service" ];
      before = [ "nix-daemon.service" ];

      serviceConfig = {
        Type = "oneshot";
        RemainAfterExit = true;
        RuntimeDirectory = "fabro-darwin-builders";
        ExecStart = "${lib.getExe renderer} ${
          lib.escapeShellArgs [
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
          ]
        }";
      };
      # No `wantedBy`: `nix-daemon` wants this unit, so it starts exactly when
      # the daemon does.
    };

    systemd.services.nix-daemon = {
      wants = [ "fabro-darwin-builders.service" ];
      after = [ "fabro-darwin-builders.service" ];
    };

    # The daemon reads `builders` at start. This fallback file keeps that read
    # well-defined (an empty file means "no builder") even before the renderer
    # succeeds; the renderer replaces it atomically at mode 0600.
    systemd.tmpfiles.rules = [
      "f ${cfg.machinesFile} 0600 root root -"
    ];
  };
}
