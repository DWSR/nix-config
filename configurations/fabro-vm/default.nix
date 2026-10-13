# NixOS guest configuration for the fabro Lima VM
# (flake output `nixosConfigurations.fabro-vm`, image
# `packages.aarch64-linux.fabro-vm-image`).
#
# Mirrors upstream nixos-lima's lima.nix base (qcow-efi layout, lima-init +
# guestagent, passwordless-sudo wheel user created from Lima's cidata) with
# the repo's flake nixpkgs instead of the upstream release pin. The VM the
# personal host boots today is the pinned upstream RELEASE image
# (home-manager/common/lima-vm.nix `image` default); this configuration
# matters once a Linux builder exists to build a custom image (then switch
# the module's `image.location` to the store path) or for remote deployment
# into the running instance (`nixos-rebuild --target`). The guest runs
# Docker plus the fabro and LiteLLM services, with their secrets from
# sops-nix (`sops` block below), and joins the tailnet as a Tailscale
# Services host advertising both applications (./tailscale.nix).
{
  config,
  lib,
  modulesPath,
  pkgs,
  ...
}:
let
  # Keys in `fabro.onePasswordSecrets` that have no matching entry in
  # `config.sops.secrets` — hits the assertions block in config.
  onePasswordUndeclared = lib.filter (name: !config.sops.secrets ? "${name}") (
    lib.attrNames config.fabro.onePasswordSecrets
  );
