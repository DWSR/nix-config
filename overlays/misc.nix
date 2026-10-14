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

  # Hammerspoon: macOS desktop automation tool. Not in nixpkgs, so self-packaged
  # from the pinned, signed, notarized upstream release. The `.app` bundle is
  # installed verbatim (no resign, no strip) so its Developer-ID signature and
  # notarization stay intact for macOS TCC/Gatekeeper — that is what keeps the
  # one-time Accessibility grant stable across rebuilds.
  #
  # fetchurl + unzip is deliberate over fetchzip: it keeps the known, stable zip
  # sha256 and copies the faithful signed bytes. The release zip has
  # `Hammerspoon.app/` at its root, so `sourceRoot = "."` keeps the unpack root
  # as the working dir for the verbatim copy. `dontConfigure`/`dontBuild`/
  # `dontFixup`/`dontStrip` ensure no phase ever alters the bundle's bytes.
  # Bumps: update `version` + `src.url`, set `hash = final.lib.fakeHash`, rebuild,
  # and paste the reported `got:` SRI hash back.
  hammerspoon = final.stdenvNoCC.mkDerivation {
    pname = "hammerspoon";
    version = "1.1.1";

    src = final.fetchurl {
      url = "https://github.com/Hammerspoon/hammerspoon/releases/download/1.1.1/Hammerspoon-1.1.1.zip";
      hash = "sha256-EbsckPr1Qn83x71P5+q5d0rkPh1csCDFswiNrDKEnvo=";
    };

    nativeBuildInputs = [ final.unzip ];

    sourceRoot = ".";

    # Install the signed bundle verbatim; never alter its bytes so the
    # Developer-ID signature and notarization survive intact.
    dontConfigure = true;
    dontBuild = true;
    dontFixup = true;
    dontStrip = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/Applications"
      cp -R Hammerspoon.app "$out/Applications/"

      runHook postInstall
    '';

    meta = {
      description = "Staggeringly powerful macOS desktop automation tool";
      homepage = "https://www.hammerspoon.org/";
      license = final.lib.licenses.mit;
      platforms = final.lib.platforms.darwin;
    };
  };

  # hammerspoonHsAnnotations: a directory of `hs.*` LuaCATS type-definition
  # files generated from the pinned Hammerspoon bundle's machine-readable API
  # description (`Contents/Resources/docs.json`). The standalone EmmyLua.spoon
  # port at `overlays/hammerspoon/gen-emmylua.lua` (plain lua5.4, zero rocks)
  # reads that docs.json and emits one `---@class hs.<module>` file per module.
  #
  # The output tracks the pinned Hammerspoon version by construction: it is
  # derived solely from `final.hammerspoon`'s docs.json, so a version bump
  # regenerates the annotations automatically (the derivation re-evaluates when
  # the bundle changes). The semantic validation flake check (a later task)
  # consumes this directory as the LuaLS `workspace.library`.
  #
  # The generator does NOT create its output directory, so the build script
  # `mkdir -p $out` first, then passes `$out` as the generator's out-dir arg.
  hammerspoonHsAnnotations =
    final.runCommand "hammerspoon-hs-annotations"
      {
        nativeBuildInputs = [ final.lua5_4 ];
      }
      ''
        mkdir -p "$out"
        lua ${./hammerspoon/gen-emmylua.lua} \
          "${final.hammerspoon}/Applications/Hammerspoon.app/Contents/Resources/docs.json" \
          "$out"
      '';

  imagesnap = final.stdenvNoCC.mkDerivation rec {
    pname = "imagesnap";
    version = "0.3.0";

    src = final.fetchurl {
      url = "https://github.com/rharder/imagesnap/releases/download/v${version}/imagesnap-v${version}";
      hash = "sha256-LAFTG2b+QbYygr8lURfi4dOQ0Daq07vax/v0bMzJ82g=";
    };

    dontUnpack = true;
    dontConfigure = true;
    dontBuild = true;
    # Preserve upstream's universal binary, ad-hoc signature, and camera
    # entitlement. The binary links only macOS system frameworks and runtimes.
    dontFixup = true;

    installPhase = ''
      runHook preInstall

      install -Dm755 "$src" "$out/bin/imagesnap"

      runHook postInstall
    '';

    meta = {
      description = "Command-line tool for capturing images from video devices";
      homepage = "https://github.com/rharder/imagesnap";
      license = final.lib.licenses.publicDomain;
      mainProgram = "imagesnap";
      platforms = final.lib.platforms.darwin;
    };
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
        dependencies = with pyFinal; [
          requests
          typing-extensions
        ];
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

  mcpproxy-purge-tool-calls = final.buildGoModule {
    pname = "mcpproxy-purge-tool-calls";
    version = "1";

    src = ../scripts/mcpproxy-purge-tool-calls;
    vendorHash = "sha256-sZ2i3aCVufv5d2/NWb2OpM7/omEo1RmVmfOou+WyVKM=";

    doCheck = true;
    checkPhase = ''
      runHook preCheck
      go test ./...
      runHook postCheck
    '';

    meta = {
      description = "Delete mcpproxy tool-call history buckets from an offline BBolt database";
      mainProgram = "mcpproxy-purge-tool-calls";
      platforms = final.lib.platforms.unix;
    };
  };

  # nono: capability-based sandbox for AI agents (nolabs-ai/nono, Apache-2.0).
  # Published to crates.io as `nono-cli`; the binary is `nono`. Pinned to 0.69.0
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
      version = "0.69.0";

      src = final.fetchFromGitHub {
        owner = "nolabs-ai";
        repo = "nono";
        tag = "v${version}";
        hash = "sha256-1mGgjAirmwUl8UK8qK1ztHA4PD5IkNPqiOrwagLhJLU=";
      };

      cargoHash = "sha256-2jg4fvbMjGRwPJODl1AKaEhPfjNwJr05IFbDqzr/PpU=";

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
        homepage = "https://github.com/nolabs-ai/nono";
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
    version = "4.12.0";

    src = final.fetchFromGitHub {
      owner = "junhoyeo";
      repo = "tokscale";
      tag = "v${version}";
      hash = "sha256-RlpZQYLxPiIr8geQbHAXV7ZBXsRXisopJYOjR+ToiPs=";
    };

    cargoHash = "sha256-K7S8bTlBOa3TP3fl8AvTHiENLr4+0HguxJ9ev3f/ADE=";

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

      # Zellij 0.44 traps plugins that grow beyond its hardcoded 16 MiB
      # WASMI limit. zjstatus reaches that limit in long-running sessions.
      substituteInPlace zellij-server/src/plugins/plugin_loader.rs \
        --replace-fail '.memory_size(16 * 1024 * 1024)' '.memory_size(64 * 1024 * 1024)'
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
  # source, we normally no longer hand-maintain:
  #   - the node_modules `outputHash` (the fork ships it per-platform in
  #     nix/hashes.json; flake.lock pins the source), or
  #   - the `--filter`-dropping node_modules buildPhase override. That existed
  #     only to make the root-workspace `prettier` devDep land for the older
  #     nixpkgs build machinery; by v1.16.2 the build-time prettier import was
  #     removed and prettier moved into packages/opencode, so it is moot.
  # Bun selection is platform-split. OpenCode's package.json pins
  # `packageManager: "bun@1.3.14"` and upstream's nix/opencode.nix relaxes
  # that check to a warning, so only the compiler behavior matters:
  #   * darwin keeps the minimally-overridden prebuilt 1.3.14 binary package
  #     (`opencodeBun` below) — the combination the darwin hosts build and
  #     smoke-test today.
  #   * linux deliberately uses the repo nixpkgs bun 1.3.13. Every nixpkgs
  #     bun is patchelf'd by autoPatchelfHook (a ~85-char /nix/store ELF
  #     interpreter instead of upstream's 26-char path), and bun 1.3.14's
  #     `bun build --compile` mishandles such a patched template on
  #     linux-aarch64: the produced standalone SIGSEGVs inside the dynamic
  #     loader before main (observed as upstream's in-build smoke test
  #     exiting 139 in the fabro guest; 1.3.13 compiles working standalones
  #     from the same patched template). See
  #     https://github.com/NixOS/nixpkgs/issues/520383 (bun segfaults, the
  #     patchelf'd-template root cause) and
  #     https://github.com/anomalyco/opencode/issues/26846 (opencode smoke
  #     test exit 139).
  # Bumps: change the `opencode` input ref in flake.nix + `nix flake update
  # opencode`; revisit `opencodeBun` only if the new tag's build floor or
  # nixpkgs Bun state changes, and re-verify the linux build in the guest
  # (pre-flight: `nix build .#nixosConfigurations.fabro-vm.pkgs.opencode-pinned`
  # from the streamed tree).
  #
  # `version` is pinned to the release version because the upstream packages
  # output bakes a "+<rev>" suffix (node_modules.nix sets
  # `${packageJson.version}+${rev}`); this keeps the derivation name and
  # `opencode --version` identical to the release version.
  #
  # The three local modifications below all run after the node_modules build,
  # so none invalidates the in-repo node_modules hash, and all survive
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
      # Apple's codesign is available at a stable absolute path on Darwin but
      # is not included in Nix's build sandbox PATH. OpenCode invokes it by
      # name after embedding the bundle, so expose that host tool explicitly.
      opencodeCodesign = final.writeShellScriptBin "codesign" ''
        exec /usr/bin/codesign "$@"
      '';
      replaceBun =
        input:
        if (input.pname or null) == "bun" then
          (if final.stdenv.hostPlatform.isDarwin then opencodeBun else final.unstable.bun)
        else
          input;
    in
    inputs.opencode.packages.${final.stdenv.hostPlatform.system}.opencode.overrideAttrs (old: {
      version = "1.19.0";
      __intentionallyOverridingVersion = true;

      nativeBuildInputs = (map replaceBun (old.nativeBuildInputs or [ ])) ++ [ opencodeCodesign ];

      # 1. Turn timestamp rendering. Operators need a host rebuild plus a fresh
      #    OpenCode process before this behavior appears; already-running
      #    processes keep the old package.
      # 3. Git root-detection early-exit. Upstream Git.repo.discover
      #    (packages/core/src/git.ts) walks the FSUtil `up` helper from the cwd
      #    to the filesystem root, collecting every ancestor .git, then keeps
      #    only the nearest (matches[0]). The patch adds an opt-in `limit` to
      #    `up` (packages/core/src/fs-util.ts) and passes `limit: 1` from
      #    Git.repo.discover, so the walk stops at the first .git.
      #    Behavior-preserving; avoids stat-ing every parent dir up to / on
      #    each project resolve. Other `up` callers (config/skill discovery)
      #    omit `limit` and are unchanged.
      patches = (old.patches or [ ]) ++ [
        ./opencode-turn-timestamps.patch
        ./opencode-git-find-early-exit.patch
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
