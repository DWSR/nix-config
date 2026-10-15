{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  cfg = config.virtualisation.limaVM;

  # Lima runs a native-architecture guest under the VZ driver (VZ cannot boot
  # a foreign-arch guest), so the default image arch follows the host.
  nativeArch = if pkgs.stdenv.hostPlatform.isAarch64 then "aarch64" else "x86_64";

  # The nixos-lima release images this module boots by default (verbatim
  # from upstream's nixos.yaml template for the pinned nixos-lima flake
  # input). The digest pins the download; a self-built image switches to a
  # store-path location with digest null (see {option}`image`).
  releasedImages = {
    aarch64 = {
      location = "https://github.com/nixos-lima/nixos-lima/releases/download/v0.2.2/nixos-lima-v0.2.2-aarch64.qcow2";
      digest = "sha512:bfcb703cdbad28cfd27438dc009408a859f3c4f575d3598d9627ea712c66128e0fa015de2010ce42bb724abc49f45029a4fc81891fb1a04c567378a6fdf31903";
    };
    x86_64 = {
      location = "https://github.com/nixos-lima/nixos-lima/releases/download/v0.2.2/nixos-lima-v0.2.2-x86_64.qcow2";
      digest = "sha512:cdf15475c6f799d3a355da50147fa81316e43e159b1b2e76eb21046f9fe8499770840ef876daaf85a2f5eb3a73445c4fa87d0337533fdf6f116d80c40806fbc9";
    };
  };

  inherit (cfg) limaHome;
  logDir = "${config.home.homeDirectory}/Library/Logs/lima-vm";
  agentName = "lima-${cfg.name}";

  # Host filesystem path for a mounts entry's `location` (a leading `~`
  # is Lima's own expansion against the invoking user's home).
  hostMountDir =
    loc: if lib.hasPrefix "~" loc then config.home.homeDirectory + lib.removePrefix "~" loc else loc;

  yamlFormat = pkgs.formats.yaml { };
  # The Lima instance configuration. Mirrors upstream's nixos.yaml template:
  # no host mounts, no containerd, and the UDP/68 ignore rule that keeps
  # Lima's port forwarding away from the guest DHCP port (nixos-lima issue
  # #50). {option}`extraLimaConfig` merges at the top level, so it can
  # override any key here — note that replacing a list key replaces it
  # wholesale (e.g. a custom `portForwards` drops the UDP/68 rule unless it
  # is re-added; use {option}`portForwards` to append instead).
  limaYaml = {
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

    inherit (cfg)
      vmType
      cpus
      memory
      disk
      ;

    # Host→guest filesystem mounts, empty by default (file exchange has
    # so far gone through limactl copy/scp, which keeps the VM
    # self-contained). On the VZ driver each entry attaches as a virtiofs
    # share; the nixos-lima guest's lima-init service reparses them into
    # /etc/fstab and mounts them on every boot. See {option}mounts.
    inherit (cfg) mounts;

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
    ]
    ++ cfg.portForwards;

    provision = [
      # The Lima cidata user is created imperatively by lima-init on every
      # boot after NixOS's activation and must NOT be declared in the
      # guest's users.users (mutableUsers stays true so rebuilds preserve
      # it). This grants it the podman group whenever the guest actually
      # runs podman, so its unprivileged shell can use the API socket
      # (the members-only socket of the guest's podman.socket unit); the
      # getent guard makes it a silent no-op otherwise.
      {
        mode = "system";
        # NOTE: provisioning scripts inherit lima-init's PATH, which does not
        # include glibc's `getent` — the group check greps /etc/group instead.
        # With getent the grant was a SILENT no-op (command-not-found exits
        # inside the `if`, so the script returned 0 without acting).
        script = ''
          #!/bin/sh
          if grep -q '^podman:' /etc/group \
            && ! id -nG "$LIMA_CIDATA_USER" | tr ' \t' '\n' | grep -qx podman; then
            usermod -aG podman "$LIMA_CIDATA_USER"
          fi
        '';
      }
    ]
    ++ lib.optionals (cfg.hostname != null) [
      {
        mode = "system";
        script = ''
          #!/bin/sh
          echo ${lib.escapeShellArg cfg.hostname} >/proc/sys/kernel/hostname
        '';
      }
    ];
  }
  // cfg.extraLimaConfig;

  limaConfigYaml = yamlFormat.generate "lima-${cfg.name}.yaml" limaYaml;

  # PATH for the launchd agent. The supervisor wrapper re-derives its own
  # PATH from {option}`runtimeInputs`, but this PATH is what limactl's
  # child processes (the hostagent spawns `ssh` and `ssh-keygen`) inherit,
  # and it is the fallback for anything the wrapper script itself calls.
  # nixpkgs' OpenSSH is listed explicitly because the scrubbed
  # writeShellApplication PATH must still contain ssh/ssh-keygen for the
  # hostagent.
  servicePath = lib.concatStringsSep ":" [
    (lib.makeBinPath (
      [
        cfg.package
        pkgs.openssh
      ]
      ++ cfg.path
    ))
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
    "/usr/sbin"
    "/sbin"
  ];

  # launchd supervisor for the Lima instance. The command flow mirrors
  # Lima's own `limactl autostart` LaunchAgent (pkg/autostart/launchd):
  # `limactl start INSTANCE --foreground` runs the hostagent in the
  # foreground and blocks until the VM exits, so the launchd job stays
  # alive exactly as long as the VM. Combined with
  # `KeepAlive.SuccessfulExit = false`:
  #
  #   crash / unclean exit        → non-zero → launchd restarts the VM
  #                                 (Lima >= 2.2 auto-recovers stale hostagent
  #                                 sockets and orphaned drivers on restart)
  #   clean `limactl stop`        → exit 0 → launchd leaves the VM stopped
  #   `limactl start` while up    → Lima exits 0 ("already running"), no restart
  #
  # The first run creates the instance from the module-rendered config
  # before starting (`limactl start NAME` on a missing instance would fall
  # back to the default Ubuntu template). The image download (first create
  # only) and the first boot both happen inside this job; launchd keeps
  # retrying (default 10s throttle) until they succeed.
  #
  # The rendered config is only read at create time — Lima copies it into
  # the instance directory. Rebuilding the module changes the store path of
  # the config but does NOT reconfigure an existing instance: delete and
  # recreate it (see the recovery commands in {option}`extraLimaConfig`'s
  # description) or edit the instance with `lima-vmctl edit`.
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

      # `limactl list --json NAME` exits non-zero when the named instance
      # does not exist; create it from the rendered config on first run.
      if ! limactl list --json "$name" >/dev/null 2>&1; then
        limactl --tty=false create --name="$name" "$config"
      fi

      exec limactl --tty=false start --foreground "$name"
    '';
  };

  # User-facing wrapper around limactl scoped to this module's LIMA_HOME,
  # so shell access (`lima-vmctl shell fabro`) targets the managed instance
  # instead of the default ~/.lima home.
  limaVmctl = pkgs.writeShellApplication {
    name = "lima-vmctl";
    runtimeInputs = [
      cfg.package
      pkgs.openssh
    ];
    text = ''
      export LIMA_HOME=${lib.escapeShellArg limaHome}
      exec limactl "$@"
    '';
  };

  limaVmDeploy =
    if cfg.guestSystem == null then
      null
    else
      pkgs.writeShellApplication {
        name = "lima-vm-deploy";
        runtimeInputs = [
          pkgs.gnutar
          pkgs.gzip
          pkgs.openssh
        ];
        text = ''
          # Apply the flake's nixosConfigurations.${cfg.guestSystem} to the
          # running instance WITHOUT cloning the repository inside the guest.
          #
          #   usage: lima-vm-deploy [REPO]   (REPO defaults to the cwd; it must
          #                                  contain flake.nix + flake.lock)
          #
          # The NixOS closure is built by the guest's own Nix daemon (macOS has
          # no Linux builder): the working tree is streamed as a tarball into a
          # scratch dir over SSH and nixos-rebuild evaluates/switches from it
          # there. Inputs must be locked so the guest resolves the same pinned
          # sources.
          export LIMA_HOME=${lib.escapeShellArg limaHome}

          repo=''${1:-$PWD}
          name=${lib.escapeShellArg cfg.name}
          system=${lib.escapeShellArg cfg.guestSystem}
          sshConfig="$LIMA_HOME/$name/ssh.config"
          remoteHost="lima-$name"
          scratch=/tmp/lima-vm-deploy

          if [ ! -f "$repo/flake.nix" ] || [ ! -f "$repo/flake.lock" ]; then
            echo "lima-vm-deploy: $repo is not a locked flake (usage: lima-vm-deploy [REPO])" >&2
            exit 1
          fi
          if [ ! -f "$sshConfig" ]; then
            echo "lima-vm-deploy: no ssh config at $sshConfig; is the instance running? try: limactl start $name" >&2
            exit 1
          fi

          remote() {
            ssh -F "$sshConfig" "$remoteHost" "$@"
          }

          remote -- "rm -rf '$scratch' && mkdir -p '$scratch'"

          # Stream the tree (git metadata and switch leftovers removed).
          tar --exclude=.git --exclude=.direnv --exclude=result --exclude='result-*' \
            --exclude=.pre-commit-config.yaml \
            --exclude='*.aac' --exclude='*.mp4*' --exclude='*.mp3' \
            -cf - -C "$repo" . \
            | gzip \
            | remote -- "tar -xzf - -C '$scratch'"

          remote -- "nixos-rebuild switch --sudo --flake '$scratch#$system'"
          echo "lima-vm-deploy: switched guest to '$system'; scratch tree left at $scratch."
        '';
      };
