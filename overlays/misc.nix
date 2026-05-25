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
    version = "2.0.24";

    src = final.fetchFromGitHub {
      owner = "junhoyeo";
      repo = "tokscale";
      tag = "v${version}";
      hash = "sha256-bRBhJNVNhQZASJBH+KuQ8BUfbxwaXJM2uVzdp+yNheg=";
    };

    cargoHash = "sha256-94uascld4gqfUGvYWZKj/kikc52+1NB93+5E7oSkg38=";

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

  opencode-pinned = final.unstable.opencode.overrideAttrs (old: {
    version = "1.15.5";

    src = final.fetchFromGitHub {
      owner = "anomalyco";
      repo = "opencode";
      tag = "v1.15.5";
      hash = "sha256-HZiqia9QzkJMfRQ6bzFBsiGXNHv1WFLUdwhekE+rXM8=";
    };

    vendorHash = "sha256-jKhT3/XtjYlVh+d/3uMIGfXvWv+LEjTuodwRVDzgCUM=";

    # Turn timestamp rendering is patched into the pinned package at build
    # time. Operators need a host rebuild plus a fresh OpenCode process before
    # this behavior appears; already-running processes keep the old package.
    patches = (old.patches or [ ]) ++ [
      ./opencode-turn-timestamps.patch
    ];

    node_modules = old.node_modules.overrideAttrs (_oldNm: {
      src = final.fetchFromGitHub {
        owner = "anomalyco";
        repo = "opencode";
        tag = "v1.15.5";
        hash = "sha256-HZiqia9QzkJMfRQ6bzFBsiGXNHv1WFLUdwhekE+rXM8=";
      };

      # opencode's build-time generate.ts imports prettier (a root-workspace
      # devDependency). The upstream nixpkgs node_modules buildPhase uses
      # `--filter ./packages/{app,desktop,opencode}` which excludes the root
      # workspace's deps, so prettier is missing. Override the buildPhase to
      # install without filters so prettier lands in node_modules.
      #
      # First needed at the anomalyco fork's v1.14.20; still required at
      # v1.15.5 (verified 2026-05-20). When bumping, retry without this
      # override only if upstream has stopped pulling prettier into
      # generate.ts; otherwise leave it in place.
      buildPhase = ''
        runHook preBuild

        bun install \
          --cpu="*" \
          --frozen-lockfile \
          --ignore-scripts \
          --no-progress \
          --os="*"

        bun --bun ./nix/scripts/canonicalize-node-modules.ts
        bun --bun ./nix/scripts/normalize-bun-binaries.ts

        runHook postBuild
      '';

      outputHash = "sha256-jKhT3/XtjYlVh+d/3uMIGfXvWv+LEjTuodwRVDzgCUM=";
    });

    # Caveman-lite compressions of the bundled model-specific system
    # prompts (anthropic / beast / codex / default / gemini / gpt /
    # kimi / trinity). Replaces each .txt file Bun bundles in at
    # build time via `import PROMPT_X from "./prompt/X.txt"` in
    # packages/opencode/src/session/system.ts. Source baseline,
    # compression style, refresh procedure, and verification steps
    # documented in ./opencode-prompts/README.md. If upstream renames
    # any of these files, the `cp -f` below will fail loud at build
    # time — that is the canary.
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
