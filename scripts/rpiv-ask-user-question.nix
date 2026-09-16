{ pkgs }:
pkgs.buildNpmPackage {
  pname = "rpiv-ask-user-question";
  version = "2.10.1";

  src = pkgs.fetchurl {
    url = "https://registry.npmjs.org/@juicesharp/rpiv-ask-user-question/-/rpiv-ask-user-question-2.10.1.tgz";
    hash = "sha512-7DBrnso9jv99OaK9cLfBIPv+qK0n4OrQ8I8gfi1tnYZcDLG8Kj/acuC7MLFlzcvc4F1PtAak342emSR9W/O5GQ==";
  };

  postPatch = ''
    cp ${./rpiv-ask-user-question/package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-fB+/Vd0pwPSVJG24Kf5VBePgGhbrKbbUbNWb7wv3crQ=";
  npmInstallFlags = [ "--legacy-peer-deps" ];
  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp -R . "$out/"
  '';
}
