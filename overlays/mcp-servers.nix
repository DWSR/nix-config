# MCP server packages — all built as npm packages from the npm registry or GitHub
_: final: _prev:
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
  # ast-grep MCP server — Python stdio server providing structural code search
  # via the ast-grep CLI. Pinned to commit 732c339 (no release tags upstream).
  # The upstream pyproject.toml has no [build-system] table, so we use a
  # wrapper derivation: copy main.py into the store, then wrap it with a
  # python313.withPackages interpreter that has all three runtime deps
  # (mcp, pydantic, pyyaml) pre-installed. The wrapper also prepends
  # pkgs.ast-grep to PATH so the server can invoke `sg` at runtime.
  #
  # Startup and configuration behavior (verified at 0.1.0 / commit 732c339):
  #   - `ast-grep-mcp --help` exits 0 with argparse usage; no server starts.
  #   - Default transport is stdio. No project path, secret, or writable CWD
  #     is required at startup; the server starts cleanly from any CWD
  #     (including read-only paths such as /nix/store) and exits on EOF.
  #   - `--config PATH` and `AST_GREP_CONFIG=PATH` are optional. When set,
  #     the path must exist at startup — the server exits 1 immediately if
  #     the file is absent. Leave both unset for the default configuration.
  #   - Search tools (`find_code`, `find_code_by_rule`) require an explicit
  #     absolute `project_folder` argument; they are never invoked at startup.
  ast-grep-mcp =
    let
      python = final.python313.withPackages (
        ps: with ps; [
          mcp
          pydantic
          pyyaml
        ]
      );
    in
    final.stdenv.mkDerivation {
      pname = "ast-grep-mcp";
      version = "0.1.0";

      src = final.fetchFromGitHub {
        owner = "ast-grep";
        repo = "ast-grep-mcp";
        rev = "732c339c3812a44e9111e6c3aefec64894acd58f";
        hash = "sha256-jsKJRr68MsYUy+3siEag+6WAMXHgGug5xkG0Mq3voas=";
      };

      dontBuild = true;
      nativeBuildInputs = [ final.makeWrapper ];

      installPhase = ''
        runHook preInstall

        mkdir -p $out/lib/ast-grep-mcp
        cp main.py $out/lib/ast-grep-mcp/main.py

        makeWrapper ${python}/bin/python $out/bin/ast-grep-mcp \
          --add-flags "$out/lib/ast-grep-mcp/main.py" \
          --prefix PATH : ${final.ast-grep}/bin

        runHook postInstall
      '';

      meta = with final.lib; {
        description = "MCP server for structural code search via ast-grep";
        homepage = "https://github.com/ast-grep/ast-grep-mcp";
        license = licenses.mit;
        mainProgram = "ast-grep-mcp";
        platforms = platforms.unix;
      };
    };

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
      # LICENSE, and a slim package.json that declares the six
      # third-party runtime deps (commander, kleur, better-sqlite3,
      # hono, @hono/node-server, @modelcontextprotocol/sdk). All
      # `@cavemem/*` workspace packages are inlined into
      # `dist/index.js` by tsup at build time. So at runtime cavemem
      # needs those six deps' source trees on disk plus the
      # already-built native binding for better-sqlite3 (which the
      # buildPhase compiled in the workspace store).
      #
      # `pnpm deploy` would do this neatly but in pnpm 9 it requires
      # network access (it re-resolves the workspace transitively),
      # which the Nix sandbox forbids. Instead, we run the upstream
      # `pack:release` build script (which already knows the slim
      # layout) to produce `apps/cli/release/`, then hand-link the
      # runtime deps (and their transitive runtime closure) from the
      # workspace store into the release tree's node_modules.
      #
      # The slim package.json declares only the six top-level deps,
      # but at runtime `@modelcontextprotocol/sdk` `require()`s zod,
      # zod-to-json-schema, ajv, ajv-formats, content-type, cors,
      # cross-spawn, eventsource, eventsource-parser, express,
      # express-rate-limit, jose, json-schema-typed, pkce-challenge,
      # and raw-body. Subcommands like `cavemem --version` happen to
      # work without those because they don't import the SDK, but
      # `cavemem mcp` (and the smoke test's stdio probe of
      # `tools/list`) crashes at startup with "Cannot find package
      # 'zod'" if any of them are missing. To avoid maintaining a
      # hand-curated mirror of the SDK's transitive closure (and
      # express's, which is non-trivial), we walk each runtime dep's
      # `package.json` and copy every `dependencies` entry transitively
      # into the same flat `node_modules/` directory. Node's module
      # resolution walks parent directories, so a flat layout under
      # `$out/lib/node_modules/cavemem/node_modules/` resolves all of
      # them correctly regardless of who imports whom.
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

      # Recursive runtime-dep copier. For each requested dep:
      #   1. Resolve the on-disk path by trying app-level, then
      #      workspace-root, then the pnpm content-addressed store
      #      under `node_modules/.pnpm/<escaped>@*/node_modules/<dep>`
      #      (pnpm encodes `/` as `+` in scoped store dir names).
      #   2. cp -R the resolved path into the output's flat
      #      node_modules.
      #   3. Read the dep's own `package.json`, enqueue every
      #      `dependencies` entry, and recurse. An associative array
      #      memoises already-copied deps so the closure is computed
      #      exactly once per dep.
      declare -A copied_deps

      resolve_dep() {
        local dep=$1
        local s candidate
        for candidate in "apps/cli/node_modules/$dep" "node_modules/$dep"; do
          if [ -e "$candidate" ]; then
            s=$(readlink -f "$candidate" 2>/dev/null || true)
            if [ -n "$s" ] && [ -d "$s" ]; then
              echo "$s"
              return 0
            fi
          fi
        done
        # Fall back to scanning the pnpm content-addressed store.
        local escaped="''${dep//\//+}"
        for candidate in node_modules/.pnpm/"$escaped"@*/node_modules/"$dep"; do
          if [ -d "$candidate" ]; then
            s=$(readlink -f "$candidate" 2>/dev/null || true)
            if [ -n "$s" ] && [ -d "$s" ]; then
              echo "$s"
              return 0
            fi
          fi
        done
        return 1
      }

      copy_dep() {
        local dep=$1
        if [ -n "''${copied_deps[$dep]:-}" ]; then return 0; fi
        copied_deps[$dep]=1

        local src
        src=$(resolve_dep "$dep" || true)
        if [ -z "$src" ]; then
          echo "ERROR: could not resolve runtime dep '$dep' in workspace store" >&2
          exit 1
        fi

        mkdir -p "$out/lib/node_modules/cavemem/node_modules/$(dirname "$dep")"
        cp -R "$src" "$out/lib/node_modules/cavemem/node_modules/$dep"

        # Enqueue this dep's own runtime dependencies. Use node to
        # parse package.json so we don't depend on jq being on PATH.
        local pkgjson="$src/package.json"
        if [ -f "$pkgjson" ]; then
          local tdep
          while IFS= read -r tdep; do
            [ -z "$tdep" ] && continue
            copy_dep "$tdep"
          done < <(node -e "const p=require('$pkgjson');console.log(Object.keys(p.dependencies||{}).join('\n'))" 2>/dev/null || true)
        fi
      }

      # RUNTIME_DEPS: the slim package.json's six top-level deps plus
      # the MCP SDK's runtime imports (which the SDK's own package.json
      # declares). Their transitive closures (e.g. express's accepts,
      # body-parser, finalhandler, ...) are pulled in automatically by
      # copy_dep walking each package.json.
      for dep in commander kleur better-sqlite3 hono @hono/node-server \
                 @modelcontextprotocol/sdk \
                 zod zod-to-json-schema ajv ajv-formats content-type \
                 cors cross-spawn eventsource eventsource-parser \
                 express express-rate-limit jose json-schema-typed \
                 pkce-challenge raw-body; do
        copy_dep "$dep"
      done

      # better-sqlite3 historically pulls in `bindings` and
      # `file-uri-to-path` via internal require() calls that aren't
      # always in its `dependencies` field (older versions, or when
      # bundled via prebuild-install). Keep an explicit fallback for
      # those so a future better-sqlite3 bump doesn't silently break
      # the native binding loader.
      for dep in bindings file-uri-to-path; do
        if [ -z "''${copied_deps[$dep]:-}" ]; then
          src=$(readlink -f "node_modules/.pnpm/node_modules/$dep" 2>/dev/null \
                || true)
          if [ -n "$src" ] && [ -d "$src" ]; then
            cp -R "$src" "$out/lib/node_modules/cavemem/node_modules/$dep"
            copied_deps[$dep]=1
          fi
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

  # Vendored Node dependency tree for the `cavemem-import-vault`
  # one-shot importer (task 7.1, requirements 8.1 and 8.6). The
  # importer is a Node script that needs `require()`-able copies of
  # `better-sqlite3` (to write directly to cavemem.db) and `js-yaml`
  # (to parse the YAML frontmatter of existing transcription/summary
  # `.md` notes). It deliberately does NOT reuse the cavemem
  # package's bundled better-sqlite3 because cavemem packs its
  # runtime deps into a private `node_modules` under
  # `$out/lib/node_modules/cavemem/node_modules/` and they are not
  # discoverable from outside that tree.
  #
  # Layout mirrors `mkGcloudMcp`: a hand-written `package.json`
  # pinning the two top-level deps and a generated `package-lock.json`
  # (produced once via `npm install --package-lock-only` and
  # committed) live in a sibling subdir
  # `overlays/cavemem-importer-deps/`. `buildNpmPackage` +
  # `importNpmLock` run `npm ci` offline against the vendored lock,
  # and the better-sqlite3 postinstall compiles its native binding
  # from source (the bundled `prebuild-install` would otherwise try
  # to fetch a prebuilt binary from GitHub, which the Nix sandbox
  # forbids).
  cavemem-importer-deps = final.buildNpmPackage {
    pname = "cavemem-importer-deps";
    version = "0.0.1";

    src = ./cavemem-importer-deps;

    npmDeps = final.importNpmLock { npmRoot = ./cavemem-importer-deps; };
    inherit (final.importNpmLock) npmConfigHook;
    dontNpmBuild = true;

    nativeBuildInputs = [
      final.nodejs
      final.python3
    ]
    ++ final.lib.optionals final.stdenv.hostPlatform.isDarwin [
      # better-sqlite3's bundled SQLite amalgamation needs the darwin
      # libtool (cctools) to link the static archive; the default
      # stdenv on darwin does not put it on PATH. Mirrors the cavemem
      # package above.
      final.cctools
    ];

    preBuild = ''
      # Force better-sqlite3 to compile from source instead of letting
      # `prebuild-install` reach out to GitHub for a prebuilt binary;
      # `npm_config_nodedir` points node-gyp at the local nodejs which
      # already ships the headers it needs (otherwise node-gyp would
      # try to fetch them from nodejs.org).
      export npm_config_build_from_source=true
      export npm_config_nodedir=${final.nodejs}
    '';

    # The default `buildNpmPackage` install phase assumes the package
    # ships a `bin` field and copies the project under
    # `$out/lib/node_modules/<pname>/`. We just want a flat
    # `node_modules` tree the importer script can `require()` from,
    # so we override the install phase and copy the resolved
    # `node_modules/` contents straight into `$out/lib/node_modules/`.
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/node_modules
      cp -R node_modules/. $out/lib/node_modules/
      runHook postInstall
    '';

    meta = with final.lib; {
      description = "Vendored Node deps (better-sqlite3 + js-yaml) for the cavemem-import-vault one-shot importer";
      homepage = "https://github.com/JuliusBrussee/cavemem";
      license = licenses.mit;
      platforms = platforms.darwin ++ platforms.linux;
    };
  };

  # Vendored Node dependency tree for the `opencode-cost-diagnosis`
  # CLI (spec `opencode-cost-diagnosis`, design Technology Stack). The
  # diagnostic is a Node script that needs `require()`-able copies of
  # `better-sqlite3` (to read the opencode SQLite databases) and
  # `tiktoken` (WASM tokenizer used for proportional splits of
  # uncached input). It deliberately does NOT reuse the
  # cavemem-importer-deps tree because the dependency sets differ
  # (cavemem-importer uses js-yaml; this diagnostic uses tiktoken),
  # and keeping them separate avoids unrelated lockfile churn on
  # either side.
  #
  # Layout mirrors `cavemem-importer-deps`: a hand-written
  # `package.json` pinning the two top-level deps and a generated
  # `package-lock.json` (produced via `npm install --package-lock-only`
  # and committed) live in a sibling subdir
  # `overlays/opencode-cost-diagnosis-deps/`. `buildNpmPackage` +
  # `importNpmLock` run `npm ci` offline against the vendored lock,
  # and the better-sqlite3 postinstall compiles its native binding
  # from source (the bundled `prebuild-install` would otherwise try
  # to fetch a prebuilt binary from GitHub, which the Nix sandbox
  # forbids). `tiktoken` ships a `.wasm` blob and needs no native
  # compilation, but the same build invocation handles both via the
  # single lockfile.
  opencode-cost-diagnosis-deps = final.buildNpmPackage {
    pname = "opencode-cost-diagnosis-deps";
    version = "0.0.1";

    src = ./opencode-cost-diagnosis-deps;

    npmDeps = final.importNpmLock { npmRoot = ./opencode-cost-diagnosis-deps; };
    inherit (final.importNpmLock) npmConfigHook;
    dontNpmBuild = true;

    nativeBuildInputs = [
      final.nodejs
      final.python3
    ]
    ++ final.lib.optionals final.stdenv.hostPlatform.isDarwin [
      # better-sqlite3's bundled SQLite amalgamation needs the darwin
      # libtool (cctools) to link the static archive; the default
      # stdenv on darwin does not put it on PATH. Mirrors the
      # cavemem-importer-deps derivation above.
      final.cctools
    ];

    preBuild = ''
      # Force better-sqlite3 to compile from source instead of letting
      # `prebuild-install` reach out to GitHub for a prebuilt binary;
      # `npm_config_nodedir` points node-gyp at the local nodejs which
      # already ships the headers it needs (otherwise node-gyp would
      # try to fetch them from nodejs.org).
      export npm_config_build_from_source=true
      export npm_config_nodedir=${final.nodejs}
    '';

    # The default `buildNpmPackage` install phase assumes the package
    # ships a `bin` field and copies the project under
    # `$out/lib/node_modules/<pname>/`. We just want a flat
    # `node_modules` tree the diagnostic script can `require()` from
    # via `NODE_PATH`, so we override the install phase and copy the
    # resolved `node_modules/` contents straight into
    # `$out/lib/node_modules/`.
    installPhase = ''
      runHook preInstall
      mkdir -p $out/lib/node_modules
      cp -R node_modules/. $out/lib/node_modules/
      runHook postInstall
    '';

    meta = with final.lib; {
      description = "Vendored Node deps (better-sqlite3 + tiktoken) for the opencode-cost-diagnosis CLI";
      license = licenses.mit;
      platforms = platforms.darwin ++ platforms.linux;
    };
  };

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

  # grep.app MCP server — TypeScript stdio server that provides code search
  # across public GitHub repositories via the grep.app API. Pinned to the
  # HEAD commit (2f9514) since the upstream has no release tags. The build
  # runs `tsc` to compile src/ → dist/ and the wrapper points at
  # dist/server-stdio.js, which is the stdio MCP entrypoint documented in
  # the upstream README.
  #
  # Runtime write behaviour: dist/core/logger.js unconditionally creates
  # `logs/` relative to process.cwd() at module load time (before any tool
  # call) and opens two DailyRotateFile transports there. Running from a
  # read-only CWD (e.g. the Nix store or /) causes an immediate EACCES
  # crash. The wrapper uses `--run 'cd "$HOME"'` so logs land in ~/logs/,
  # which is always writable. The upstream has no --help/--version path;
  # it starts the full stdio server immediately on invocation.
  grep-app-mcp = final.buildNpmPackage {
    pname = "grep-app-mcp";
    version = "1.0.0";

    src = final.fetchFromGitHub {
      owner = "ai-tools-all";
      repo = "grep_app_mcp";
      rev = "2f9514295d5c9352576c425d7dc9303f0f365905";
      hash = "sha256-RJfxo87rEeGNpNJi+2bGbQLiWBaJNmhSRFDYD8kYHhw=";
    };

    npmDepsHash = "sha256-j3OT7ksmeqVi+aZd30OIE2TwFzXcPNpdK5YjfW/4uik=";

    nativeBuildInputs = [ final.makeWrapper ];

    postInstall = ''
      makeWrapper ${final.nodejs}/bin/node $out/bin/grep-app-mcp \
        --run 'cd "$HOME"' \
        --add-flags "$out/lib/node_modules/grep_app_mcp/dist/server-stdio.js"
    '';

    meta = with final.lib; {
      description = "MCP server for code search across public GitHub repositories via grep.app";
      homepage = "https://github.com/ai-tools-all/grep_app_mcp";
      license = licenses.isc;
      mainProgram = "grep-app-mcp";
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

  mcpproxy-go = final.buildGoModule {
    pname = "mcpproxy-go";
    version = "0.33.1";

    src = final.fetchFromGitHub {
      owner = "smart-mcp-proxy";
      repo = "mcpproxy-go";
      tag = "v0.33.1";
      hash = "sha256-QjkDlpURQGkGmjCY/Bqev4TSldChSovJPLSKW5zRPpA=";
    };

    vendorHash = "sha256-VEQookLyn9ix0CY/4VYqHFa6UTrOQS8PfruUkf5bA7k=";
    subPackages = [ "cmd/mcpproxy" ];

    env.CGO_ENABLED = 0;
    doCheck = false;

    meta = with final.lib; {
      description = "Smart MCP proxy daemon that exposes a four-tool surface over upstream MCP servers";
      homepage = "https://github.com/smart-mcp-proxy/mcpproxy-go";
      license = licenses.mit;
      mainProgram = "mcpproxy";
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
