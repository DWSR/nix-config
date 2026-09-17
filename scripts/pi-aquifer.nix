{
  pkgs,
  src,
}:

pkgs.stdenvNoCC.mkDerivation {
  pname = "pi-aquifer";
  version = "39d16f0";
  inherit src;

  installPhase = ''
    mkdir -p "$out"
    cp -R extensions/aquifer/. "$out/"
  '';
}
