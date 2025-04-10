{config, homebrew, homebrew-core, homebrew-cask, homebrew-bundle, homebrew-deskflow, ... }: {
  # Stops the nix-darwin homebrew functionality from fighting with nix-homebrew about taps
  homebrew.taps = builtins.attrNames config.nix-homebrew.taps;

  imports = [ homebrew.darwinModules.nix-homebrew ];

  nix-homebrew = {
    enable = true;
    autoMigrate = true;
    mutableTaps = false;

    taps = {
      "homebrew/homebrew-core" = homebrew-core;
      "homebrew/homebrew-cask" = homebrew-cask;
      "homebrew/homebrew-bundle" = homebrew-bundle;
      "deskflow/homebrew-tap" = homebrew-deskflow;
    };
  };

  homebrew = {
    enable = true;

    onActivation = {
      autoUpdate = true;
      upgrade = false;
      # Nukes anything not explicitly defined here
      cleanup = "zap";
    };
  };
}
