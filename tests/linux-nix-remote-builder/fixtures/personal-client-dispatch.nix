# Negative evaluation fixture for the combined Linux remote-builder check.
# Applying it with a non-default argument replaces the personal Mac's generated
# builders file with one whose Linux record advertises a different system while
# preserving the existing Darwin record byte-for-byte:
#
#   import ./personal-client-dispatch.nix { system = "aarch64-darwin"; }
{
  system ? "aarch64-linux",
}:
{ lib, ... }:
let
  darwinRecord = "ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net aarch64-darwin /run/secrets/mac-builder-ssh-private-key 8 1 - - c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSU1XOEpoU2lLaXA3aVlHc3AyY08zVTBJTmNYeTliZkNRU0lPVEdvejRPcUkK";
  linuxHostKeyBase64 = "c3NoLWVkMjU1MTkgQUFBQUMzTnphQzFsWkRJMU5URTVBQUFBSUFBQkFnTUVCUVlIQ0FrS0N3d05EZzhRRVJJVEZCVVdGeGdaR2hzY0hSNGYgbGludXgtYnVpbGRlcgo=";
  buildersFile = builtins.toFile "negative-personal-builders" ''
    ${darwinRecord}
    ssh-ng://builder@linux-builder.tuxedo-musical.ts.net ${system} /run/secrets/linux-builder-client-key 4 1 - - ${linuxHostKeyBase64}
  '';
in
{
  nix.settings.builders = lib.mkOverride 40 "@${buildersFile}";
}
