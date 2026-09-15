{
  pkgs,
  src,
}:
pkgs.buildNpmPackage {
  pname = "pi-mcpproxy-go";
  version = "0.1.0";
  inherit src;

  npmDepsHash = "sha256-uJzdpQ8ebpZsZthe2269WP5Xu+KJxDctYYEStuLJFQk=";
  dontNpmBuild = true;

  installPhase = ''
    mkdir -p "$out"
    cp index.ts "$out/index.ts"
    cp -R node_modules "$out/node_modules"
  '';
}
