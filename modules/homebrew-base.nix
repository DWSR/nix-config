{inputs, config, ... }: {
  # Stops the nix-darwin homebrew functionality from fighting with nix-homebrew about taps
  homebrew.taps = builtins.attrNames config.nix-homebrew.taps;

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

    onActivation = {
      autoUpdate = true;
      upgrade = false;
      # Nukes anything not explicitly defined here
      cleanup = "zap";
    };
  };
}
