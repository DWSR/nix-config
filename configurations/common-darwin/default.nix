{
  inputs,
  outputs,
  config,
  lib,
  pkgs,
  username,
  ...
}:
{
  imports = [
    inputs.home-manager.darwinModules.home-manager
    inputs.homebrew.darwinModules.nix-homebrew

    ./1password.nix
    ./ears.nix
    ./slack.nix
  ];

  options.nix-config.repoPath = lib.mkOption {
    type = lib.types.str;
    description = "Absolute path to the nix-config repository checkout on this machine";
  };

  config = {

    nix = {
      nixPath = [ "/etc/nix/path" ];

      registry = (lib.mapAttrs (_: flake: { inherit flake; })) (
        (lib.filterAttrs (_: lib.isType "flake")) inputs
      );

      optimise = {
        automatic = true;
        interval = {
          Weekday = 0;
        };
      };

      settings = {
        trusted-users = [ username ];
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

    fonts.packages = with pkgs; [
      nerd-fonts.monaspace
      monaspace
    ];

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

      taps = builtins.attrNames config.nix-homebrew.taps;
    };

    system = {
      # Used for backwards compatibility, please read the changelog before changing.
      # $ darwin-rebuild changelog
      stateVersion = 6;
      primaryUser = username;

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
      "contexts"
      "deskflow"
      "ears"
      "loopback"
      "obsidian"
      "unfudged"
    ];

    # Add ability to used TouchID for sudo authentication
    security.pam.services.sudo_local.touchIdAuth = true;

  }; # config
}
