# MCP server packages — all built as npm packages from the npm registry or GitHub
{ inputs }:
final: _prev:
let
  # Builder for Google Cloud MCP servers that all follow the same pattern:
  # npm registry tarball + local package-lock for importNpmLock
  mkGcloudMcp =
    {
      pname,
      version,
      hash,
      description,
    }:
    final.buildNpmPackage rec {
      inherit pname version;
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/${pname}/-/${pname}-${version}.tgz";
        inherit hash;
      };
      postPatch = ''
        cp ${./${pname}/package.json} package.json
        cp ${./${pname}/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./${pname}; };
      inherit (final.importNpmLock) npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        inherit description;
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = pname;
      };
    };
in
{
  mcp-hub = inputs.mcphub.packages.${final.stdenv.hostPlatform.system}.default;

  # Cross-agent persistent memory for AI coding agents. Built from
  # JuliusBrussee/cavemem v0.2.1 source (a pnpm monorepo) with three
  # cherry-picked upstream patches applied to the TypeScript source
  # before tsup bundles the CLI. The patches must be applied at the
  # source layer (not against the published npm tarball's pre-built
  # dist/) because tsup inlines all `@cavemem/*` workspace packages
  # into `apps/cli/dist/index.js` via `noExternal`.
  #
  # Build layout:
  #   - `pnpm_9.fetchDeps` populates the offline pnpm store from the
  #     vendored `pnpm-lock.yaml`.
  #   - `pnpm_9.configHook` runs `pnpm install --offline
  #     --frozen-lockfile --ignore-scripts`, so native postinstalls
  #     (better-sqlite3) do not run automatically — buildPhase invokes
  #     better-sqlite3's install script explicitly with
  #     `npm_config_build_from_source` and `npm_config_nodedir` set.
  #   - `pnpm --filter cavemem build` runs tsup, producing
  #     `apps/cli/dist/index.js` with all `@cavemem/*` workspace code
  #     inlined via tsup's `noExternal` setting.
  #   - installPhase runs cavemem's upstream `scripts/pack-release.mjs`
  #     to produce a slim publish layout (dist/, hooks-scripts/,
  #     LICENSE, README.md, slim package.json with only the six
  #     third-party runtime deps), then copies the runtime deps from
  #     the workspace pnpm store into the slim layout's node_modules.
  #     `pnpm deploy` would do this in one step but in pnpm 9 it
  #     re-resolves the workspace topology against the network, which
  #     the Nix sandbox forbids.
  #   - `makeWrapper` exposes `bin/cavemem` as a stable absolute path
  #     so the daemon resolves the same Node + entry point on every
  #     invocation (mirrors the `mcp-obsidian` block below).
  cavemem = final.stdenv.mkDerivation (finalAttrs: {
    pname = "cavemem";
    version = "0.2.1";

    src = final.fetchFromGitHub {
      owner = "JuliusBrussee";
      repo = "cavemem";
      tag = "v${finalAttrs.version}";
      hash = "sha256-0YkpwaBYyH/nJCV0Y2EvaFL1KEvVtgf/tN2h1azwdNg=";
    };

    # Bug-fix patches cherry-picked from upstream PRs against the
    # v0.2.1 source tree, plus one written-from-scratch patch for the
    # `CAVEMEM_DATA_DIR` env var (no upstream PR exists). Order matters
    # only insofar as later patches must apply cleanly on top of
    # earlier ones; the four patches touch disjoint files
    # (installers/opencode.ts, config/schema.ts, config/loader.ts,
    # plus core/memory-store.ts + hooks/handlers/session-start.ts +
    # storage/storage.ts for #39), so any order works. The
    # data-dir-env patch is what makes `home.cavemem.dataDir` in the
    # home-manager module actually take effect (cavemem v0.2.1 has no
    # other override mechanism for the hardcoded `~/.cavemem` path).
    patches = [
      ./cavemem-14-hook-payload-shape.patch
      ./cavemem-39-session-start-cwd-filter.patch
      ./cavemem-25-search-alpha-doc.patch
      ./cavemem-data-dir-env.patch
    ];

    pnpmDeps = final.pnpm_9.fetchDeps {
      inherit (finalAttrs) pname version src;
      fetcherVersion = 2;
      hash = "sha256-VmWY7p3bRgj/B0kPltuozEieWD6VOAXL71QMP9Xhunc=";
    };

    nativeBuildInputs = [
      final.nodejs
      final.pnpm_9
      final.pnpm_9.configHook
      final.makeWrapper
      final.python3
    ]
    ++ final.lib.optionals final.stdenv.hostPlatform.isDarwin [
      # better-sqlite3's bundled SQLite amalgamation needs the
      # darwin libtool (cctools) to link the static archive; the
      # default stdenv on darwin does not put it on PATH.
      final.cctools
    ];

    buildPhase = ''
      runHook preBuild

      # The configHook ran pnpm install with --ignore-scripts, so
      # better-sqlite3's prebuild/build postinstall did not run.
      # Force a from-source build (the prebuild-install fallback
      # would try to fetch a prebuilt binary from GitHub, which the
      # Nix sandbox forbids), then run the install script in the
      # workspace store so the native binding is in place when
      # `pnpm deploy` copies the production tree. node-gyp would
      # otherwise try to fetch Node headers from nodejs.org;
      # `npm_config_nodedir` points at the local nixpkgs nodejs
      # which already ships the headers.
      export npm_config_build_from_source=true
      export npm_config_nodedir=${final.nodejs}
      pushd node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3 > /dev/null
      npm run install --foreground-scripts
      popd > /dev/null

      # tsup-bundles apps/cli/src/index.ts → apps/cli/dist/index.js,
      # inlining all @cavemem/* workspace packages.
      pnpm --filter cavemem build

      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall

      # The published `cavemem` npm package is just the built
      # `apps/cli/dist/`, the `hooks-scripts/` directory, README,
      # LICENSE, and a slim package.json that declares ONLY the six
      # third-party runtime deps (commander, kleur, better-sqlite3,
      # hono, @hono/node-server, @modelcontextprotocol/sdk). All
      # `@cavemem/*` workspace packages are inlined into
      # `dist/index.js` by tsup at build time. So at runtime cavemem
      # needs exactly those six deps' source trees on disk plus the
      # already-built native binding for better-sqlite3 (which the
      # buildPhase compiled in the workspace store).
      #
      # `pnpm deploy` would do this neatly but in pnpm 9 it requires
      # network access (it re-resolves the workspace transitively),
      # which the Nix sandbox forbids. Instead, we run the upstream
      # `pack:release` build script (which already knows the slim
      # layout) to produce `apps/cli/release/`, then hand-link the
      # six runtime deps from the workspace store into the release
      # tree's node_modules.
      #
      # `@xenova/transformers` is in optionalDependencies; it is not
      # in the slim package.json's dependencies and therefore not
      # linked here. The downstream cavemem.nix module is responsible
      # for wiring an alternative embedding provider when the operator
      # opts out of the default `local` one (Requirement 3).
      ( cd apps/cli && node scripts/pack-release.mjs )

      mkdir -p $out/lib/node_modules/cavemem
      cp -R apps/cli/release/. $out/lib/node_modules/cavemem/

      mkdir -p $out/lib/node_modules/cavemem/node_modules
      for dep in commander kleur better-sqlite3 hono @hono/node-server \
                 @modelcontextprotocol/sdk; do
        # Resolve the actual workspace store path (each dep is under
        # node_modules/.pnpm/<dep>@<ver>/node_modules/<dep>/) by following
        # the existing symlink in apps/cli/node_modules.
        src=$(readlink -f "apps/cli/node_modules/$dep")
        if [ -z "$src" ] || [ ! -d "$src" ]; then
          echo "ERROR: could not resolve runtime dep '$dep' in workspace store" >&2
          exit 1
        fi
        mkdir -p "$out/lib/node_modules/cavemem/node_modules/$(dirname "$dep")"
        cp -R "$src" "$out/lib/node_modules/cavemem/node_modules/$dep"
      done

      # Same trick for transitive deps that better-sqlite3 + the @hono
      # packages pull in. The Node module resolution algorithm walks
      # parent directories, so we copy these as siblings under
      # node_modules/ rather than nesting them under each consumer.
      for dep in bindings file-uri-to-path; do
        src=$(readlink -f "node_modules/.pnpm/node_modules/$dep" 2>/dev/null \
              || true)
        if [ -n "$src" ] && [ -d "$src" ]; then
          cp -R "$src" "$out/lib/node_modules/cavemem/node_modules/$dep"
        fi
      done

      makeWrapper ${final.nodejs}/bin/node $out/bin/cavemem \
        --add-flags "$out/lib/node_modules/cavemem/dist/index.js"

      runHook postInstall
    '';

    meta = with final.lib; {
      description = "Cross-agent persistent memory for AI coding agents (CLI + MCP server)";
      homepage = "https://github.com/JuliusBrussee/cavemem";
      license = licenses.mit;
      mainProgram = "cavemem";
      platforms = platforms.darwin ++ platforms.linux;
    };
  });

  mcp-obsidian = final.buildNpmPackage {
    pname = "mcp-obsidian";
    version = "0.1.0";

    src = final.fetchFromGitHub {
      owner = "Piotr1215";
      repo = "mcp-obsidian";
      rev = "c99c0644b0229cd880c31ccd16a5fe1347e43078";
      hash = "sha256-6zGlPO4w7iiLJluTvDVEnY7Z/R2pov9Xlu0Qp7xmy7Q=";
    };

    npmDeps = final.importNpmLock {
      npmRoot = final.fetchFromGitHub {
        owner = "Piotr1215";
        repo = "mcp-obsidian";
        rev = "c99c0644b0229cd880c31ccd16a5fe1347e43078";
        hash = "sha256-6zGlPO4w7iiLJluTvDVEnY7Z/R2pov9Xlu0Qp7xmy7Q=";
      };
    };
    inherit (final.importNpmLock) npmConfigHook;
    dontNpmBuild = true;

    postInstall = ''
      makeWrapper ${final.nodejs}/bin/node $out/bin/mcp-obsidian \
        --add-flags "$out/lib/node_modules/obsidian-mcp-filesystem/src/index.js"
    '';

    nativeBuildInputs = [ final.makeWrapper ];

    meta = with final.lib; {
      description = "MCP server for Obsidian vault filesystem operations";
      homepage = "https://github.com/Piotr1215/mcp-obsidian";
      license = licenses.mit;
      mainProgram = "mcp-obsidian";
    };
  };

  chrome-devtools-mcp = final.stdenv.mkDerivation {
    pname = "chrome-devtools-mcp";
    version = "0.21.0";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-0.21.0.tgz";
      hash = "sha256-KMHWSSctf6ihIT792yZeTqaYuHqmUanN2SJje5PI184=";
    };

    dontBuild = true;
    nativeBuildInputs = [ final.makeWrapper ];

    installPhase = ''
      mkdir -p $out/lib/chrome-devtools-mcp
      cp -r . $out/lib/chrome-devtools-mcp/
      makeWrapper ${final.nodejs}/bin/node $out/bin/chrome-devtools-mcp \
        --add-flags "$out/lib/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js"
    '';

    meta = with final.lib; {
      description = "MCP server for Chrome DevTools";
      homepage = "https://github.com/ChromeDevTools/chrome-devtools-mcp";
      license = licenses.asl20;
      mainProgram = "chrome-devtools-mcp";
    };
  };

  buildkite-mcp-server = final.buildGoModule {
    pname = "buildkite-mcp-server";
    version = "1.0.0";

    src = final.fetchFromGitHub {
      owner = "buildkite";
      repo = "buildkite-mcp-server";
      tag = "v1.0.0";
      hash = "sha256-1o/Co34WjtdzlOlDDMfhFo+6wLUj3UFDgcVKrzsXbEk=";
    };

    vendorHash = "sha256-CHe/sCQj4+BLG0mDoNsu8mPBUdKyMgA4BT4T1iQh5ts=";
    subPackages = [ "cmd/buildkite-mcp-server" ];

    meta = with final.lib; {
      description = "MCP server for Buildkite pipelines, builds, jobs, and tests";
      homepage = "https://github.com/buildkite/buildkite-mcp-server";
      license = licenses.mit;
      mainProgram = "buildkite-mcp-server";
    };
  };

  slack-mcp-server = final.buildGoModule {
    pname = "slack-mcp-server";
    version = "1.2.3";
    vendorHash = "sha256-mR+UFQRi98OTCyNISy3e7QTGKusd8XhNW4iz57QvpZE=";
    doCheck = false;

    src = final.fetchFromGitHub {
      owner = "korotovsky";
      repo = "slack-mcp-server";
      tag = "v1.2.3";
      hash = "sha256-AfmuQfV3RqFBw9b8B4aFM0EOuFQrUlUpTnMmQcyvCfU=";
    };
  };

  fastmail-mcp = final.buildNpmPackage {
    pname = "fastmail-mcp";
    version = "1.8.2";

    src = final.fetchFromGitHub {
      owner = "MadLlama25";
      repo = "fastmail-mcp";
      tag = "v1.8.2";
      hash = "sha256-/+fmVf2BUq+vBSOK+igfrp5fkU+RPGkYtYkBEFmZbMY=";
    };

    npmDepsHash = "sha256-/jfgV/H1i+XXM+KMrAtq5XK/a+5BZ1JoEvdxq/r6hkk=";

    meta = with final.lib; {
      description = "MCP server for Fastmail API integration";
      homepage = "https://github.com/MadLlama25/fastmail-mcp";
      license = licenses.mit;
      mainProgram = "fastmail-mcp";
    };
  };

  # Google Cloud MCP servers — all use the same template
  gcloud-mcp = mkGcloudMcp {
    pname = "gcloud-mcp";
    version = "0.5.3";
    hash = "sha256-Q2ujZBp7PH+wS7RASl1y0uWJFk42NHSLnhBpl9206to=";
    description = "MCP server for Google Cloud via gcloud CLI";
  };

  observability-mcp = mkGcloudMcp {
    pname = "observability-mcp";
    version = "0.2.3";
    hash = "sha256-osa+MSVVXZBHS/zA+1vBaybPOsuNzsNOn58zRSU2RzE=";
    description = "MCP server for Google Cloud Observability";
  };

  storage-mcp = mkGcloudMcp {
    pname = "storage-mcp";
    version = "0.3.3";
    hash = "sha256-bXqx4EqmYta8Z1S34FSG/uhZ8OEkHcgR3wen+EDqoh4=";
    description = "MCP server for Google Cloud Storage";
  };

}