in
{
  options.virtualisation.limaVM = {
    enable = mkEnableOption "the NixOS Lima VM launchd user agent";

    name = mkOption {
      type = types.str;
      default = "fabro";
      description = ''
        Lima instance name. Must be valid for `limactl` (lowercase
        alphanumeric plus `-`, `_`, and `.` separators, no leading or
        trailing separator); enforced with an assertion. The launchd agent
        is keyed `lima-''${name}` with label `dev.dwsr.lima-''${name}`.
      '';
    };

    hostname = mkOption {
      type = types.nullOr types.str;
      default = null;
      defaultText = "null (keeps the image's default guest hostname)";
      example = "fabro";
      description = ''
        Hostname assigned to the guest, set through a Lima `provision`
        system script that nixos-lima's lima-init applies on every boot
        (NixOS guests get no hostname from Lima's own cidata handling).
        This makes the VM targetable from SSH entries and deploy tools
        even while it still boots the upstream release image whose baked-in
        `networking.hostName` is `nixos`. The flake's
        `nixosConfigurations.fabro-vm` sets the same value through
        `networking.hostName`, so a self-built image matches without the
        provision script. Null leaves the image's hostname unchanged.
        Must be a valid hostname (letters, digits, dots, hyphens);
        enforced with an assertion.
      '';
    };

    package = mkOption {
      type = types.package;
      default = pkgs.unstable.lima;
      defaultText = "pkgs.unstable.lima";
      description = ''
        The lima package providing `limactl`. Defaults to the unstable
        package set (lima 2.2): >= 2.2 auto-recovers stale hostagent sockets
        and orphaned VM drivers on restart, which the crash-restart flow of
        the launchd agent relies on.
      '';
    };

    limaHome = mkOption {
      type = types.str;
      default = "${config.xdg.stateHome}/lima";
      defaultText = lib.literalExpression ''"''${config.xdg.stateHome}/lima"'';
      description = ''
        Private LIMA_HOME for the managed instance, kept out of the default
        `~/.lima` so the VM does not mix with ad-hoc lima usage. Both the
        launchd agent and the `lima-vmctl` wrapper export it; it is not
        added to {option}`home.sessionVariables` so user shells with their
        own lima usage are unaffected.
      '';
    };

    image = mkOption {
      description = ''
        The guest boot image. Defaults to the pinned
        [nixos-lima](https://github.com/nixos-lima/nixos-lima) release
        image, which has `services.lima.enable` (lima-init + guestagent)
        baked in, so no image build is required. To boot the flake-built
        image instead, point {option}`image.location` at
        `packages.aarch64-linux.fabro-vm-image`'s `nixos.qcow2` store path
        and set {option}`image.digest` to null.
      '';
      type = types.submodule {
        options = {
          location = mkOption {
            type = types.str;
            default = releasedImages.${cfg.image.arch}.location;
            defaultText = "The pinned nixos-lima release image URL for {option}`image.arch`.";
            description = "Image URL or local file path passed as `images[0].location`.";
          };

          digest = mkOption {
            type = types.nullOr types.str;
            default = releasedImages.${cfg.image.arch}.digest;
            defaultText = "The pinned nixos-lima release image digest for {option}`image.arch`.";
            description = ''
              Digest for `images[0].digest` (`sha256:` / `sha512:` prefix).
              Null skips verification — required for local store-path
              images.
            '';
          };

          arch = mkOption {
            type = types.enum [
              "aarch64"
              "x86_64"
            ];
            default = nativeArch;
            defaultText = "The host's native architecture (VZ guests must be native).";
            description = "Guest architecture for `images[0].arch`.";
          };
        };
      };
    };

    vmType = mkOption {
      type = types.enum [
        "vz"
        "qemu"
      ];
      default = "vz";
      description = ''
        Lima `vmType`. VZ is the macOS-native driver (no QEMU installation;
        VM runs inside the hostagent process). The image arch must match
        the host arch under VZ — asserted.
      '';
    };

    cpus = mkOption {
      type = types.ints.positive;
      default = 8;
      description = ''
        Lima `cpus`. Keep at or below the host's physical core count:
        oversubscribing Virtualization.framework starves the Lima
        hostagent (every limactl call times out) and spikes host load
        without buying guest build speed (guest rebuilds substitute
        prebuilt artifacts rather than compiling).
      '';
    };

    memory = mkOption {
      type = types.str;
      default = "12GiB";
      description = ''
        Lima `memory`. The nixos-lima docs recommend at least 8GiB (NixOS
        rebuilds inside the guest are memory-hungry).
      '';
    };

    disk = mkOption {
      type = types.str;
      default = "128GiB";
      description = ''
        Lima `disk` (root disk size). The base image is resized to this on
        create; the NixOS root filesystem (ext4, `autoResize`) grows into
        it on first boot.
      '';
    };

    portForwards = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      description = ''
        Additional `portForwards` entries appended after the module's
        built-in UDP/68 ignore rule.
      '';
    };

    mounts = mkOption {
      type = types.listOf types.attrs;
      default = [ ];
      description = ''
        Lima `mounts` entries: a host `location` attached into the guest
        at `mountPoint`. `writable` defaults to false; shares the guest
        writes to need it. On the VZ driver each entry is a virtiofs
        share, which VZ maps wholesale to the Lima cidata user — guest
        services that write through a share must run as that user (the
        fabro guest does; see configurations/fabro-vm/fabro.nix). The
        nixos-lima guest's lima-init service reparses these into
        /etc/fstab on every boot. A `location` beginning with `~` is
        expanded against the configuring user's home on the host.
      '';
    };

    extraLimaConfig = mkOption {
      inherit (yamlFormat) type;
      default = { };
      description = ''
        Freeform Lima YAML configuration merged over the module-rendered
        root keys (shallow attrset merge, so list-valued keys are replaced,
        not appended). See <https://lima-vm.io/docs/config/>.
      '';
    };

    guestSystem = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "fabro-vm";
      description = ''
        Name of the `nixosConfigurations.<name>` output that defines this
        VM's guest OS. When set, the module ships `lima-vm-deploy`, which
        applies that configuration to the running instance from the
        repository working tree WITHOUT cloning the repository inside the
        guest: it streams a tarball of the tree over SSH into a scratch
        dir, then lets the guest's own Nix evaluate its flake and switch
        with `nixos-rebuild switch --sudo` (the flake inputs must be
        locked; the macOS host itself is not a Linux builder).
      '';
    };

    _deploy = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = "Internal `lima-vm-deploy` script consumed by home.packages and tests. Null when {option}`guestSystem` is unset.";
    };

    path = mkOption {
      type = types.listOf types.package;
      default = [ ];
      description = ''
        Extra packages prepended to the service PATH (after lima and
        OpenSSH) before the standard system directories.
      '';
    };

    _configYaml = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = ''
        Internal rendered Lima YAML consumed by the supervisor at create
        time and by the flake's `limactl validate` check. Null when
        disabled.
      '';
    };

    _supervisor = mkOption {
      type = types.nullOr types.path;
      internal = true;
      readOnly = true;
      description = ''
        Internal supervisor script consumed by the launchd agent and tests.
        Null when disabled.
      '';
    };

    _mountTags = mkOption {
      type = types.listOf (
        types.submodule {
          options = {
            mountPoint = mkOption {
              type = types.str;
              description = "The {option}`mounts` entry's guest path.";
            };
            tag = mkOption {
              type = types.str;
              description = "The virtiofs tag Lima assigns the entry.";
            };
          };
        }
      );
      internal = true;
      readOnly = true;
      description = ''
        Internal per-mount virtiofs tags. Lima derives each tag
        deterministically from `location:mountPoint` of the expanded
        host location (lima pkg/limayaml/defaults.go `MountTag`:
        `lima-<sha256 first 8 bytes hex>`), so the guest can declare
        matching `fileSystems` entries that survive NixOS switch
        regeneration (nixos-lima's lima-init only re-appends its fstab
        block at boot).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.isDarwin;
        message = "virtualisation.limaVM manages the VM through a launchd agent and is darwin-only.";
      }
      {
        assertion = builtins.match "[a-zA-Z0-9]+([-._][a-zA-Z0-9]+)*" cfg.name != null;
        message = "virtualisation.limaVM.name must be a valid lima instance name (alphanumeric with - . _ separators).";
      }
      {
        assertion =
          cfg.hostname == null
          || builtins.match "[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?" cfg.hostname != null;
        message = "virtualisation.limaVM.hostname must be a valid hostname (letters, digits, dots, hyphens).";
      }
      {
        assertion = cfg.vmType != "vz" || cfg.image.arch == nativeArch;
        message = "virtualisation.limaVM: the VZ driver requires a native-architecture guest (image.arch \"${cfg.image.arch}\" on ${nativeArch}).";
      }
    ];

    virtualisation.limaVM = {
      _configYaml = limaConfigYaml;
      _supervisor = supervisor;
      _deploy = limaVmDeploy;
      _mountTags = map (
        m:
        let
          # The tag input is the EXPANDED host location (Lima expands "~"
          # against the invoking user's home before hashing — verified
          # against lima 2.2.0's MountTag for this instance's share) joined
          # with the guest mount point by ":".
          tagInput = "${hostMountDir m.location}:${m.mountPoint}";
        in
        {
          inherit (m) mountPoint;
          tag = "lima-${builtins.substring 0 16 (builtins.hashString "sha256" tagInput)}";
        }
      ) cfg.mounts;
    };

    home.packages = [
      cfg.package
      limaVmctl
    ]
    ++ lib.optional (limaVmDeploy != null) limaVmDeploy;

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

    home.activation.limaVmDirs = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      run mkdir -p ${
        lib.escapeShellArgs (
          [
            limaHome
            logDir
          ]
          ++ map hostMountDir (map (m: m.location) cfg.mounts)
        )
      }
    '';
  };
}
