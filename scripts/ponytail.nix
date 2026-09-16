{ pkgs }:
pkgs.stdenvNoCC.mkDerivation {
  pname = "ponytail";
  version = "4.10.0";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@dietrichgebert/ponytail/-/ponytail-4.10.0.tgz";
    hash = "sha512-O2H+RWO0ojk8D8yz9q1F82ybKTXpYtrBb7mHkQT+/iCtsXndAxJo05KU1hkLPjV203ABq+cj89Th9jFvdnc6Mg==";
  };

  installPhase = ''
    mkdir -p "$out"
    cp -R . "$out/"
  '';
}
