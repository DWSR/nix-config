{
  inputs,
  config,
  lib,
  username,
  ...
}:
{
  imports = [
    inputs.homebrew.darwinModules.nix-homebrew

    ./1password.nix
    ./slack.nix
  ];

  nix = {
    optimise = {
      automatic = true;
      interval = { Weekday = 0; };
    };

    settings = {
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
    activationScripts.postActivation.text = ''
      # Ears Insta-Mute shortcut (Fn+F12) — stored as an NSKeyedArchive that can't be set via CustomUserPreferences
      sudo -u ${username} defaults write com.clickontyler.Ears kInstaMuteShortcut -data 62706c6973743030d4010203040506070a582476657273696f6e592461726368697665725424746f7058246f626a6563747312000186a05f100f4e534b657965644172636869766572d1080954726f6f748001a30b0c1355246e756c6cd30d0e0f101112574b6579436f64655624636c6173735d4d6f646966696572466c616773106f80021200160000d2141516175a24636c6173736e616d655824636c61737365735b4d415353686f7274637574a218195b4d415353686f7274637574584e534f626a65637408111a24293237494c5153575d646c738183858a8f9aa3afb2be0000000000000101000000000000001a000000000000000000000000000000c7

      # activateSettings -u will reload the settings from the database and apply them to the current session,
      # so we do not need to logout and login again to make the changes take effect.
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

        "com.clickontyler.Ears" = {
          SUEnableAutomaticChecks = true;
          SUSendProfileInfo = false;
          instaMuteBezel = true;
          kDockAction = 0;
          kDockMenuBar = true;
          launchOnBoot = true;
          showHotMic = true;
        };
      };
    };
  };

  # Add ability to used TouchID for sudo authentication
  security.pam.services.sudo_local.touchIdAuth = true;
}
