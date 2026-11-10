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
  # Nix machine records carry the remote host public key base64-encoded
  # (`base64 -w0` of the complete `ssh-ed25519 ...` line). Nix has no
  # base64 builtin, so this pure encoder keeps the generated builders file
  # evaluable without import-from-derivation.
  base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  # Printable ASCII 32..126 in order; a character's code is its index + 32.
  printableAscii = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
  charCodes = builtins.listToAttrs (
    builtins.genList (index: {
      name = builtins.substring index 1 printableAscii;
      value = 32 + index;
    }) (builtins.stringLength printableAscii)
    ++ [
      {
        name = "\n";
        value = 10;
      }
      {
        name = "\r";
        value = 13;
      }
      {
        name = "\t";
        value = 9;
      }
    ]
  );
  byteAt =
    text: index:
    if index >= builtins.stringLength text then
      0
    else
      let
        character = builtins.substring index 1 text;
      in
      charCodes.${character} or (throw "nix-config: builders input contains a non-ASCII byte");
  base64Char = value: builtins.substring value 1 base64Alphabet;
  base64Encode =
    text:
    let
      length = builtins.stringLength text;
      fullGroups = length / 3;
      remainder = length - fullGroups * 3;
      encodeGroup =
        groupIndex:
        let
          offset = groupIndex * 3;
          a = byteAt text offset;
          b = byteAt text (offset + 1);
          c = byteAt text (offset + 2);
          triple = a * 65536 + b * 256 + c;
        in
        base64Char (triple / 262144)
        + base64Char ((triple / 4096) - (triple / 262144) * 64)
        + base64Char ((triple / 64) - (triple / 4096) * 64)
        + base64Char (triple - (triple / 64) * 64);
      tail =
        if remainder == 0 then
          ""
        else
          let
            offset = fullGroups * 3;
            a = byteAt text offset;
            b = byteAt text (offset + 1);
          in
          if remainder == 1 then
            base64Char (a / 4) + base64Char ((a - (a / 4) * 4) * 16) + "=="
          else
            base64Char (a / 4)
            + base64Char ((a - (a / 4) * 4) * 16 + b / 16)
            + base64Char ((b - (b / 16) * 16) * 4)
            + "=";
    in
    builtins.concatStringsSep "" (builtins.genList encodeGroup fullGroups) + tail;

  linuxBuilderHostKeyPath = config.nix-config.linuxBuilderHostKeyPath;
  linuxBuilderHostKey =
    if builtins.pathExists linuxBuilderHostKeyPath then
      builtins.readFile linuxBuilderHostKeyPath
    else
      "";
  # The checked-in pin is operator-supplied public trust material (spec
  # task 2.3). Until it is published the Linux record leaves the host-key
  # field at its default (`-`), so SSH falls back to known_hosts and fails
  # closed instead of trusting an invented key.
  linuxBuilderHostKeyField =
    if linuxBuilderHostKey == "" then "-" else base64Encode linuxBuilderHostKey;

  buildersText = ''
    ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin ${config.sops.secrets.mac-builder-ssh-private-key.path} 8 1 - - c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK
    ssh-ng://builder@linux-builder.tuxedo-musical.ts.net aarch64-linux ${
      config.sops.secrets."linux-builder-client-key".path
    } 4 1 - - ${linuxBuilderHostKeyField}
  '';
  buildersFile = pkgs.writeText "nix-builders" buildersText;
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

  options.nix-config.linuxBuilderHostKeyPath = lib.mkOption {
    type = lib.types.str;
    default = "${toString ../..}/certificates/linux-builder/ssh_host_ed25519_key.pub";
    description = "Absolute path to the checked-in public SSH host-key pin for the Linux builder.";
  };

  options.nix-config.linuxBuilderBuilders = lib.mkOption {
    type = lib.types.package;
    internal = true;
    readOnly = true;
    description = "Generated Nix builders file containing the Darwin and Linux remote machine records.";
    default = buildersFile;
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
        # Both remote machine records live in one `pkgs.writeText` file
        # referenced through Nix's `@file` form. The file contains only
        # public host identity, endpoints, and runtime secret paths -- never
        # a private key value. Keeping the Darwin record here preserves its
        # existing endpoint and fields.
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
