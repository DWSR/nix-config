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
    version = "1.14.20";

    src = final.fetchFromGitHub {
      owner = "anomalyco";
      repo = "opencode";
      tag = "v1.14.20";
      hash = "sha256-9nxxvCkeTW3MasXaOhWaQqxqJeq9Q1+5TGULITjhV2Q=";
    };

    vendorHash = "sha256-hvlfFTdZliUn5FORX7gsn8fs0C7c3AsA8WOrtZhJwac=";

    node_modules = old.node_modules.overrideAttrs (_oldNm: {
      src = final.fetchFromGitHub {
        owner = "anomalyco";
        repo = "opencode";
        tag = "v1.14.20";
        hash = "sha256-9nxxvCkeTW3MasXaOhWaQqxqJeq9Q1+5TGULITjhV2Q=";
      };

      # v1.14.20's build-time generate.ts imports prettier (a root-workspace
      # devDependency). The upstream nixpkgs node_modules buildPhase uses
      # `--filter ./packages/{app,desktop,opencode}` which excludes the root
      # workspace's deps, so prettier is missing. Override the buildPhase to
      # install without filters so prettier lands in node_modules.
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

      outputHash = "sha256-hvlfFTdZliUn5FORX7gsn8fs0C7c3AsA8WOrtZhJwac=";
    });
  });
}
