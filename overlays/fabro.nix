# Fabro (fabro-sh/fabro): workflow engine orchestrating AI agents, shell
# commands, and human approval gates as Graphviz DOT graphs, with a Rust API
# server and embedded web UI. Distributed upstream as a single
# self-contained Rust binary. Packaged from the pinned upstream release
# tarball rather than from source: the official build requires `bun
# install` + `cargo dev spa refresh` (a Bun web-UI build feeding
# `rust-embed`) before `cargo build`, and nixpkgs has no bun.lock builder
# to reproduce that pipeline.
#
# Bumps: update `version`, refresh the three `hash` values from the
# matching `fabro-<triple>.tar.gz.sha256` release assets, and confirm
# `fabro version` reports the tag.
final: _prev:
let
  # v0.382.0-nightly.0, tagged 2026-10-10 from
  # 5f82fb086e767576ccb2437fa2cd75d0a3957473 (the `fabro version` Git SHA).
  # This is the same build channel `brew install fabro-sh/tap/fabro-nightly`
  # ships; the stable channel publishes far less frequently.
  version = "0.382.0-nightly.0";

  # Upstream release tarballs per system. There is no x86_64-darwin
  # artifact; Linux uses the fully static musl binaries so no
  # autoPatchelf pass is needed under nixpkgs' glibc. Hashes are the
  # sha256 sums published as `fabro-<triple>.tar.gz.sha256` alongside the
  # tarball (SLSA Build Provenance attestations cover both).
  targets = {
    "aarch64-darwin" = {
      triple = "aarch64-apple-darwin";
      hash = "sha256-1iL7f4eZYFNEakJZc33uS4lHMXI8IYjBhy/VyJWbLXo=";
    };
    "aarch64-linux" = {
      triple = "aarch64-unknown-linux-musl";
      hash = "sha256-lciGRx8LLAIMxSLseGBii4YvjmBAXaqc/kMTHoYJO74=";
    };
    "x86_64-linux" = {
      triple = "x86_64-unknown-linux-musl";
      hash = "sha256-aUwToQtU3ajTA0efxRVXBn3JsRMWPyL6mTM2gzJa0e4=";
    };
  };
in
{
  fabro =
    let
      system = final.stdenv.hostPlatform.system;
      target = targets.${system} or (throw "fabro: upstream publishes no release artifact for ${system}");
    in
    final.stdenvNoCC.mkDerivation {
      pname = "fabro";
      inherit version;

      src = final.fetchurl {
        url = "https://github.com/fabro-sh/fabro/releases/download/v${version}/fabro-${target.triple}.tar.gz";
        inherit (target) hash;
      };

      sourceRoot = "fabro-${target.triple}";

      # Install the upstream binary verbatim. The release build strips
      # itself (`strip = true` in upstream's release profile) and the
      # macOS binary is ad-hoc linker-signed — arm64 refuses to exec a
      # modified-signature binary, so fixupPhase (which would strip) must
      # never touch its bytes.
      dontConfigure = true;
      dontBuild = true;
      dontFixup = true;

      installPhase = ''
        runHook preInstall

        install -Dm755 fabro "$out/bin/fabro"

        runHook postInstall
      '';

      meta = {
        description = "The open source dark software factory for expert engineers";
        longDescription = ''
          Fabro orchestrates AI coding agents, shell commands, and human
          approval gates as version-controlled Graphviz DOT workflow graphs,
          with a Rust API server, embedded web UI, and git checkpointing.
          Packaged from upstream's release binary because the official
          source build requires a Bun web-UI build (`cargo dev spa refresh`)
          that nixpkgs' cargo packaging cannot reproduce.
        '';
        homepage = "https://fabro.sh/";
        changelog = "https://docs.fabro.sh/changelog";
        license = final.lib.licenses.mit;
        mainProgram = "fabro";
        sourceProvenance = with final.lib.sourceTypes; [ binaryNativeCode ];
        platforms = final.lib.attrNames targets;
      };
    };
}
