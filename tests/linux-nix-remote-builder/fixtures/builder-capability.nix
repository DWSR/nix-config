# Negative evaluation fixture for the combined Linux remote-builder check.
# Applying it with a non-default argument forces the portable builder host off
# one of its required capability settings:
#
#   import ./builder-capability.nix { hostPlatform = "x86_64-linux"; }
#   import ./builder-capability.nix { extraPlatforms = [ "x86_64-linux" ]; }
{
  hostPlatform ? "aarch64-linux",
  extraPlatforms ? [ ],
}:
{ lib, ... }:
{
  nixpkgs.hostPlatform = lib.mkForce hostPlatform;
  nix.settings.extra-platforms = lib.mkForce extraPlatforms;
}
