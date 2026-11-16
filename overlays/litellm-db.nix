# Prisma 5.17.0 for LiteLLM's Python Prisma client.
#
# LiteLLM 1.86.0 ships a Prisma schema and prisma-client-py 0.15.0, which pins
# the internal Prisma version to 5.17.0 (engine commit
# 393aa359c9ad4a4bb28630fb5613f9c281cde053). nixpkgs only packages Prisma 6 and
# 7, and prisma-client-py has no release for either, so this overlay pins the
# 5.17.0 npm CLI and its two engines as fixed-output derivations. Neither the
# CLI build nor the guest may download an engine: the CLI wrapper points at
# the pre-patched binaries from `litellm-prisma-engines`.
final: _prev:
let
  engineCommit = "393aa359c9ad4a4bb28630fb5613f9c281cde053";
  engineVersion = "5.17.0";
  enginePlatform = "linux-arm64-openssl-3.0.x";

  queryEngine = final.fetchurl {
    url = "https://binaries.prisma.sh/all_commits/${engineCommit}/${enginePlatform}/query-engine.gz";
    hash = "sha256-NlQlgnjHsYEsDHopmt0XdxQaKYtuu3LqvbXK04oOjSA=";
  };

  schemaEngine = final.fetchurl {
    url = "https://binaries.prisma.sh/all_commits/${engineCommit}/${enginePlatform}/schema-engine.gz";
    hash = "sha256-aAH6ieyw7xq+ncAkcmH/m0fKqw7SjyIp4KKJ7+Fk+NA=";
  };
in
{
  litellm-prisma-engines = final.stdenv.mkDerivation {
    pname = "litellm-prisma-engines";
    version = engineVersion;

    # The upstream artifacts are gzipped, dynamically linked executables with
    # an unpatched /lib/ld-linux-aarch64.so.1 interpreter. autoPatchelfHook
    # gives them a Nix glibc interpreter and an RPATH for libssl/libcrypto and
    # libgcc_s; no engine is downloaded while the CLI or the proxy runs.
    dontUnpack = true;
    nativeBuildInputs = [
      final.autoPatchelfHook
      final.gzip
    ];
    buildInputs = [
      final.glibc
      final.openssl
      final.stdenv.cc.cc.lib
    ];
    dontStrip = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin"
      gzip -dc ${queryEngine} > "$out/bin/query-engine"
      gzip -dc ${schemaEngine} > "$out/bin/schema-engine"
      chmod 0555 "$out/bin/query-engine" "$out/bin/schema-engine"

      runHook postInstall
    '';

    passthru = {
      inherit engineCommit;
    };

    meta = with final.lib; {
      description = "Pinned Prisma ${engineVersion} query and schema engines for LiteLLM";
      homepage = "https://www.prisma.io";
      license = licenses.asl20;
      platforms = [ "aarch64-linux" ];
      mainProgram = "query-engine";
    };
  };

  litellm-prisma-cli = final.buildNpmPackage {
    pname = "litellm-prisma-cli";
    version = engineVersion;

    src = final.fetchurl {
      url = "https://registry.npmjs.org/prisma/-/prisma-${engineVersion}.tgz";
      hash = "sha256-irvPnYL4FymHSC9i2QPI2/ImZIBwAJfIBuBhlWkcH6g=";
    };

    # Replace the registry package.json (which carries the full devDependency
    # tree and an install script) with the minimal manifest and lock this
    # overlay owns. importNpmLock then fetches exactly that closure.
    postPatch = ''
      cp ${./litellm-prisma/package.json} package.json
      cp ${./litellm-prisma/package-lock.json} package-lock.json
    '';

    npmDeps = final.importNpmLock {
      npmRoot = ./litellm-prisma;
    };
    inherit (final.importNpmLock) npmConfigHook;
    env.NPM_CONFIG_IGNORE_SCRIPTS = "1";

    dontNpmBuild = true;

    nativeBuildInputs = [ final.makeWrapper ];
    postInstall = ''
      wrapProgram "$out/bin/prisma" \
        --set PRISMA_SCHEMA_ENGINE_BINARY ${final.litellm-prisma-engines}/bin/schema-engine \
        --set PRISMA_QUERY_ENGINE_BINARY ${final.litellm-prisma-engines}/bin/query-engine \
        --set PRISMA_CLI_QUERY_ENGINE_TYPE binary \
        --prefix PATH : ${final.lib.makeBinPath [ final.openssl ]}
    '';

    passthru = {
      inherit engineCommit;
      engines = final.litellm-prisma-engines;
    };

    meta = with final.lib; {
      description = "Pinned Prisma ${engineVersion} CLI for LiteLLM's generated client";
      homepage = "https://www.prisma.io";
      license = licenses.asl20;
      platforms = [ "aarch64-linux" ];
      mainProgram = "prisma";
    };
  };
}
