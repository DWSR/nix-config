# Prisma 5.17.0 for LiteLLM's Python Prisma client.
#
# The LiteLLM package ships a Prisma schema and prisma-client-py 0.15.0, which pins
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

  # prisma-client-py 0.15.0 with LiteLLM's Prisma models rendered in. LiteLLM
  # imports `prisma` eagerly at startup and never runs a generate or an online
  # CLI install, so the deployed client has to be generated at build time from
  # the same pinned schema the init unit pushes. The base package keeps its
  # Python dependency set; only its installed `prisma` package directory is
  # replaced with the generated one, and the two console scripts are removed
  # afterwards so the proxy's PATH holds no online Prisma CLI.
  litellm-prisma-client = final.python3Packages.prisma.overridePythonAttrs (old: {
    pname = "litellm-prisma-client";

    # The installed metadata still names the upstream distribution (`prisma`),
    # so the generic pname/version consistency check cannot pass for the
    # renamed generated client. The proxy's own import check below covers
    # the runtime behavior that matters.
    dontCheckPythonMetadata = true;

    # The base package's pythonImportsCheck imports the generated package
    # after postInstall; without this the interpreter writes timestamp-based
    # .pyc files into $out and the build output stops being reproducible.
    env.PYTHONDONTWRITEBYTECODE = "1";

    postInstall = (old.postInstall or "") + ''
            schemaDir="$TMPDIR/litellm-prisma-schema"
            generatedDir="$TMPDIR/litellm-prisma-client"
            homeDir="$TMPDIR/litellm-prisma-home"
            mkdir -p "$schemaDir" "$generatedDir" "$homeDir"

            # The pinned LiteLLM package the init unit pushes the schema from: copy
            # its schema and point the prisma-client-py generator at a fixed
            # temporary output directory. A fixed path (not `mktemp -d`) keeps the
            # prisma-formatted schema embedded in the generated package reproducible.
            cp ${final.python3Packages.litellm}/lib/python*/site-packages/litellm/proxy/schema.prisma "$schemaDir/schema.prisma"
            chmod u+w "$schemaDir/schema.prisma"
            ${final.python3.interpreter} - "$schemaDir/schema.prisma" "$generatedDir" <<'PYTHON'
      import re
      import sys

      path, output = sys.argv[1], sys.argv[2]
      with open(path) as file:
          schema = file.read()

      patched, count = re.subn(
          r"generator\s+client\s*\{",
          lambda match: f'{match.group(0)}\n  output = "{output}"',
          schema,
          count=1,
      )
      if count != 1:
          raise SystemExit(f"litellm-prisma-client: no generator client block in {path}")

      with open(path, "w") as file:
          file.write(patched)
      PYTHON

            # `$out/bin` holds the installed prisma-client-py generator the Prisma
            # CLI invokes. The CLI wrapper already points its two engine variables at
            # litellm-prisma-engines, so nothing is downloaded here.
            PATH="$out/bin:$PATH" \
              HOME="$homeDir" \
              CHECKPOINT_DISABLE=1 \
              PRISMA_HIDE_UPDATE_MESSAGE=1 \
              ${final.litellm-prisma-cli}/bin/prisma generate --schema "$schemaDir/schema.prisma"

            # Fail here rather than install an empty package if the generator
            # ever exits zero without writing the models.
            test -f "$generatedDir/client.py" || {
              echo "litellm-prisma-client: prisma generate wrote no client.py" >&2
              exit 1
            }

            # The generator copies the installed package into the output and renders
            # the LiteLLM models over it, so the result is a complete `prisma`
            # package rather than a partial model set.
            sitePackages=$(echo "$out"/lib/python*/site-packages)
            rm -rf "$sitePackages/prisma"
            cp -r "$generatedDir" "$sitePackages/prisma"
            chmod -R u+w "$sitePackages/prisma"

            # Only after the generated package is installed: drop the online Prisma
            # CLI entry points, including their wrapped counterparts, so the proxy's
            # runtime PATH exposes no `prisma` executable at all.
            rm -f "$out/bin/prisma" "$out/bin/prisma-client-py" \
              "$out/bin/.prisma-wrapped" "$out/bin/.prisma-client-py-wrapped"
            rmdir "$out/bin" 2>/dev/null || true
    '';

    meta = (old.meta or { }) // {
      description = "prisma-client-py 0.15.0 with LiteLLM's Prisma schema generated in";
    };
  });

  # The proxy package. `pkgs.litellm` is `toPythonApplication` over
  # `python3Packages.litellm` with the proxy, extra-proxy, and proxy-runtime
  # extras merged into the Python dependency list. `litellm-db` keeps that
  # exact merge shape but replaces the bare `python3Packages.prisma` runtime
  # with the generated `litellm-prisma-client`, so the proxy starts with the
  # client generated from its own `schema.prisma` and never instantiates an
  # ungenerated one. No Prisma CLI, generation, or download happens at run
  # time: the only `prisma` module in the closure is the generated client, and
  # that package installs no `bin/prisma`.
  litellm-db =
    let
      litellm = final.python3Packages.litellm;
      prismaClient = final.litellm-prisma-client;

      # The cached upstream `litellm` package stays untouched: rebuilding it
      # just to swap one runtime dependency recompiles its Rust bridge (and
      # can exhaust a builder's memory). Assemble the proxy environment from
      # the package's own proxy/extra-proxy/proxy-runtime extras instead,
      # replacing `prisma` in the package set with the generated client. The
      # override also catches transitive references, so the only `prisma`
      # module in the environment is the generated client.
      litellmPython = final.python3.override {
        packageOverrides = _pyfinal: _pyprev: {
          prisma = prismaClient;
        };
      };

      litellmProxy =
        (litellmPython.withPackages (
          pythonPackages:
          [
            pythonPackages.litellm
            prismaClient
          ]
          ++ pythonPackages.litellm.optional-dependencies.proxy
          ++ pythonPackages.litellm.optional-dependencies.extra_proxy
          ++ pythonPackages.litellm.optional-dependencies.proxy-runtime
        )).overrideAttrs
          (old: {
            pname = "litellm";
            inherit (litellm) version;
            meta = (old.meta or { }) // {
              inherit (litellm.meta) description homepage license;
              mainProgram = "litellm";
            };
          });

      # Runs against the proxy's own runtime closure: the withPackages
      # environment puts every selected package's site-packages on
      # PYTHONPATH. Both imports are connection-free, so no PostgreSQL socket
      # and no `DATABASE_URL` are needed.
      prismaClientCheck = ''
        import os
        import prisma
        from prisma import Prisma
        from prisma.models import LiteLLM_BudgetTable
        from litellm.proxy.db import prisma_client

        prisma_file = os.path.realpath(prisma.__file__)
        assert "litellm-prisma-client" in prisma_file, (
            f"prisma resolved to {prisma_file}, not the generated client"
        )
        assert LiteLLM_BudgetTable.__name__ == "LiteLLM_BudgetTable"
        assert prisma_client.PrismaWrapper is not None
        print(f"imported {Prisma} and {prisma_client.PrismaWrapper} from {prisma.__file__}")
      '';

      prismaClientTest =
        final.runCommand "litellm-db-prisma-client-test"
          {
            nativeBuildInputs = [ litellmProxy ];
          }
          ''
            echo "litellm-db: the proxy ships LiteLLM's schema"
            test -f "${litellmProxy}/${final.python3.sitePackages}/litellm/proxy/schema.prisma"

            echo "litellm-db: importing prisma.Prisma and LiteLLM's prisma_client"
            unset DATABASE_URL
            # The withPackages wrapper exports the env's certificate bundle;
            # this connection-free import has no need for it and the build
            # sandbox does not carry that path.
            unset SSL_CERT_FILE
            ${litellmProxy}/bin/python3 -c ${final.lib.escapeShellArg prismaClientCheck}

            echo "litellm-db: the proxy runtime exposes no Prisma CLI"
            if command -v prisma > /dev/null; then
              echo "FAIL: $(command -v prisma) is on the proxy's PATH" >&2
              exit 1
            fi

            echo "litellm-db: the proxy CLI reports its pinned version"
            export HOME="$TMPDIR/home"
            mkdir -p "$HOME"
            version=$("${litellmProxy}/bin/litellm" --version 2>&1)
            case "$version" in
              *"LiteLLM: Current Version = ${final.python3Packages.litellm.version}"*) ;;
              *)
                echo "FAIL: litellm --version did not report ${final.python3Packages.litellm.version}:" >&2
                echo "$version" >&2
                exit 1
                ;;
            esac

            echo "litellm-db: all checks passed"
            touch $out
          '';
    in
    litellmProxy.overrideAttrs (oldAttrs: {
      passthru = (oldAttrs.passthru or { }) // {
        schemaPath = "${litellmProxy}/${final.python3.sitePackages}/litellm/proxy/schema.prisma";
        inherit prismaClient;
        prismaVersion = engineVersion;
        tests = (oldAttrs.passthru.tests or { }) // {
          prismaClient = prismaClientTest;
        };
      };
    });
}
