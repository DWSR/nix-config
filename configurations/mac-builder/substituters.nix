{ config, lib, ... }:

let
  publicSubstituters = [
    "https://cache.nixos.org/"
    "https://nix-community.cachix.org"
  ];
  publicKeys = [
    "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
    "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  ];
in
{
  nix.settings = {
    substituters = lib.mkForce publicSubstituters;
    trusted-public-keys = lib.mkForce publicKeys;
  };

  assertions = [
    {
      assertion = !(builtins.hasAttr "extra-platforms" config.nix.settings);
      message = "mac-builder must not configure nix.settings.extra-platforms";
    }
    {
      assertion = builtins.all (value: builtins.match ".*(attic|private|.internal).*" value == null) (
        config.nix.settings.substituters ++ config.nix.settings.trusted-public-keys
      );
      message = "mac-builder cache policy must not include a private cache host";
    }
    {
      assertion = config.nixpkgs.hostPlatform.system == "aarch64-darwin";
      message = "mac-builder cache policy requires nixpkgs.hostPlatform.system = aarch64-darwin";
    }
  ];
}
