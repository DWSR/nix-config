{ pkgs }:
pkgs.buildNpmPackage {
  pname = "pi-lens";
  version = "4.1.6";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pi-lens/-/pi-lens-4.1.6.tgz";
    hash = "sha512-PnVCEumGiMOUQ6t6zvr2EJl+r6IhALYwuReufQ1FUHKrSNoCsdb/dUws1l2U0nPRKibgJlaJFM4uM46TDrafNA==";
  };

  postPatch = ''
    cp ${./pi-lens/package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-i7e4kmrBq6oLb/aQXm37DJBemDHzdQ52DuQbGcEcyns=";
  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp -R . "$out/"
  '';
}
