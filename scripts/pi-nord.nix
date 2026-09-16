{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "pi-nord";
  version = "1.0.0";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@maddeye/pi-nord/-/pi-nord-1.0.0.tgz";
    hash = "sha512-6kp1GLdS3akX7AEh4+1/7OrCW3PXU5dXr8snz57cELYQrh79GV1MUdPjjMmENKQW1Rt/vAoKXrZK+u+pFXBlWw==";
  };

  installPhase = ''
    mkdir -p "$out"
    cp -R . "$out/"
  '';
}
