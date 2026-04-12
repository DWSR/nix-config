# Intentionally badly formatted nix file for testing
{ pkgs, ... }:
{
  environment.systemPackages = [
    pkgs.hello
    pkgs.git
  ];
}
