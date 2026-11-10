{ pkgs }:
pkgs.buildNpmPackage {
  pname = "pi-lens";
  version = "4.4.11";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pi-lens/-/pi-lens-4.4.11.tgz";
    hash = "sha256-IQzUX4Shb3Szjxjr7671+GVrQOZqadwFi26I97PG9SQ=";
  };

  postPatch = ''
    cp ${./pi-lens/package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-/wHG2ALEu+ZM06wSjJBkOGyuvh35wAguQOUYUf2D3s0=";
  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp -R . "$out/"
  '';
}
