{ inputs, config, pkgs, ... }:
{
  imports = [ inputs.homebrew.darwinModules.nix-homebrew ];

  nix-homebrew = {
    enable = true;
    autoMigrate = true;
    mutableTaps = false;

    taps = {
      "homebrew/homebrew-core" = inputs.homebrew-core;
      "homebrew/homebrew-cask" = inputs.homebrew-cask;
      "homebrew/homebrew-bundle" = inputs.homebrew-bundle;
      "deskflow/homebrew-tap" = inputs.homebrew-deskflow;
    };
  };

  homebrew = {
    enable = true;

    global = {
      autoUpdate = false;
    };

    onActivation = {
      autoUpdate = true;
      upgrade = true;
      # Nukes anything not explicitly defined here
      cleanup = "zap";
    };

    taps = builtins.attrNames config.nix-homebrew.taps;
  };

  system = {
    primaryUser = "brandonmcnama";

    # activationScripts are executed every time you boot the system or run `nixos-rebuild` / `darwin-rebuild`.
    activationScripts.postActivation.text = ''
      # activateSettings -u will reload the settings from the database and apply them to the current session,
      # so we do not need to logout and login again to make the changes take effect.
      sudo -u brandonmcnama /System/Library/PrivateFrameworks/SystemAdministration.framework/Resources/activateSettings -u
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


  # Add ability to used TouchID for sudo authentication
  security.pam.services.sudo_local.touchIdAuth = true;
}
