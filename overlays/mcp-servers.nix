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

  # js-yaml for the managed Obsidian-to-AgentMemory importer. Keep its
  # vendored Node dependency tree independent of other SQLite consumers.
  obsidian-importer-deps = final.buildNpmPackage {
    pname = "obsidian-importer-deps";
    version = "0.0.1";
    nodejs = final.nodejs_22;

    src = ./obsidian-importer-deps;

    npmDeps = final.importNpmLock { npmRoot = ./obsidian-importer-deps; };
    inherit
      (final.callPackage (final.path + "/pkgs/build-support/node/import-npm-lock/hooks") {
        nodejs = final.nodejs_22;
      })
      npmConfigHook
      ;
    dontNpmBuild = true;

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
      description = "Vendored js-yaml for the Obsidian-to-AgentMemory importer";
      platforms = platforms.darwin ++ platforms.linux;
    };
  };

  # Vendored Node dependency tree for the `opencode-cost-diagnosis`
  # CLI (spec `opencode-cost-diagnosis`, design Technology Stack). The
  # diagnostic is a Node script that needs `require()`-able copies of
  # `better-sqlite3` (to read the opencode SQLite databases) and
  # `tiktoken` (WASM tokenizer used for proportional splits of
  # uncached input). Its native SQLite dependency is independent of
  # the Obsidian importer's pure-JavaScript js-yaml tree.
  #
  # Layout uses a hand-written
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
    # Node 24.19.0 aborts while finalizing better-sqlite3 v12 statements.
    # Build the native binding for the Node 22 runtime used by its consumers.
    nodejs = final.nodejs_22;

    src = ./opencode-cost-diagnosis-deps;

    npmDeps = final.importNpmLock { npmRoot = ./opencode-cost-diagnosis-deps; };
    inherit
      (final.callPackage (final.path + "/pkgs/build-support/node/import-npm-lock/hooks") {
        nodejs = final.nodejs_22;
      })
      npmConfigHook
      ;
    dontNpmBuild = true;

    # npmConfigHook installs the native dependency during configurePhase.
    env.npm_config_build_from_source = "true";
    env.npm_config_nodedir = final.nodejs_22;

    nativeBuildInputs = [
      final.nodejs_22
      final.python3
    ]
    ++ final.lib.optionals final.stdenv.hostPlatform.isDarwin [
      # better-sqlite3's bundled SQLite amalgamation needs the darwin
      # libtool (cctools) to link the static archive; the default
      # stdenv on darwin does not put it on PATH.
      final.cctools
    ];

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

  chrome-devtools-mcp = final.stdenv.mkDerivation {
    pname = "chrome-devtools-mcp";
    version = "1.7.0";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/chrome-devtools-mcp/-/chrome-devtools-mcp-1.7.0.tgz";
      hash = "sha256-iVczWGoOzhOEk3kMB+iwg7hXGx0gN6cxJDNNlo0QRtA=";
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

  gh-stack-mcp = final.buildGoModule {
    pname = "gh-stack-mcp";
    version = "0.1.0";

    src = ../scripts/gh-stack-mcp;

    vendorHash = "sha256-NbuvbsmNbz3aKdjyyfpkbi52yRhXl473j3LvAUDn3L8=";
    subPackages = [ "." ];

    nativeBuildInputs = [ final.makeWrapper ];

    postInstall = ''
      wrapProgram $out/bin/gh-stack-mcp \
        --set GH_STACK_MCP_EXTENSION_PATH ${final.unstable.gh-stack}/bin/gh-stack \
        --set GH_STACK_MCP_GIT_PATH ${final.git}/bin/git \
        --set GH_STACK_MCP_GH_PATH ${final.gh}/bin/gh
    '';

    meta = with final.lib; {
      description = "MCP server for typed local GitHub Stack operations";
      mainProgram = "gh-stack-mcp";
      platforms = platforms.darwin;
    };
  };

  github-mcp-server = final.buildGoModule {
    pname = "github-mcp-server";
    version = "1.11.0";

    src = final.fetchFromGitHub {
      owner = "github";
      repo = "github-mcp-server";
      tag = "v1.11.0";
      hash = "sha256-omRwUoVmbG+BNe5JJXYNE3csa4vMXBP+LOL2PMIGOEA=";
    };

    patches = [ ./github-mcp-server-stacked-prs.patch ];

    vendorHash = "sha256-6a5zjwTfEjGx23lG1ZTnUewm97FNacQY/y92TzAATXg=";
    subPackages = [ "cmd/github-mcp-server" ];

    postCheck = ''
      buildGoDir test ./pkg/github/...
    '';

    meta = with final.lib; {
      description = "GitHub's official MCP server for interacting with GitHub APIs";
      homepage = "https://github.com/github/github-mcp-server";
      license = licenses.mit;
      mainProgram = "github-mcp-server";
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

  # git-mcp-server — TypeScript stdio MCP server for Git operations.
  # Pinned to the v2.15.1 npm tarball. The package already ships a
  # pre-built `dist/index.js` (bundled by `bun build --target node`), so
  # we skip the build step entirely. The bundle externalises `pino`,
  # `pino-pretty`, and `cross-spawn`; those three runtime deps are
  # provided via `importNpmLock` from the vendored lock in
  # `overlays/git-mcp-server/`. The wrapper sets `MCP_TRANSPORT_TYPE=stdio`
  # so the server never opens an HTTP listener (stdio-only, no
  # unauthenticated HTTP surface). The wrapper prefixes nixpkgs git so
  # runtime git behavior is not inherited from the host OS.
  git-mcp-server = final.buildNpmPackage {
    pname = "git-mcp-server";
    version = "2.15.1";

    src = final.fetchurl {
      url = "https://registry.npmjs.org/@cyanheads/git-mcp-server/-/git-mcp-server-2.15.1.tgz";
      hash = "sha512-IuBjTfFhyNCceNwfTWcda2SPiQaGqyo3fw2OVwXzRzPT+vKAybFH4ntZTbZt5VRlpdTIpVevUkmGC0ZY09roLQ==";
    };

    postPatch = ''
      cp ${./git-mcp-server/package.json} package.json
      cp ${./git-mcp-server/package-lock.json} package-lock.json
    '';

    npmDeps = final.importNpmLock { npmRoot = ./git-mcp-server; };
    inherit (final.importNpmLock) npmConfigHook;
    dontNpmBuild = true;

    nativeBuildInputs = [ final.makeWrapper ];

    postInstall = ''
      makeWrapper ${final.nodejs}/bin/node $out/bin/git-mcp-server \
        --set MCP_TRANSPORT_TYPE stdio \
        --prefix PATH : ${final.lib.makeBinPath [ final.git ]} \
        --add-flags "$out/lib/node_modules/@cyanheads/git-mcp-server/dist/index.js"
    '';

    meta = with final.lib; {
      description = "MCP server for Git version control operations via stdio";
      homepage = "https://github.com/cyanheads/git-mcp-server";
      license = licenses.asl20;
      mainProgram = "git-mcp-server";
      platforms = platforms.unix;
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

  # mcp-server-time — pure-Python MCP server providing get_current_time and
  # convert_time tools via IANA timezone names. Distributed as a py3-none-any
  # wheel on PyPI; no native compilation required. Dependencies (mcp, pydantic,
  # tzdata, tzlocal) are all available in python312Packages.
  mcp-server-time = final.python312Packages.buildPythonApplication {
    pname = "mcp-server-time";
    version = "2026.1.26";
    format = "wheel";

    src = final.python312Packages.fetchPypi {
      pname = "mcp_server_time";
      version = "2026.1.26";
      format = "wheel";
      dist = "py3";
      python = "py3";
      abi = "none";
      platform = "any";
      hash = "sha256-f6fvfDzAiNMFOf895Cc2Mkrai5NTJW2i0RPYyXfsy9k=";
    };

    dependencies = with final.python312Packages; [
      mcp
      pydantic
      tzdata
      tzlocal
    ];

    meta = with final.lib; {
      description = "MCP server providing time queries and timezone conversions";
      homepage = "https://github.com/modelcontextprotocol/servers/tree/main/src/time";
      license = licenses.mit;
      mainProgram = "mcp-server-time";
      platforms = platforms.unix;
    };
  };

  mcpproxy-go = final.buildGoModule rec {
    pname = "mcpproxy-go";
    version = "0.67.0";

    src = final.fetchFromGitHub {
      owner = "smart-mcp-proxy";
      repo = "mcpproxy-go";
      tag = "v${version}";
      hash = "sha256-I6+B5LPV/lNZyU6Wlc7lNWUyorH+pmTLQhM3EfiCNVs=";
    };

    vendorHash = "sha256-xbbR4Xm6ZsBPLB+yIiah91SE1yC7wzYY/QZR9Dj4uOE=";
    subPackages = [ "cmd/mcpproxy" ];
    tags = [ "nogui" ];
    ldflags = [
      "-X main.version=v${version}"
      "-X github.com/smart-mcp-proxy/mcpproxy-go/internal/httpapi.buildVersion=v${version}"
    ];

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
