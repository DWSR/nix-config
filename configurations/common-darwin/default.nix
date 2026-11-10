{
  inputs,
  outputs,
  config,
  lib,
  pkgs,
  username,
  ...
}:
let
  # Nix machine records carry the remote SSH host key as the base64 of a
  # known_hosts entry (`ssh-ed25519 <blob> [comment]`); Nix has no base64
  # builtin, so encode the pinned public key here. The encoding matches
  # `base64 -w0 < <pin>`, which is what scripts/fabro-darwin-machines.nix
  # produces for Fabro's Linux record.
  base64Encode =
    text:
    let
      alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      printableAscii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
      asciiCodes = builtins.listToAttrs (
        builtins.genList (index: {
          name = builtins.substring index 1 printableAscii;
          value = index + 32;
        }) (builtins.stringLength printableAscii)
      );
      codeOf =
        character:
        if character == "\n" then
          10
        else if character == "\r" then
          13
        else if character == "\t" then
          9
        else
          builtins.getAttr character asciiCodes;
      bytes = map codeOf (lib.stringToCharacters text);
      length = builtins.length bytes;
      groupCount = builtins.div (length + 2) 3;
      encodeGroup =
        group:
        let
          base = group * 3;
          b0 = builtins.elemAt bytes base;
          b1 = if base + 1 < length then builtins.elemAt bytes (base + 1) else 0;
          b2 = if base + 2 < length then builtins.elemAt bytes (base + 2) else 0;
          triple = b0 * 65536 + b1 * 256 + b2;
          pick = divisor: builtins.substring (builtins.bitAnd (builtins.div triple divisor) 63) 1 alphabet;
        in
        pick 262144
        + pick 4096
        + (if base + 1 < length then pick 64 else "=")
        + (if base + 2 < length then pick 1 else "=");
    in
    lib.concatStrings (map encodeGroup (builtins.genList (index: index) groupCount));

  linuxBuilderHostKeyPin = config.nix-config.linuxBuilder.hostKeyPin;
  linuxBuilderHostKeyPresent = builtins.pathExists linuxBuilderHostKeyPin;
  linuxBuilderHostKeyText =
    if linuxBuilderHostKeyPresent then builtins.readFile linuxBuilderHostKeyPin else "";
  linuxBuilderHostKeyLines = lib.filter (line: line != "") (
    lib.splitString "\n" linuxBuilderHostKeyText
  );
  linuxBuilderHostKeyFields =
    if builtins.length linuxBuilderHostKeyLines == 1 then
      lib.filter (field: field != "") (
        lib.splitString " " (lib.removeSuffix "\r" (builtins.head linuxBuilderHostKeyLines))
      )
    else
      [ ];
  linuxBuilderHostKeyType =
    if builtins.length linuxBuilderHostKeyFields > 0 then
      builtins.elemAt linuxBuilderHostKeyFields 0
    else
      "";
  linuxBuilderHostKeyData =
    if builtins.length linuxBuilderHostKeyFields > 1 then
      builtins.elemAt linuxBuilderHostKeyFields 1
    else
      "";
  linuxBuilderHostKeyIsValid =
    builtins.length linuxBuilderHostKeyLines == 1
    && linuxBuilderHostKeyType == "ssh-ed25519"
    && builtins.match "[A-Za-z0-9+/]+={0,2}" linuxBuilderHostKeyData != null;

  # The Darwin record is unchanged from the personal host's previous single
  # machine line: mac-builder's sshd host key is pinned (base64 of
  # `ssh-ed25519 AAAA...`) so the root nix-daemon verifies the builder instead
  # of consulting the missing /var/root/.ssh/known_hosts.
  darwinBuilderRecord = "ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ${config.sops.secrets.mac-builder-ssh-private-key.path} 8 1 - - c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK";

  # The Linux record advertises only aarch64-linux, matching the builder's
  # native platform, and references the dedicated personal client key by its
  # SOPS runtime path (never its value). The public host key is pinned as the
  # base64 known_hosts entry. When the operator has not provisioned the pin
  # yet, the host-key field is omitted; Nix then falls back to the root
  # known_hosts file (there is no entry, so the connection fails closed) while
  # the rest of the configuration stays evaluable.
  linuxBuilderRecord =
    "ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ${config.sops.secrets.linux-builder-client-key.path} 4 1 - -"
    + lib.optionalString linuxBuilderHostKeyPresent " ${base64Encode linuxBuilderHostKeyText}";

  linuxBuilderHostKeyPinWarning =
    "nix-config: the Linux builder SSH host-key pin is missing at ${toString linuxBuilderHostKeyPin}. "
    + "Copy the guest's /var/lib/ssh/ssh_host_ed25519_key.pub to "
    + "certificates/linux-builder/ssh_host_ed25519_key.pub (see the design's "
    + "Operator Provisioning section); until then the Linux machine record "
    + "omits the pinned host key and remote builds fail closed.";

  buildersFile =
    if !linuxBuilderHostKeyPresent then
      lib.warn linuxBuilderHostKeyPinWarning (
        pkgs.writeText "nix-builders" ''
          ${darwinBuilderRecord}
          ${linuxBuilderRecord}
        ''
      )
    else if linuxBuilderHostKeyIsValid then
      pkgs.writeText "nix-builders" ''
        ${darwinBuilderRecord}
        ${linuxBuilderRecord}
      ''
    else
      throw ''
        nix-config: the Linux builder SSH host-key pin is not an ssh-ed25519 public key: ${toString linuxBuilderHostKeyPin}.
        Copy the guest's /var/lib/ssh/ssh_host_ed25519_key.pub to
        certificates/linux-builder/ssh_host_ed25519_key.pub (see the design's
        Operator Provisioning section).
      '';
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    inputs.homebrew.darwinModules.nix-homebrew
    inputs.stylix.darwinModules.stylix

    ./1password.nix
    ./pared.nix
    ./slack.nix
    ./sqlite-backup-verify.nix
    ./stylix.nix
  ];

  options.nix-config.repoPath = lib.mkOption {
    type = lib.types.str;
    description = "Absolute path to the nix-config repository checkout on this machine";
  };

  options.nix-config.linuxBuilder = {
    hostKeyPin = lib.mkOption {
      type = lib.types.path;
      default = ../../certificates/linux-builder/ssh_host_ed25519_key.pub;
      description = ''
        Pinned public SSH host key (OpenSSH public key format) for the Linux
        remote builder. The value is public trust material shared with Fabro's
        machine renderer; the guest's private host key never enters the
        repository.
      '';
    };
    buildersFile = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      description = ''
        Generated Nix builders file containing the existing Darwin record and
        the Linux ssh-ng record. Referenced from `nix.settings.builders` via
        `@` so the client key stays a runtime SOPS path.
      '';
    };
  };

  config = {

    # Disable nix-darwin's documentation module. It defaults to enabled, which
    # forces eval-time instantiation of `system.build.manual` (and its
    # `pkgs.runCommand "options.json" { options = unsafeDiscardStringContext (toJSON …) ... }`),
    # producing a `Using 'builtins.derivation' to create a derivation named
    # 'options.json' that references the store path '<nixpkgs-source>' without a
    # proper context` warning on every `nix eval`/`darwin-rebuild`. We don't use
    # `darwin-help`, the rendered HTML manual, or the bundled man/info pages
    # (man pages from packages and `nix-index`'s `command-not-found` are sufficient).
    documentation.enable = false;

    nix-config.linuxBuilder.buildersFile = buildersFile;

    nix = {
      nixPath = [ "/etc/nix/path" ];

      registry = (lib.mapAttrs (_: flake: { inherit flake; })) (
        (lib.filterAttrs (_: lib.isType "flake")) inputs
      );

      optimise = {
        automatic = true;
        interval = {
          Weekday = 0;
          Hour = 4;
          Minute = 15;
        };
      };

      settings = {
        trusted-users = [ username ];
        # Parallel cache fetches. Default is 16 on Nix ≥ 2.18, but spelling
        # it explicitly here documents intent. Saves wall-time on fresh
        # `darwin-rebuild switch` when many derivations are pulled from
        max-substitution-jobs = 32;
        max-jobs = 0;
        # Both machine records live in a generated file referenced through `@`
        # so the SOPS runtime client-key paths are not emitted as world-readable
        # literal settings. The Darwin record is unchanged; the Linux record
        # advertises only aarch64-linux.
        builders = lib.mkForce "@${buildersFile}";
        builders-use-substitutes = true;
        # Append nix-community via extra-* so the nix-darwin defaults
        # (cache.nixos.org + its public key) aren't re-declared and duplicated
        # in the rendered /etc/nix/nix.conf.
        extra-substituters = [
          "https://nix-community.cachix.org"
        ];
        extra-trusted-public-keys = [
          "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
        ];
        experimental-features = [
          "nix-command"
          "flakes"
        ];
      };

      gc = {
        automatic = lib.mkDefault true;
        interval = lib.mkDefault {
          Weekday = 0;
          Hour = 3;
          Minute = 15;
        };
        options = lib.mkDefault "--delete-older-than 7d";
      };
    };

    nixpkgs = {
      config.allowUnfree = true;
      hostPlatform = "aarch64-darwin";
      overlays = [
        outputs.overlays.fixed-packages
        outputs.overlays.unstable-packages
        outputs.overlays.custom-packages
        inputs.nixneovimplugins.overlays.default
      ];
    };

    environment.etc =
      lib.mapAttrs' (name: value: {
        name = "nix/path/${name}";
        value.source = value.flake;
      }) config.nix.registry
      // {
        "nix-darwin".source = config.nix-config.repoPath;
      };

    users.users.${username}.home = "/Users/${username}";

    home-manager = {
      minimal = true;
      useGlobalPkgs = true;
      extraSpecialArgs = { inherit inputs outputs username; };
    };

    nix-homebrew = {
      enable = true;
      user = username;
      autoMigrate = true;
      mutableTaps = false;

      taps = {
        "homebrew/homebrew-core" = inputs.homebrew-core;
        "homebrew/homebrew-cask" = inputs.homebrew-cask;
        "homebrew/homebrew-bundle" = inputs.homebrew-bundle;
        "deskflow/homebrew-tap" = inputs.homebrew-deskflow;
        "cyrusradfar/homebrew-unf" = inputs.homebrew-unf;
        "darrylmorley/homebrew-whatcable" = inputs.homebrew-whatcable;
        "abue-ammar/homebrew-tinycast" = inputs.homebrew-tinycast;
      };
    };

    homebrew = {
      enable = true;
      user = username;
      global.autoUpdate = false;

      onActivation = {
        autoUpdate = true;
        upgrade = true;
        # Nukes anything not explicitly defined here
        cleanup = "zap";
      };

      # Homebrew 6.0 enables HOMEBREW_REQUIRE_TAP_TRUST by default, so every
      # non-official tap must be explicitly trusted or `brew bundle` refuses to
      # load its formulae/casks and aborts activation. Mark all declared taps
      # trusted (a no-op for the official homebrew/* taps) so the Brewfile
      # carries `trusted: true`; this also persists through `cleanup = "zap"`,
      # which resets the trust file to the Brewfile's declared trust.
      taps = lib.mapAttrsToList (name: _: {
        inherit name;
        trusted = true;
      }) config.nix-homebrew.taps;
    };

    system = {
      # Used for backwards compatibility, please read the changelog before changing.
      # $ darwin-rebuild changelog
      stateVersion = 7;
      primaryUser = username;

      # Homebrew installs before --force-cleanup, so the conflicting stable cask
      # must be removed before deskflow-dev can be installed. Remove this bridge
      # when switching the declaration back to a fixed stable Deskflow release.
      activationScripts.preActivation.text = ''
        if [[ -x /opt/homebrew/bin/brew ]] \
          && sudo --user=${username} --set-home /opt/homebrew/bin/brew list --cask deskflow >/dev/null 2>&1; then
          sudo --user=${username} --set-home /opt/homebrew/bin/brew uninstall --cask deskflow
        fi
      '';

      # activationScripts are executed every time you boot the system or run `nixos-rebuild` / `darwin-rebuild`.
      # Reload settings without requiring re-login
      activationScripts.postActivation.text = ''
        sudo -u ${username} /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
      '';

      defaults = {
        menuExtraClock = {
          Show24Hour = true;
          ShowDate = 2;
          ShowDayOfMonth = false;
          ShowDayOfWeek = false;
        };

        controlcenter = {
          BatteryShowPercentage = false;
          Bluetooth = true;
          Display = true;
          FocusModes = true;
          NowPlaying = false;
          Sound = true;
        };

        dock = {
          autohide = true;
        };

        finder = {
          CreateDesktop = false;
          QuitMenuItem = true;
          ShowPathbar = true;
        };

        NSGlobalDomain = {
          InitialKeyRepeat = 15;
          KeyRepeat = 2;
          NSAutomaticCapitalizationEnabled = false;
          NSAutomaticDashSubstitutionEnabled = false;
          NSAutomaticInlinePredictionEnabled = false;
          NSAutomaticPeriodSubstitutionEnabled = false;
          NSAutomaticQuoteSubstitutionEnabled = false;
          NSAutomaticSpellingCorrectionEnabled = false;
          "com.apple.keyboard.fnState" = true;
        };

        SoftwareUpdate = {
          AutomaticallyInstallMacOSUpdates = true;
        };

        CustomUserPreferences = {
          NSGlobalDomain = {
            NSStatusItemSelectionPadding = 12;
            NSStatusItemSpacing = 6;
          };

        };
      };
    };

    homebrew.casks = [
      "audio-hijack"
      "contexts"
      # Stable 1.26.0 can dispatch queued clipboard events through stale client
      # proxies after a reconnect (deskflow/deskflow#9843). The continuous cask
      # includes the upstream fix until it reaches the next stable release.
      "deskflow-dev"
      "tinycast"
      "loopback"
      "moom"
      "obsidian"
      "unfudged"
      "whatcable"
    ];

    # Add ability to used TouchID for sudo authentication
    security.pam.services.sudo_local.touchIdAuth = true;

  }; # config
}
