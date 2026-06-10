# Miscellaneous package overrides and custom packages
{ inputs }:
final: prev: {
  # TODO: Remove once fzf 0.71.0 is released and available in nixpkgs
  fzf = prev.fzf.overrideAttrs (_old: {
    version = "0.71.0-pre";

    src = final.fetchFromGitHub {
      owner = "junegunn";
      repo = "fzf";
      rev = "b7138e67a60638c02361c38f1053eadd09709660";
      hash = "sha256-9uHtEdIP3LOQvyEVpr0CO4D83YcX5BmSmnCCRVUzh4E=";
    };

    vendorHash = "sha256-uFXHoseFOxGIGPiWxWfDl339vUv855VHYgSs9rnDyuI=";
  });

  shadowenv-vim = final.vimUtils.buildVimPlugin {
    pname = "shadowenv-vim";
    version = "unstable-2024-07-23";

    src = final.fetchFromGitHub {
      owner = "Shopify";
      repo = "shadowenv.vim";
      rev = "c306d272b2280b7163b160fc27630eb9c16a3f4a";
      hash = "sha256-MEcZfUmjXsBXuyeMTUNS778Kq4g4+lJ/NkeXVawoQpA=";
    };
  };

  git-issue-tracker = final.stdenv.mkDerivation {
    pname = "git-issue-tracker";
    version = inputs.git-issue-tracker.shortRev or "unknown";
    src = inputs.git-issue-tracker;
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/bin
      cp -r bin/. $out/bin/
      chmod +x $out/bin/*
    '';
  };

  python312 = prev.python312.override {
    packageOverrides = pyFinal: _pyPrev: {
      kagiapi = pyFinal.buildPythonPackage rec {
        pname = "kagiapi";
        version = "0.2.1";
        format = "wheel";

        src = pyFinal.fetchPypi {
          inherit pname version format;
          dist = "py3";
          python = "py3";
          abi = "none";
          platform = "any";
          hash = "sha256-8/FGaQgEHRF3cLf5O+4SCX4RTdUYxN2jVBPfeFVGeZo=";
        };
        dependencies = with pyFinal; [ requests ];
      };
    };
  };

  kagimcp = final.python312Packages.buildPythonApplication {
    pname = "kagimcp";
    version = "0.1.4";
    format = "wheel";

    src = final.python312Packages.fetchPypi {
      pname = "kagimcp";
      version = "0.1.4";
      format = "wheel";
      dist = "py3";
      python = "py3";
      abi = "none";
      platform = "any";
      hash = "sha256-gJhxPOKy9i+wpjsvCvWwytSkDdKb1jD8z4DvjQHq8Hs=";
    };

    dependencies = with final.python312Packages; [
      kagiapi
      mcp
      pydantic
    ];
  };

  # nono: capability-based sandbox for AI agents (always-further/nono, Apache-2.0).
  # Published to crates.io as `nono-cli`; the binary is `nono`. Pinned to 0.61.1
  # because nixpkgs-unstable only ships 0.43.1.
  #
  # Requires rustc ≥1.95 (workspace rust-version). Neither stable nixpkgs
  # (1.91.1) nor unstable (1.94.1) satisfies this; we use fenix's toolchainOf
  # to pull exactly 1.95.0 via makeRustPlatform, mirroring the pattern already
  # used in overlays/zellij-plugins.nix.
  #
  # macOS build inputs:
  #   - Security, CoreFoundation: keyring apple-native + security-framework
  #   - cmake, perl: aws-lc-rs C build
  #   - libiconv: transitive dep of several crates on darwin
  nono =
    let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.toolchainOf {
        channel = "1.95.0";
        # sha256 of https://static.rust-lang.org/dist/channel-rust-1.95.0.toml
        sha256 = "sha256-gh/xTkxKHL4eiRXzWv8KP7vfjSk61Iq48x47BEDFgfk=";
      };
      rustPlatform = final.makeRustPlatform {
        inherit (rustToolchain) cargo rustc;
      };
    in
    rustPlatform.buildRustPackage rec {
      pname = "nono";
      version = "0.61.1";

      src = final.fetchFromGitHub {
        owner = "always-further";
        repo = "nono";
        tag = "v${version}";
        hash = "sha256-y5oMR5Vawf/1QUj3ACDdqAjKT+Q2gizRfKkal340EP8=";
      };

      cargoHash = "sha256-Oy/IqAK5ml1vu0eee+pF5pRjzk0Na/Fb04e1Mx0d924=";

      # Build only the CLI binary from the Cargo workspace.
      cargoBuildFlags = [
        "-p"
        "nono-cli"
      ];

      # Tests exercise network services, real keychain access, and
      # Seatbelt/Landlock kernel features unavailable in the Nix sandbox.
      doCheck = false;

      nativeBuildInputs = [
        final.cmake
        final.perl
        final.pkg-config
      ];

      buildInputs = [ final.libiconv ];

      meta = {
        description = "Capability-based sandbox for AI agents using Seatbelt (macOS) and Landlock (Linux)";
        homepage = "https://github.com/always-further/nono";
        license = final.lib.licenses.asl20;
        mainProgram = "nono";
        platforms = final.lib.platforms.unix;
      };
    };

  # RTK (Rust Token Killer) from rtk-ai/rtk. Built from source to avoid
  # upstream CI telemetry compile variables injected into official release
  # assets. crates.io name "rtk" resolves to an unrelated package; always
  # fetch from the rtk-ai/rtk GitHub source.
  rtk = final.rustPlatform.buildRustPackage rec {
    pname = "rtk";
    version = "0.40.0";

    src = final.fetchFromGitHub {
      owner = "rtk-ai";
      repo = "rtk";
      tag = "v${version}";
      hash = "sha256-xWHIOZRpSyyOPQe/db9dxoODcnheBlpXrnKET010vVg=";
    };

    cargoHash = "sha256-DJazpSx1FCt9pjFjqsoL3MLEQLdFvLwEj3UsP0aYHmc=";

    # Upstream tests exercise network services and real session data.
    # Skip in Nix sandbox builds.
    doCheck = false;

    meta = {
      description = "High-performance CLI proxy to minimize LLM token consumption";
      homepage = "https://github.com/rtk-ai/rtk";
      license = final.lib.licenses.mit;
      mainProgram = "rtk";
      platforms = final.lib.platforms.unix;
    };
  };

  tokscale = final.rustPlatform.buildRustPackage rec {
    pname = "tokscale";
    version = "3.0.0";

    src = final.fetchFromGitHub {
      owner = "junhoyeo";
      repo = "tokscale";
      tag = "v${version}";
      hash = "sha256-bgCQ00qO4KalrUPa92d65dRNf+DjgF+ZlRym7EFKobg=";
    };

    cargoHash = "sha256-McaxzhU2xEdEz9GQTFnUv1l68crBtVpoSlsdsrjuCvI=";

    # Only build the CLI binary from the Cargo workspace.
    cargoBuildFlags = [
      "-p"
      "tokscale-cli"
    ];

    # Upstream tests exercise the user's real session data and network
    # (leaderboard, pricing lookups). Skip in Nix builds.
    doCheck = false;

    meta = {
      description = "CLI and TUI for tracking AI coding assistant token usage and costs";
      homepage = "https://github.com/junhoyeo/tokscale";
      license = final.lib.licenses.mit;
      mainProgram = "tokscale";
      platforms = final.lib.platforms.unix;
    };
  };

  # Pin zellij to a specific version. nixpkgs unstable drifts silently
  # (e.g. 0.44.1 → 0.44.2 between channel bumps); pinning gives
  # reproducibility and avoids surprise version changes during routine
  # `nix flake update` runs. Bump deliberately when re-validating against
  # the zellij-plugins overlay (overlays/zellij-plugins.nix builds plugins
  # against the zellij-tile 0.44 ABI). To bump:
  #   1. Update `version` below.
  #   2. Set `hash` and `cargoHash` to `final.lib.fakeHash`.
  #   3. `nix build .#darwinConfigurations.Brandons-MacBook-Pro.pkgs.zellij`
  #      and paste the `got:` hash back. Repeat for cargoHash.
  #
  # Defined as a fresh `rustPlatform.buildRustPackage` (rather than
  # `prev.zellij.overrideAttrs`) because zellij's nixpkgs definition uses
  # the finalAttrs-callable form: `cargoDeps` is a separate derivation
  # constructed from the parent's `cargoHash` BEFORE `overrideAttrs`
  # applies, so overriding `cargoHash` via `overrideAttrs` is silently
  # ignored and the build fetches the wrong vendor tarball. Mirrors
  # upstream pkgs/by-name/ze/zellij/package.nix verbatim except for
  # version, src.hash, and cargoHash.
  #
  # Uses `final.unstable.rustPlatform` because zellij 0.44.1 requires
  # rustc ≥1.92 and stable nixpkgs ships rustc 1.91.1 (unstable has
  # 1.94.1). Other build inputs are toolchain-agnostic and can come
  # from the stable channel.
  zellij = final.unstable.rustPlatform.buildRustPackage (finalAttrs: {
    pname = "zellij";
    version = "0.44.1";
    __structuredAttrs = true;

    src = final.fetchFromGitHub {
      owner = "zellij-org";
      repo = "zellij";
      tag = "v${finalAttrs.version}";
      hash = "sha256-KHpVUjuOmMtkt8qBaCozD3M44eEtDwFmdDfszKAz0bM=";
    };

    # Match upstream: link against nixpkgs libcurl instead of vendoring.
    postPatch = ''
      substituteInPlace Cargo.toml \
        --replace-fail ', "vendored_curl"' ""
    '';

    cargoHash = "sha256-D3nZBXoGNf5z85iT7Xhj9Xwwwam/5m3X5hLPVoCzSPM=";

    env.OPENSSL_NO_VENDOR = 1;

    nativeBuildInputs = [
      final.mandown
      final.installShellFiles
      final.pkg-config
      (final.lib.getDev final.curl)
    ];

    buildInputs = [
      final.curl
      final.openssl
    ];

    nativeCheckInputs = [
      final.writableTmpDirAsHomeHook
    ];

    nativeInstallCheckInputs = [
      final.versionCheckHook
    ];
    doInstallCheck = true;

    installCheckPhase = final.lib.optionalString (final.stdenv.hostPlatform.libc == "glibc") ''
      runHook preInstallCheck

      ldd "$out/bin/zellij" | grep libcurl.so

      runHook postInstallCheck
    '';

    postInstall = ''
      mandown docs/MANPAGE.md > zellij.1
      installManPage zellij.1
    ''
    + final.lib.optionalString (final.stdenv.buildPlatform.canExecute final.stdenv.hostPlatform) ''
      installShellCompletion --cmd $pname \
        --bash <($out/bin/zellij setup --generate-completion bash) \
        --fish <($out/bin/zellij setup --generate-completion fish) \
        --zsh <($out/bin/zellij setup --generate-completion zsh)
    '';

    meta = {
      description = "Terminal workspace with batteries included";
      homepage = "https://zellij.dev/";
      changelog = "https://github.com/zellij-org/zellij/blob/v${finalAttrs.version}/CHANGELOG.md";
      license = with final.lib.licenses; [ mit ];
      mainProgram = "zellij";
      platforms = final.lib.platforms.unix;
    };
  });

  # OpenCode pinned to the anomalyco fork via that repo's own Nix packaging:
  # the `opencode` flake input's packages.<system>.opencode, built from its
  # nix/opencode.nix + nix/node_modules.nix. This replaces overriding nixpkgs'
  # `opencode` derivation. Because the packaging is version-matched to the
  # source, we no longer hand-maintain:
  #   - the node_modules `outputHash` (the fork ships it per-platform in
  #     nix/hashes.json; flake.lock pins the source), or
  #   - the `--filter`-dropping node_modules buildPhase override. That existed
  #     only to make the root-workspace `prettier` devDep land for the older
  #     nixpkgs build machinery; by v1.16.2 the build-time prettier import was
  #     removed and prettier moved into packages/opencode, so it is moot.
  # v1.16.2's build script requires bun ^1.3.14, while this repo's current
  # nixpkgs-unstable lock, latest checked nixpkgs-unstable (2026-06-08), and
  # opencode's tagged upstream lock all expose bun 1.3.13. Keep upstream
  # opencode's own Nix packaging, but replace only the build-time `bun` native
  # input with a minimally-overridden 1.3.14 Bun binary package.
  # Bumps: change the `opencode` input ref in flake.nix + `nix flake update
  # opencode`; update/remove `opencodeBun` only if the new tag's build floor or
  # nixpkgs Bun state changes.
  #
  # `version` is pinned to a clean "1.16.2" because the upstream packages
  # output bakes a "+<rev>" suffix (node_modules.nix sets
  # `${packageJson.version}+${rev}`); this keeps the derivation name and
  # `opencode --version` identical to the previous override.
  #
  # The two local modifications below both run after the node_modules build,
  # so neither invalidates the in-repo node_modules hash, and both survive
  # configurePhase's node_modules copy (which overlays only node_modules dirs,
  # not src).
  opencode-pinned =
    let
      opencodeBunVersion = "1.3.14";
      opencodeBunSources = {
        "aarch64-darwin" = final.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${opencodeBunVersion}/bun-darwin-aarch64.zip";
          hash = "sha256-2LliIYKK1vl6x6wKt+lYcjQa92MAHogD6CZ2UsJlJiA=";
        };
        "x86_64-darwin" = final.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${opencodeBunVersion}/bun-darwin-x64-baseline.zip";
          hash = "sha256-PjWtb1OXGpg0v55nhuKt9ytfGSHMmpxf3gc9KXKUQHY=";
        };
        "aarch64-linux" = final.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${opencodeBunVersion}/bun-linux-aarch64.zip";
          hash = "sha256-on/7Y6gxA3WDbg1vZorhf6jY0YuIw3yCHGUzGXOhmjs=";
        };
        "x86_64-linux" = final.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v${opencodeBunVersion}/bun-linux-x64.zip";
          hash = "sha256-lR7iruhV8IWVruxiJSJqKY0/6oOj3NZGXAnLzN9+hI8=";
        };
      };
      opencodeBun = final.unstable.bun.overrideAttrs (oldBun: {
        version = opencodeBunVersion;
        src =
          opencodeBunSources.${final.stdenv.hostPlatform.system}
            or (throw "Unsupported Bun/OpenCode system: ${final.stdenv.hostPlatform.system}");
        passthru = (oldBun.passthru or { }) // {
          sources = opencodeBunSources;
        };
      });
      replaceBun = input: if (input.pname or null) == "bun" then opencodeBun else input;
    in
    inputs.opencode.packages.${final.stdenv.hostPlatform.system}.opencode.overrideAttrs (old: {
      version = "1.16.2";
      __intentionallyOverridingVersion = true;

      nativeBuildInputs = map replaceBun (old.nativeBuildInputs or [ ]);

      # 1. Turn timestamp rendering. Operators need a host rebuild plus a fresh
      #    OpenCode process before this behavior appears; already-running
      #    processes keep the old package.
      patches = (old.patches or [ ]) ++ [
        ./opencode-turn-timestamps.patch
      ];

      # 2. Caveman-lite compressions of the bundled model-specific system
      #    prompts (anthropic / beast / codex / default / gemini / gpt / kimi /
      #    trinity). Replaces each .txt file Bun bundles in at build time via
      #    `import PROMPT_X from "./prompt/X.txt"` in
      #    packages/opencode/src/session/system.ts. Source baseline, compression
      #    style, refresh procedure, and verification steps documented in
      #    ./opencode-prompts/README.md. If upstream renames any of these files,
      #    the `cp -f` below will fail loud at build time — that is the canary.
      postPatch = (old.postPatch or "") + ''
        cp -f ${./opencode-prompts/anthropic.txt} packages/opencode/src/session/prompt/anthropic.txt
        cp -f ${./opencode-prompts/beast.txt}     packages/opencode/src/session/prompt/beast.txt
        cp -f ${./opencode-prompts/codex.txt}     packages/opencode/src/session/prompt/codex.txt
        cp -f ${./opencode-prompts/default.txt}   packages/opencode/src/session/prompt/default.txt
        cp -f ${./opencode-prompts/gemini.txt}    packages/opencode/src/session/prompt/gemini.txt
        cp -f ${./opencode-prompts/gpt.txt}       packages/opencode/src/session/prompt/gpt.txt
        cp -f ${./opencode-prompts/kimi.txt}      packages/opencode/src/session/prompt/kimi.txt
        cp -f ${./opencode-prompts/trinity.txt}   packages/opencode/src/session/prompt/trinity.txt
      '';
    });

  # cc-sdd: Kiro-style spec-driven development scaffolder (gotalab/cc-sdd, MIT).
  # Provides 17 `kiro-*` skills for OpenCode + project-local templates and
  # steering. Distributed on npm with a pre-built `dist/` and zero runtime
  # dependencies, so we install the published tarball directly via fetchurl
  # rather than building from source — no buildNpmPackage / lockfile dance
  # required. Bumps: update `version`, refresh `src.hash` (sha512 from npm
  # registry's `dist.integrity` field), and re-eval; the templates+skills
  # tree is rebuilt by the cc-sdd-skills derivation below.
  cc-sdd =
    let
      version = "3.0.2";
    in
    final.stdenv.mkDerivation {
      pname = "cc-sdd";
      inherit version;

      src = final.fetchurl {
        url = "https://registry.npmjs.org/cc-sdd/-/cc-sdd-${version}.tgz";
        # sha512 from `npm view cc-sdd@${version} dist.integrity`.
        hash = "sha512-7r9hyUhY35aeKVoqhViad28/JTT5SdDH3pPhGccY8nFpmT25+EP6vywetUwVL8wUCi3deJQBg/YcFU2gNnhC6w==";
      };

      nativeBuildInputs = [ final.makeWrapper ];

      # The npm tarball expands to `package/` containing dist/, templates/,
      # package.json, README.md. Lay it out under $out/lib/cc-sdd and wrap
      # bin/cc-sdd with the Nix nodejs so the CLI can be invoked outside any
      # pre-existing Node.js environment.
      installPhase = ''
        runHook preInstall

        mkdir -p $out/lib/cc-sdd $out/bin
        cp -r dist templates package.json README.md $out/lib/cc-sdd/

        makeWrapper ${final.nodejs}/bin/node $out/bin/cc-sdd \
          --add-flags $out/lib/cc-sdd/dist/cli.js

        runHook postInstall
      '';

      meta = {
        description = "Kiro-style spec-driven development scaffolder for AI agents";
        homepage = "https://github.com/gotalab/cc-sdd";
        license = final.lib.licenses.mit;
        mainProgram = "cc-sdd";
        platforms = final.lib.platforms.unix;
      };
    };

  # cc-sdd-skills: materialised tree of cc-sdd's OpenCode skills + Kiro
  # settings, produced by running `cc-sdd --opencode-skills --yes` inside the
  # Nix sandbox. Splits the output into:
  #   $out/skills        — 17 kiro-* skill directories (consumed globally
  #                        by xdg.configFile."opencode/skills/<name>")
  #   $out/kiro-settings — templates/, steering/, steering-custom/ trees
  #                        (consumed per-project by the cc-sdd-init helper
  #                        which copies them into <cwd>/.kiro/settings/)
  #   $out/agents-md     — the bundled AGENTS.md quickstart, concatenated
  #                        into programs.opencode.rules in a later commit
  #
  # Cached by Nix; only rebuilds when cc-sdd's version or hash changes.
  cc-sdd-skills =
    final.runCommand "cc-sdd-skills-${final.cc-sdd.version}"
      {
        nativeBuildInputs = [ final.cc-sdd ];
        passthru = {
          inherit (final.cc-sdd) version;
        };
      }
      ''
        # cc-sdd writes to the cwd, so give it a writable workdir. HOME must
        # also be writable because the wrapped node binary may try to create
        # config files (e.g. npm cache) on first invocation.
        export HOME=$(mktemp -d)
        workdir=$(mktemp -d)
        cd "$workdir"

        # --opencode-skills: select the OpenCode skills agent layout.
        # --lang en        : English templates.
        # --yes            : non-interactive; treat all overwrite prompts as force.
        # --overwrite force: belt-and-braces, mirrors the --yes behaviour
        #                    explicitly so a Nix sandbox without a TTY cannot
        #                    silently fall back to the documented `skip` mode.
        cc-sdd --opencode-skills --lang en --yes --overwrite force

        mkdir -p $out
        cp -r .opencode/skills $out/skills
        cp -r .kiro/settings   $out/kiro-settings
        cp    AGENTS.md        $out/agents-md
      '';
}