in
{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    # `system.build.qcow-efi` for packages.aarch64-linux.fabro-vm-image
    # (grows the root partition into the Lima-assigned disk size).
    ./image.nix
    # The host's two application services; Docker is enabled below.
    ./fabro.nix
    ./litellm.nix
    # Tailnet registration (OAuth credential auth key) and advertisement
    # of the fabro and litellm services (svc:fabro / svc:litellm).
    ./tailscale.nix
  ];

  # 1Password source manifest for the guest's sops store
  # (secrets/fabro.fabro.yaml): each entry maps a `sops.secrets` name to
  # the 1Password item field it is mirrored from. Nothing on the guest
  # reads this option at runtime — sops-nix deploys the decrypted store —
  # it is evaluated by `nix run '.#fabro-sync-from-1password'` (see
  # scripts/fabro-sync-from-1password.nix), which `op read`s every URI
  # and rewrites the encrypted store. Keys declared in `sops.secrets`
  # without an entry here are carried forward from the prior store by
  # that sync instead. Editing a URI here takes effect on the next sync
  # run without rebuilding anything.
  options.fabro.onePasswordSecrets = lib.mkOption {
    type = lib.types.attrsOf lib.types.str;
    default = { };
    description = ''
      Map of sops secret name to the 1Password URI its value is mirrored
      from, consumed by the fabro-sync-from-1password helper.
    '';
  };

  config = {
    # lima-init reconfigures the system from Lima's cidata userdata at boot
    # (user, SSH keys, mounts) and runs the lima-guestagent daemon as a
    # systemd service.
    services.lima.enable = true;

    fabro.onePasswordSecrets = {
      "fabro-session-secret" = "op://Private/Fabro/Session Secret";
      "fabro-dev-token" = "op://Private/Fabro/Dev Token";
      "litellm-master-key" = "op://Private/LiteLLM/Master Key";
      "opencode-api-key" = "op://Private/OpenCode/API Key";
      # The fabro host's GitHub PAT (the `Tokens` section of the `GitHub`
      # item holds one field per host). See the github-token entry in
      # sops.secrets below.
      "github-token" = "op://Private/GitHub/Tokens/Fabro";
      "tailscale-oauth-secret" = "op://Infrastructure/Fabro Host Tailscale Credentials/Client Secret";
    };

    # Keep the sync manifest honest: every URI-mapped key must be
    # declared (an undeclared entry would sync a value the guest never
    # deploys).
    assertions = [
      {
        assertion = onePasswordUndeclared == [ ];
        message =
          "fabro.onePasswordSecrets entries without a matching sops.secrets declaration: "
          + lib.concatStringsSep ", " onePasswordUndeclared;
      }
    ];

    # Encrypted store (secrets/fabro.fabro.yaml, recipient `&host_fabro`).
    # The guest's age private key lives outside the repo at
    # /var/lib/sops-nix/key.txt (installed during bootstrap; private copy
    # in the Private vault as `sops-age-key-fabro` — see
    # secrets/README.md). Decryption happens in system activation, before
    # normal units start, so the application services read the rendered
    # env files at systemd start without secrets entering the Nix store.
    sops = {
      defaultSopsFile = ../../secrets/fabro.fabro.yaml;

      # Single key source: the age file. Disable the SSH-host-key and GPG
      # probes so decryption only ever uses /var/lib/sops-nix/key.txt.
      age = {
        keyFile = "/var/lib/sops-nix/key.txt";
        sshKeyPaths = [ ];
      };
      gnupg.sshKeyPaths = [ ];

      secrets = {
        fabro-session-secret = { };
        fabro-dev-token = { };
        litellm-master-key = { };
        opencode-api-key = { };
        # OAuth client secret (`tskey-client-…`) consumed as the
        # services.tailscale auth key (tailscale.nix: authKeyFile). Source:
        # op://Infrastructure/Fabro Host Tailscale Credentials/Client
        # Secret.
        tailscale-oauth-secret = { };

        # The fabro host's GitHub PAT (source: op://Private/GitHub/Tokens/
        # Fabro, mirrored by fabro-sync-from-1password). Deployed to
        # /run/secrets/github-token (root, 0400); no guest consumer is
        # wired to it yet — the surface is there for git/nix access-token
        # wiring on the fabro host.
        github-token = { };
      };

      # systemd EnvironmentFiles the services consume (fabro.nix and
      # litellm.nix reference config.sops.templates.<name>.path):
      #   * fabro-env — the dev-token auth pair fabro REQUIRES (dev-token
      #     start refuses to run without SESSION_SECRET + FABRO_DEV_TOKEN).
      #   * litellm-env — LITELLM_MASTER_KEY, which litellm honours as the
      #     proxy master key, and OPENCODE_API_KEY, which the opencode-*
      #     deployments resolve via `os.environ/OPENCODE_API_KEY` (the
      #     same env-var shape the mac launchd wrapper exported; no secret
      #     lands in the config in the store).
      #
      # Each template restarts its consumer when the rendered value
      # changes: systemd does not track EnvironmentFile contents, so
      # without restartUnits a rotated secret is only picked up after the
      # next manual restart or reboot.
      templates = {
        "fabro-env" = {
          restartUnits = [ "fabro.service" ];
          content = ''
            SESSION_SECRET=${config.sops.placeholder.fabro-session-secret}
            FABRO_DEV_TOKEN=${config.sops.placeholder.fabro-dev-token}
          '';
        };

        "litellm-env" = {
          restartUnits = [ "litellm.service" ];
          content = ''
            LITELLM_MASTER_KEY=${config.sops.placeholder.litellm-master-key}
            OPENCODE_API_KEY=${config.sops.placeholder.opencode-api-key}
          '';
        };
      };
    };

    # Guest hostname, matching home-manager/common/lima-vm.nix's
    # `hostname` provision (which covers the upstream release image until
    # this configuration can be built into a custom image / deployed).
    networking.hostName = "fabro";

    # Docker: the only service the fabro host runs right now (fabro itself
    # is pending). NixOS's Docker module manages its own systemd unit,
    # bridge/overlay kernel module loading, and nftables compat. The
    # docker group membership for the cidata user is granted by the Lima
    # module's `provision`, because lima-init creates that user
    # imperatively on each boot and users.users must not declare it
    # (mutableUsers stays true so rebuilds preserve it).
    virtualisation.docker.enable = true;

    # ssh
    services.openssh.enable = true;

    # Lima provisioning scripts run as the cidata user via passwordless sudo.
    security.sudo.wheelNeedsPassword = false;

    # lima-init imperatively adds the user at startup; `users.mutableUsers`
    # must stay true or a `nixos-rebuild` would overwrite that user and break
    # login (upstream documents the same requirement).
    users.mutableUsers = true;

    # Remote deployment into the instance's nix store.
    nix.settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      trusted-users = [ "@wheel" ];
    };

    # qcow-efi disk layout: ESP on vda1, root labeled nixos, grown to the
    # Lima `disk` size by autoResize on first boot.
    boot = {
      kernelParams = [ "console=tty0" ];
      kernelPackages = pkgs.linuxPackages_latest;
      loader.grub = {
        device = "nodev";
        efiSupport = true;
        efiInstallAsRemovable = true;
      };
    };
    fileSystems."/boot" = {
      device = lib.mkForce "/dev/vda1"; # /dev/disk/by-label/ESP
      fsType = "vfat";
    };
    fileSystems."/" = {
      device = "/dev/disk/by-label/nixos";
      autoResize = true;
      fsType = "ext4";
      options = [
        "noatime"
        "nodiratime"
        "discard"
      ];
    };

    environment.systemPackages = with pkgs; [
      # Packages installed with the pivot off macOS (the mac-side launchd
      # services were removed with it; the systemd services live in
      # fabro.nix and litellm.nix). `fabro` comes from the repo's overlay
      # (applied in flake.nix); litellm is nixpkgs'.
      fabro
      litellm

      btop
      nextvi # small version of vi
      gitMinimal # minimal version of git
    ];

    system.stateVersion = "26.05";
  };
}
