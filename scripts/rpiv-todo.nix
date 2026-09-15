{
  pkgs,
  source ? pkgs.fetchurl {
    url = "https://registry.npmjs.org/@juicesharp/rpiv-todo/-/rpiv-todo-2.10.1.tgz";
    hash = "sha256-a1tVGhYwgRZFab8V6Za7/oanrCeeyWJgEsL3P06Yn04=";
  },
}:
pkgs.buildNpmPackage {
  pname = "rpiv-todo";
  version = "2.10.1";
  src = source;

  postPatch = ''
    cp ${./rpiv-todo/package-lock.json} package-lock.json
  '';

  npmDepsHash = "sha256-O11awPuzKM49y9X11yKuJKpGVX+xp31U3RQuQDsWOyQ=";
  npmInstallFlags = [ "--legacy-peer-deps" ];
  npmPruneFlags = [
    "--legacy-peer-deps"
    "--omit=dev"
  ];
  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp config.ts index.ts package.json LICENSE README.md todo-overlay.ts todo.ts "$out/"
    cp -R docs locales state tool view "$out/"
    cp -R node_modules "$out/node_modules"
  '';
}
