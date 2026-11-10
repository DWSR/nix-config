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
  # Public trust material only: the Linux builder's pinned Ed25519 host key.
  # Both clients consume the checked-in pin; Fabro reaches it through
  # `fabro.darwinBuilder.linuxHostKeyPath`, while this host embeds it in the
  # generated builders file because Nix's machine-line format carries the
  # base64 of the public key line rather than a path.
  linuxBuilderHostKeyPin = config.nix-config.linuxBuilderHostKeyPin;
  linuxBuilderHostKeyAvailable = builtins.pathExists linuxBuilderHostKeyPin;

  linuxBuilderHostKeyContents =
    if linuxBuilderHostKeyAvailable then builtins.readFile linuxBuilderHostKeyPin else "";

  linuxBuilderHostKeyIsValid =
    let
      matches = builtins.match "ssh-ed25519 [A-Za-z0-9+/]+={0,2}( [^\n]*)?\n" linuxBuilderHostKeyContents;
    in
    linuxBuilderHostKeyAvailable && matches != null;

  linuxBuilderHostKeyBase64 =
    if linuxBuilderHostKeyIsValid then
      base64Encode linuxBuilderHostKeyContents
    else if linuxBuilderHostKeyAvailable then
      throw "nix-config: ${toString linuxBuilderHostKeyPin} is not a single ssh-ed25519 public key line; expected the provisioned guest's /var/lib/ssh/ssh_host_ed25519_key.pub"
    else
      "";

  # Nix has no built-in base64 encoder and the machine line must carry
  # `base64` of the whole public key line (type, blob, and comment). The
  # alphabet below is the standard RFC 4648 one and the encoder is
  # byte-oriented; pinned host keys are printable ASCII plus a trailing
  # newline.
  base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  printableAscii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  asciiCodes =
    builtins.listToAttrs (
      builtins.genList (index: {
        name = builtins.substring index 1 printableAscii;
        value = 32 + index;
      }) (builtins.stringLength printableAscii)
    )
    // {
      "\n" = 10;
    };
  asciiCode =
    character:
    asciiCodes.${character}
      or (throw "nix-config: the pinned linux-builder SSH host key contains an unsupported byte");
  base64Encode =
    value:
    let
      length = builtins.stringLength value;
      byteAt = index: asciiCode (builtins.substring index 1 value);
      encodeGroup =
        start:
        let
          remaining = length - start;
          first = byteAt start;
          second = if remaining > 1 then byteAt (start + 1) else 0;
          third = if remaining > 2 then byteAt (start + 2) else 0;
          triple = first * 65536 + second * 256 + third;
          firstSextet = builtins.div triple 262144;
          secondSextet = builtins.div (triple - firstSextet * 262144) 4096;
          thirdSextet = builtins.div (triple - firstSextet * 262144 - secondSextet * 4096) 64;
          fourthSextet = triple - firstSextet * 262144 - secondSextet * 4096 - thirdSextet * 64;
        in
        builtins.substring firstSextet 1 base64Alphabet
        + builtins.substring secondSextet 1 base64Alphabet
        + (if remaining > 1 then builtins.substring thirdSextet 1 base64Alphabet else "=")
        + (if remaining > 2 then builtins.substring fourthSextet 1 base64Alphabet else "=");
    in
    builtins.concatStringsSep "" (
      builtins.genList (index: encodeGroup (index * 3)) (builtins.div (length + 2) 3)
    );

  # `base64` of the existing mac-builder host key line. Keep this literal so
  # the Darwin record stays byte-for-byte equivalent to its previous form.
  darwinHostKeyBase64 = "c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK";

  # One `@file` source for the local Nix daemon: the existing Darwin record
  # followed by the Linux builder record. The file holds public host identity
  # and the root-only runtime key paths only; secret values never enter it.
  # The Linux record is omitted (with an assertion below blocking activation)
  # while the operator-provisioned host-key pin is absent, so evaluation of the
  # rest of the host does not depend on operator secret/trust material.
  buildersFile = pkgs.writeText "nix-builders.conf" (
    lib.concatStrings [
      "ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ${config.sops.secrets.mac-builder-ssh-private-key.path} 8 1 - - ${darwinHostKeyBase64}\n"
      (
        if linuxBuilderHostKeyAvailable then
          "ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ${config.sops.secrets.linux-builder-client-key.path} 4 1 - - ${linuxBuilderHostKeyBase64}\n"
        else
          "# linux-builder record omitted: pinned host key missing at ${toString linuxBuilderHostKeyPin}\n"
      )
    ]
  );
in
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    inputs.homebrew.darwinModules.nix-homebrew
    inputs.stylix.darwinModules.stylix

    ./1password.nix
    ./local-binary-cache.nix
    ./pared.nix
    ./slack.nix
    ./sqlite-backup-verify.nix
    ./stylix.nix
  ];

  options.nix-config.repoPath = lib.mkOption {
    type = lib.types.str;
    description = "Absolute path to the nix-config repository checkout on this machine";
  };

  options.nix-config.linuxBuilderHostKeyPin = lib.mkOption {
    type = lib.types.path;
    default = ../../certificates/linux-builder/ssh_host_ed25519_key.pub;
    description = ''
      Checked-in public Ed25519 SSH host key pinned for the Linux builder. The
      generated builders file embeds its base64 form so the root Nix daemon
      verifies the remote endpoint instead of consulting a known_hosts file.
    '';
  };

  config = {

    # The personal Nix daemon must not switch with only the Darwin builder
    # configured: the Linux record can only be rendered from the checked-in
    # public pin, so a missing pin blocks activation instead of silently
    # dropping Linux dispatch. This is operator-supplied trust material, not a
    # secret; never substitute a generated key.
    assertions = [
      {
        assertion = linuxBuilderHostKeyAvailable;
        message = "nix-config: the pinned linux-builder SSH host key is missing at ${toString linuxBuilderHostKeyPin}; copy the provisioned guest's /var/lib/ssh/ssh_host_ed25519_key.pub there (never substitute a key)";
      }
    ];

    # Disable nix-darwin's documentation module. It defaults to enabled, which
    # forces eval-time instantiation of `system.build.manual` (and its
    # `pkgs.runCommand "options.json" { options = unsafeDiscardStringContext (toJSON …) ... }`),
    # producing a `Using 'builtins.derivation' to create a derivation named
    # 'options.json' that references the store path '<nixpkgs-source>' without a
    # proper context` warning on every `nix eval`/`darwin-rebuild`. We don't use
    # `darwin-help`, the rendered HTML manual, or the bundled man/info pages
    # (man pages from packages and `nix-index`'s `command-not-found` are sufficient).
    documentation.enable = false;

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
        # Builders come from a Nix-generated `@file`: the existing Darwin
        # record (whose literal key pin is in `buildersFile` above) plus the
        # Linux builder record. Nix machine records are whitespace-delimited,
        # so both records live in one generated file; only public host
        # identity and the root-only runtime key paths are in the store.
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
