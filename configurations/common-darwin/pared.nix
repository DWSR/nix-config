{ inputs, pkgs, ... }:
{
  environment.systemPackages = [
    inputs.pared.packages.${pkgs.stdenv.hostPlatform.system}.pared
  ];
}
