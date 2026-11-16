# Prisma 5.17.0 for LiteLLM's Python Prisma client.
#
# LiteLLM 1.86.0 ships a Prisma schema and prisma-client-py 0.15.0, which pins
# the internal Prisma version to 5.17.0 (engine commit
# 393aa359c9ad4a4bb28630fb5613f9c281cde053). nixpkgs only packages Prisma 6 and
# 7, and prisma-client-py has no release for either, so this overlay pins the
# 5.17.0 npm CLI and its two engines as fixed-output derivations and generates
# LiteLLM's Python client from the pinned schema at build time. Neither the
# client build nor the guest may download an engine or a package: the CLI
# wrapper points at the pre-patched binaries from `litellm-prisma-engines`,
# and the generated package exposes no Prisma CLI.
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

  # LiteLLM imports its Prisma client eagerly but the pinned
  # `python3Packages.prisma` ships only the runtime, not a generated client.
  # Generating it during the build keeps the proxy's start offline: the store
  # package holds the client for LiteLLM's schema, the query engine comes from
  # `litellm-prisma-engines`, and `bin/prisma` is gone so LiteLLM's optional
  # online schema-update branch cannot shell out to one.
  litellm-prisma-client = final.python3Packages.prisma.overridePythonAttrs (
    old:
    let
      sitePackages = final.python3Packages.python.sitePackages;
      litellmSchema = "${final.python3Packages.litellm}/${sitePackages}/litellm/proxy/schema.prisma";
    in
    {
      pname = "litellm-prisma-client";

      # `prisma-client-py` is a Prisma generator: the Node CLI invokes it as a
      # child process and streams the LiteLLM DMMF into it, so the CLI is only
      # a build-time tool and never a runtime dependency.
      nativeBuildInputs = (old.nativeBuildInputs or [ ]) ++ [ final.litellm-prisma-cli ];

      postInstall = (old.postInstall or "") + ''
        buildRoot="$NIX_BUILD_TOP/litellm-prisma-client"
        schema="$buildRoot/schema.prisma"
        pristineSchema="$buildRoot/schema.prisma.orig"
        clientOutput="$buildRoot/prisma"
        rm -rf "$buildRoot"
        mkdir -p "$buildRoot"

        # Take the schema from the pinned LiteLLM package: the generated client
        # and the schema the init unit pushes out of the same `litellm-db`
        # closure therefore describe one LiteLLM release.
        cp ${litellmSchema} "$schema"
        cp "$schema" "$pristineSchema"

        # prisma-client-py writes its package at the generator's `output`, so
        # point it at a build-temporary directory instead of the installed one.
        if ! grep -q 'provider = "prisma-client-py"' "$schema"; then
          echo "litellm-prisma-client: LiteLLM's schema.prisma has no prisma-client-py generator" >&2
          exit 1
        fi
        sed -i "/provider = \"prisma-client-py\"/a\\  output = \"$clientOutput\"" "$schema"

        export HOME="$buildRoot/home"
        export XDG_CACHE_HOME="$HOME/.cache"
        export CHECKPOINT_DISABLE=1
        export PRISMA_HIDE_UPDATE_MESSAGE=true
        mkdir -p "$HOME"

        # `prisma-client-py` is the generator executable; it lives in the base
        # package's own bin until both entry points are removed below.
        PATH="$out/bin:$PATH" ${final.litellm-prisma-cli}/bin/prisma generate --schema "$schema"

        # Put LiteLLM's schema back so the deployed package contains no
        # build-temporary output path and keeps the upstream schema verbatim.
        cp "$pristineSchema" "$clientOutput/schema.prisma"

        rm -rf "$out/${sitePackages}/prisma"
        cp -R "$clientOutput" "$out/${sitePackages}/prisma"

        # The generator records the schema it read; point that at the packaged
        # schema so the store package carries no build-temporary path.
        substituteInPlace "$out/${sitePackages}/prisma/client.py" \
          --replace-fail "$schema" "$out/${sitePackages}/prisma/schema.prisma"

        # The copied __pycache__ carries the base package's build-time mtime,
        # which differs on every rebuild. recompile with checked-hash
        # invalidation so the shipped bytecode depends only on the sources and
        # their store paths, and stop later phases from adding time-stamped
        # entries.
        find "$out/${sitePackages}/prisma" -name __pycache__ -type d -prune -exec rm -rf {} +
        python -m compileall -q --invalidation-mode checked-hash "$out/${sitePackages}/prisma"
        export PYTHONDONTWRITEBYTECODE=1

        # Only now drop the Python Prisma CLI: generation needed it, but the
        # proxy must find no executable for LiteLLM's online schema branch.
        rm -f "$out/bin/prisma" "$out/bin/prisma-client-py" \
              "$out/bin/.prisma-wrapped" "$out/bin/.prisma-client-py-wrapped"
      '';

      # The base package declares `doCheck = false` because `prisma generate`
      # needs a network. Generation is offline here, so run the install check
      # below and fail the build if the store package is not a usable client.
      doCheck = true;
      installCheckPhase = ''
        runHook preInstallCheck

        client="$out/${sitePackages}/prisma"

        if [ ! -f "$client/client.py" ] || [ ! -f "$client/models.py" ]; then
          echo "litellm-prisma-client: prisma generate did not write a client into $client" >&2
          exit 1
        fi
        if ! grep -q 'LiteLLM_VerificationToken' "$client/models.py"; then
          echo "litellm-prisma-client: generated client does not model LiteLLM_VerificationToken" >&2
          exit 1
        fi
        if ! grep -q '${final.litellm-prisma-engines}/bin/query-engine' "$client/client.py"; then
          echo "litellm-prisma-client: generated client does not point at the pinned query engine" >&2
          exit 1
        fi
        if ! cmp -s ${litellmSchema} "$client/schema.prisma"; then
          echo "litellm-prisma-client: generated client does not ship LiteLLM's schema.prisma" >&2
          exit 1
        fi
        if ! grep -q "SCHEMA_PATH = Path('$client/schema.prisma')" "$client/client.py"; then
          echo "litellm-prisma-client: generated client does not point SCHEMA_PATH at the packaged schema" >&2
          exit 1
        fi
        if grep -q "$NIX_BUILD_TOP/litellm-prisma-client" "$client/client.py"; then
          echo "litellm-prisma-client: generated client still contains a build-temporary path" >&2
          exit 1
        fi

        # `from prisma import Prisma` must resolve to the generated class, not
        # to the base package's stub that only raises at instantiation.
        PYTHONPATH="$out/${sitePackages}''${PYTHONPATH:+:$PYTHONPATH}" python -c \
          'from prisma import Prisma; import prisma.client; assert Prisma is prisma.client.Prisma, "prisma.Prisma is not the generated client"'

        if [ -n "$(find "$out/bin" -maxdepth 1 -name '*prisma*' -print -quit)" ]; then
          echo "litellm-prisma-client: $out/bin still exposes a prisma executable" >&2
          exit 1
        fi
        if PATH="$out/bin" command -v prisma >/dev/null 2>&1; then
          echo "litellm-prisma-client: the package exposes a prisma executable" >&2
          exit 1
        fi

        echo "litellm-prisma-client: generated client, pinned engine, and CLI removal verified"

        runHook postInstallCheck
      '';

      meta = (old.meta or { }) // {
        description = "Generated Prisma client for LiteLLM's proxy schema";
        platforms = [ "aarch64-linux" ];
      };
    }
  );
}
