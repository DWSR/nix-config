# NixOS guest configuration for the fabro Lima VM
# (flake output `nixosConfigurations.fabro-vm`, image
# `packages.aarch64-linux.fabro-vm-image`).
#
# Mirrors upstream nixos-lima's lima.nix base (qcow-efi layout, lima-init +
# guestagent, passwordless-sudo wheel user created from Lima's cidata) with
# the repo's flake nixpkgs for userspace and a stationary upstream kernel
# pin (see the boot comment below) so rebuilds reuse the release image's
# kernel derivation. The VM the
# personal host boots today is the pinned upstream RELEASE image
# (home-manager/common/lima-vm.nix `image` default); this configuration
# matters once a Linux builder exists to build a custom image (then switch
# the module's `image.location` to the store path) or for remote deployment
# into the running instance (`nixos-rebuild --target`). The guest runs
# Docker plus the fabro and LiteLLM services, with their secrets from
# sops-nix (`sops` block below), and joins the tailnet as a Tailscale
# Services host advertising both applications (./tailscale.nix).
{
  rsync34,
  config,
  imageNixpkgs,
  lib,
  limaVirtiofsTags,
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

  # The state share's virtiofs tag: Lima derives it deterministically
  # from the expanded host location + the guest mountpoint
  # (lima pkg/limayaml/defaults.go MountTag), and the flake computes it
  # from the HOST's `virtualisation.limaVM.mounts` so this entry stays in
  # sync with the mount spec instead of hardcoding a hash.
  fabroStateTag = lib.findSingle (m: m.mountPoint == "/var/lib/fabro") null null limaVirtiofsTags;
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

    # nixpkgs' rsync bump to 3.5.0 broke the kernel build's post-install
    # rsync of the module sources (a local-copy regression in
    # RsyncProject/rsync#1050's class: deterministic "error in socket IO
    # (code 10) at io.c(949)" + SIGUSR1 to the generator inside the nix
    # build sandbox). Pin rsync to the 25.05 release (3.4.x) in this
    # guest's package set until nixpkgs ships a fixed 3.5.x.
    nixpkgs.overlays = [
      (
        _: prev:
        let
          old = import rsync34 { system = prev.stdenv.hostPlatform.system; };
        in
        {
          # Dynamic attr access: `old.rsync` trips statix's inherit rule
          # here, and `inherit (old) rsync` loses the overlay's last-arg
          # position.
          rsync = old."rsync";
        }
      )
    ];

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
        # Fabro, mirrored by fabro-sync-from-1password). Consumed through
        # the fabro-env template below as GITHUB_TOKEN, which is ALSO the
        # rendered source for the server-vault GITHUB_TOKEN the
        # token-strategy GitHub integration actually reads
        # (fabro.nix: server.integrations.github.strategy = "token").
        # Verified 2026-10-13: with GITHUB_TOKEN present in both the
        # rendered env file and the server process environment,
        # /api/v1/system/integrations still reported
        # missing_credentials:["GITHUB_TOKEN"]; seeding the server vault
        # (imperative `fabro secret set GITHUB_TOKEN --value-stdin`,
        # sourced from /run/secrets/github-token) flipped it to
        # configured:true immediately. The vault is imperative state on
        # the /var/lib/fabro virtiofs share (it survives VM recreation:
        # LITELLM_API_KEY was already back post-delete), so each FRESH
        # VM needs that one `secret set` run again after the switch.
        github-token = { };
      };

      # systemd EnvironmentFiles the services consume (fabro.nix and
      # litellm.nix reference config.sops.templates.<name>.path):
      #   * fabro-env — the dev-token auth pair fabro REQUIRES (dev-token
      #     start refuses to run without SESSION_SECRET + FABRO_DEV_TOKEN),
      #     plus GITHUB_TOKEN (the GitHub PAT: the token-strategy
      #     integration reads it from the server vault — see the
      #     github-token sops.secrets comment above — and this export
      #     is the rendered source to seed the vault from).
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
            GITHUB_TOKEN=${config.sops.placeholder.github-token}
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
    #
    # Stationary kernel: `kernelPackages` comes from `imageNixpkgs` — the
    # nixpkgs rev (flake input `nixpkgs-image`, 7c8764b7c7b09b34f632464276…,
    # nixos-26.05 2026-10-08) from which nixos-lima v0.2.2 built its released
    # image — and mirrors upstream's own kernel choice (`linuxPackages_latest`,
    # the default-setting in their lima.nix). Nix identifies kernel instances
    # by derivation hash, not version, so only that exact eval reproduces the
    # image's own store path (h6wsprygzmqz5dmakpp0bymh6zrl9g9p-linux-7.2.9,
    # verified) and a guest `nixos-rebuild` ships no kernel at all: no
    # substitute download, no in-guest compile, no initrd churn — /run keeps
    # the image's kernel. Historic note: 7.2.9 is NOT the 26.05 branch default
    # (that's 6.18.55); only because upstream pinned linuxPackages_latest on
    # this rev does the hash match. Tradeoff intentional: kernel updates
    # unlock on nixos-lima image releases; bump `nixpkgs-image` in lockstep
    # with them, never with the flake's main nixpkgs. Any patch recorded
    # below (even one believed image-matching) invalidates the hash and
    # reintroduces the churn; the stock config already covers what this
    # guest needs (CONFIG_VIRTIO_FS=m autoloads for the Lima state share),
    # so `kernelPatches` stays empty. History: linuxPackages_latest from the
    # flake's own nixpkgs had no aarch64 cache entry and forced a from-source
    # in-guest compile — which is why nixpkgs' rsync 3.5.0 regression (see
    # the rsync34 overlay above) bit this guest at all.
    boot = {
      kernelParams = [ "console=tty0" ];
      kernelPackages = imageNixpkgs.linuxPackages_latest;
      kernelPatches = [ ];

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
    # The state share: Lima's writable virtiofs share of the host's
    # ~/.local/state/fabro (tag computed from the mount spec — see the
    # fabroStateTag comment). Declared as a first-class fileSystems entry
    # because nixos-lima's lima-init only re-appends its fstab block at
    # BOOT: without this line, the first `nixos-rebuild switch` after
    # boot regenerates /etc/fstab without it, the fstab-generator drops
    # var-lib-fabro.mount, switch-to-configuration stops the share, and
    # the fabro service's ExecStartPre mkdir hits a bare root-owned
    # /var/lib/fabro under ProtectSystem=strict (the 2026-10-13 outage).
    # With the entry present, the generated fstab — and so the mount unit
    # text — is identical across switches and boots. Options must stay
    # exactly what lima-init derives from the Lima mount spec ("rw,
    # nofail", dump/pass 0) so the boot-time duplicate line from
    # lima-init's #LIMA-START block regenerates the identical unit.
    fileSystems."/var/lib/fabro" = {
      device = fabroStateTag.tag;
      fsType = "virtiofs";
      options = [
        "rw"
        "nofail"
      ];
      # Match lima-init's fstab line verbatim: dump/pass "0 0" rendered via
      # noCheck (virtiofs sees no fsck machinery either way).
      noCheck = true;
    };

    # The boot-time duplicate cleaner: with the fileSystems entry above,
    # nixos-lima's lima-init still appends its identical line inside its
    # #LIMA-START block, and duplicated fstab entries fail the
    # fstab-generator ("Duplicate entry in /etc/fstab"). Because the
    # mount is already up from the static entry by then, the transient
    # window is harmless; this postStart deletes just the lima-most
    # marker block — leaving exactly one identical entry — and reloads so
    # every later fstab-generator run (daemon-reload, switch) is clean.
    # Same fstab-edit mechanics lima-init itself uses (sed -i over the
    # symlink-hosted file); a later switch regenerates /etc/fstab with a
    # fresh symlink namespace anyway.
    systemd.services.lima-init.postStart = ''
      if grep -q '^#LIMA-START$' /etc/fstab; then
        sed -i '/^#LIMA-START$/,/^#LIMA-END$/d' /etc/fstab
        systemctl daemon-reload
      fi
    '';

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
