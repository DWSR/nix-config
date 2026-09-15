{
  pkgs,
  source ? pkgs.fetchFromGitHub {
    owner = "nicobailon";
    repo = "pi-subagents";
    rev = "f3ccf47dc236b6c0fcc0d897cec4a9e6da3e916d";
    hash = "sha256-YamJDmW49sKG1FUhGcJZobeKZSWD/hWjHiSvi1kur54=";
  },
}:
pkgs.buildNpmPackage {
  pname = "pi-subagents";
  version = "0.68.0";
  src = source;

  npmDepsHash = "sha256-nOPUvjttX8kkUdXSCSf+/OMx9APy5cfJTbt837oNY0Y=";
  dontNpmBuild = true;

  installPhase = ''
    npm prune --omit=dev --ignore-scripts
    mkdir -p "$out"
    cp index.ts package.json package-lock.json README.md CHANGELOG.md "$out/"
    cp -R agents docs prompts skills src "$out/"
    cp -R ./*.mjs "$out/"
    cp -R node_modules "$out/node_modules"
  '';
}
