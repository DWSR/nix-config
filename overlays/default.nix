{ inputs, ... }:
{
  # This one brings our custom packages from the 'pkgs' directory
  # additions = final: _prev: import ../pkgs {pkgs = final;};

  # This one contains whatever you want to overlay
  # You can change versions, add patches, set compilation flags, anything really.
  # https://nixos.wiki/wiki/Overlays
  # modifications = final: prev: {
  #   # example = prev.example.overrideAttrs (oldAttrs: rec {
  #   # ...
  #   # });
  #   pcasaretto = import inputs.nixpkgs-pcasaretto {
  #     system = final.system;
  #     config.allowUnfree = true;
  #   };
  # };

  # When applied, the unstable nixpkgs set (declared in the flake inputs) will
  # be accessible through 'pkgs.unstable'
  unstable-packages = final: _prev: {
    unstable = import inputs.nixpkgs-unstable {
      system = final.stdenv.hostPlatform.system;
      config.allowUnfree = true;
    };
  };

  # Add access to x86 packages when system is running Apple Silicon
  apple-silicon = final: prev: {
    inputs.nixpkgs.lib.optionalAttrs = (prev.stdenv.hostPlatform.system == "aarch64-darwin") {
      pkgs-x86 = import inputs.nixpkgs-unstable {
        system = "x86_64-darwin";
      };
    };
  };

  custom-packages = final: prev: {
    mcp-hub = inputs.mcphub.packages.${final.stdenv.hostPlatform.system}.default;

    # TODO: Remove once fzf 0.71.0 is released and available in nixpkgs
    fzf = prev.fzf.overrideAttrs (old: {
      version = "0.71.0-pre";

      src = final.fetchFromGitHub {
        owner = "junegunn";
        repo = "fzf";
        rev = "b7138e67a60638c02361c38f1053eadd09709660";
        hash = "sha256-9uHtEdIP3LOQvyEVpr0CO4D83YcX5BmSmnCCRVUzh4E=";
      };

      vendorHash = "sha256-uFXHoseFOxGIGPiWxWfDl339vUv855VHYgSs9rnDyuI=";
    });

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

    claude-agent-acp = final.buildNpmPackage rec {
      pname = "claude-agent-acp";
      version = "0.25.3";

      src = final.fetchurl {
        url = "https://registry.npmjs.org/@agentclientprotocol/claude-agent-acp/-/claude-agent-acp-${version}.tgz";
        hash = "sha256-67LPraeZuPkp3fTXi5InAgR4jHGrseWtjE86gRWAVtk=";
      };

      postPatch = ''
        cp ${./claude-agent-acp/package.json} package.json
        cp ${./claude-agent-acp/package-lock.json} package-lock.json
      '';

      npmDeps = final.importNpmLock { npmRoot = ./claude-agent-acp; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;

      meta = with final.lib; {
        description = "ACP adapter for Claude Code via the Claude Agent SDK";
        homepage = "https://github.com/agentclientprotocol/claude-agent-acp";
        license = licenses.asl20;
        mainProgram = "claude-agent-acp";
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
      npmConfigHook = final.importNpmLock.npmConfigHook;

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

    gcloud-mcp = final.buildNpmPackage rec {
      pname = "gcloud-mcp";
      version = "0.5.3";
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/gcloud-mcp/-/gcloud-mcp-${version}.tgz";
        hash = "sha256-Q2ujZBp7PH+wS7RASl1y0uWJFk42NHSLnhBpl9206to=";
      };
      postPatch = ''
        cp ${./gcloud-mcp/package.json} package.json
        cp ${./gcloud-mcp/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./gcloud-mcp; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        description = "MCP server for Google Cloud via gcloud CLI";
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = "gcloud-mcp";
      };
    };

    observability-mcp = final.buildNpmPackage rec {
      pname = "observability-mcp";
      version = "0.2.3";
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/observability-mcp/-/observability-mcp-${version}.tgz";
        hash = "sha256-osa+MSVVXZBHS/zA+1vBaybPOsuNzsNOn58zRSU2RzE=";
      };
      postPatch = ''
        cp ${./observability-mcp/package.json} package.json
        cp ${./observability-mcp/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./observability-mcp; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        description = "MCP server for Google Cloud Observability";
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = "observability-mcp";
      };
    };

    storage-mcp = final.buildNpmPackage rec {
      pname = "storage-mcp";
      version = "0.3.3";
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/storage-mcp/-/storage-mcp-${version}.tgz";
        hash = "sha256-bXqx4EqmYta8Z1S34FSG/uhZ8OEkHcgR3wen+EDqoh4=";
      };
      postPatch = ''
        cp ${./storage-mcp/package.json} package.json
        cp ${./storage-mcp/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./storage-mcp; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        description = "MCP server for Google Cloud Storage";
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = "storage-mcp";
      };
    };

    backupdr-mcp = final.buildNpmPackage rec {
      pname = "backupdr-mcp";
      version = "0.1.0";
      src = final.fetchurl {
        url = "https://registry.npmjs.org/@google-cloud/backupdr-mcp/-/backupdr-mcp-${version}.tgz";
        hash = "sha256-cUZc5oWUlCgtcnY6uWnw316+2GG8MlO6vru3/29pr5A=";
      };
      postPatch = ''
        cp ${./backupdr-mcp/package.json} package.json
        cp ${./backupdr-mcp/package-lock.json} package-lock.json
      '';
      npmDeps = final.importNpmLock { npmRoot = ./backupdr-mcp; };
      npmConfigHook = final.importNpmLock.npmConfigHook;
      dontNpmBuild = true;
      meta = with final.lib; {
        description = "MCP server for Google Cloud Backup and DR";
        homepage = "https://github.com/googleapis/gcloud-mcp";
        license = licenses.asl20;
        mainProgram = "backupdr-mcp";
      };
    };

    zellij-autolock = final.stdenv.mkDerivation {
      pname = "zellij-autolock";
      version = "0.2.2";

      src = final.fetchurl {
        url = "https://github.com/fresh2dev/zellij-autolock/releases/download/0.2.2/zellij-autolock.wasm";
        hash = "sha256-aclWB7/ZfgddZ2KkT9vHA6gqPEkJ27vkOVLwIEh7jqQ=";
      };

      dontUnpack = true;
      dontBuild = true;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp $src $out/share/zellij/plugins/zellij-autolock.wasm
      '';

      meta = with final.lib; {
        description = "Auto-lock Zellij when certain processes open";
        homepage = "https://github.com/fresh2dev/zellij-autolock";
        license = licenses.mit;
      };
    };

    # Built from source with zellij-tile bumped to 0.44 to fix ABI mismatch panic
    # TODO: Remove source builds once upstream releases versions compatible with zellij 0.44
    zellij-notepad = let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.combine [
        fenixPkgs.stable.cargo
        fenixPkgs.stable.rustc
        fenixPkgs.targets.wasm32-wasip1.stable.rust-std
      ];
      rustPlatform = final.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      };
    in rustPlatform.buildRustPackage {
      pname = "zellij-notepad";
      version = "0.2.1-patched";

      src = final.fetchFromGitHub {
        owner = "0xble";
        repo = "zellij-notepad";
        tag = "v0.2.1";
        hash = "sha256-ZMISRi4NtNygT27m4DOhJg8xv7V1yRcbT4ZAuhHI194=";
      };

      cargoLock.lockFile = ./zellij-notepad-Cargo.lock;
      cargoPatches = [ ./zellij-notepad-zellij-0.44.patch ];

      postPatch = ''
        cp ${./zellij-notepad-Cargo.lock} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/notepad.wasm $out/share/zellij/plugins/zellij-notepad.wasm
      '';

      meta = with final.lib; {
        description = "Floating notepad plugin for Zellij";
        homepage = "https://github.com/0xble/zellij-notepad";
        license = licenses.mit;
      };
    };

    zellij-forgot = let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.combine [
        fenixPkgs.stable.cargo
        fenixPkgs.stable.rustc
        fenixPkgs.targets.wasm32-wasip1.stable.rust-std
      ];
      rustPlatform = final.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      };
    in rustPlatform.buildRustPackage {
      pname = "zellij-forgot";
      version = "0.4.2-patched";

      src = final.fetchFromGitHub {
        owner = "karimould";
        repo = "zellij-forgot";
        tag = "0.4.2";
        hash = "sha256-QS09lC6yyUZA13PHERrdY/phfo1QoHAmRPpQUGL3pP8=";
      };

      cargoLock.lockFile = ./zellij-forgot-Cargo.lock;
      cargoPatches = [ ./zellij-forgot-zellij-0.44.patch ];

      postPatch = ''
        cp ${./zellij-forgot-Cargo.lock} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/zellij_forgot.wasm $out/share/zellij/plugins/zellij-forgot.wasm
      '';

      meta = with final.lib; {
        description = "Zellij plugin to help remember keybindings and commands";
        homepage = "https://github.com/karimould/zellij-forgot";
        license = licenses.mit;
      };
    };

    zjstatus = let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.combine [
        fenixPkgs.stable.cargo
        fenixPkgs.stable.rustc
        fenixPkgs.targets.wasm32-wasip1.stable.rust-std
      ];
      rustPlatform = final.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      };
    in rustPlatform.buildRustPackage {
      pname = "zjstatus";
      version = "0.22.0-patched";

      src = final.fetchFromGitHub {
        owner = "dj95";
        repo = "zjstatus";
        tag = "v0.22.0";
        hash = "sha256-aWp608krMtk5I+c3GXyuHkb6ugah40cBI0R52fNqMiI=";
      };

      cargoLock.lockFile = ./zjstatus-Cargo.lock;
      cargoPatches = [ ./zjstatus-zellij-0.44.patch ];

      postPatch = ''
        cp ${./zjstatus-Cargo.lock} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/zjstatus.wasm $out/share/zellij/plugins/zjstatus.wasm
      '';

      meta = with final.lib; {
        description = "Configurable and themeable status bar plugin for Zellij";
        homepage = "https://github.com/dj95/zjstatus";
        license = licenses.mit;
      };
    };

    zellij-attention = let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.combine [
        fenixPkgs.stable.cargo
        fenixPkgs.stable.rustc
        fenixPkgs.targets.wasm32-wasip1.stable.rust-std
      ];
      rustPlatform = final.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      };
    in rustPlatform.buildRustPackage {
      pname = "zellij-attention";
      version = "0.3.1-patched";

      src = final.fetchFromGitHub {
        owner = "KiryuuLight";
        repo = "zellij-attention";
        tag = "v0.3.1";
        hash = "sha256-T36mzLbXCUqBeLa5hUX4/gMZ/c41szKAcLrsyXB6TIQ=";
      };

      cargoLock.lockFile = ./zellij-attention-Cargo.lock;
      cargoPatches = [ ./zellij-attention-zellij-0.44.patch ];

      postPatch = ''
        cp ${./zellij-attention-Cargo.lock} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/zellij-attention.wasm $out/share/zellij/plugins/zellij-attention.wasm
      '';

      meta = with final.lib; {
        description = "Zellij plugin that adds notification icons to tab names";
        homepage = "https://github.com/KiryuuLight/zellij-attention";
        license = licenses.mit;
      };
    };

    # TODO: Remove source build once upstream releases a version compatible with zellij 0.44
    zellij-worktree = let
      fenixPkgs = inputs.fenix.packages.${final.stdenv.hostPlatform.system};
      rustToolchain = fenixPkgs.combine [
        fenixPkgs.stable.cargo
        fenixPkgs.stable.rustc
        fenixPkgs.targets.wasm32-wasip1.stable.rust-std
      ];
      rustPlatform = final.makeRustPlatform {
        cargo = rustToolchain;
        rustc = rustToolchain;
      };
    in rustPlatform.buildRustPackage {
      pname = "zellij-worktree";
      version = "0.1.0-patched";

      src = final.fetchFromGitHub {
        owner = "sharph";
        repo = "zellij-worktree";
        tag = "v0.1.0";
        hash = "sha256-5efD2F2UMRfYM4st2+mfsmUwqELXtnxAlBqi1vmBNKk=";
      };

      cargoLock.lockFile = ./zellij-worktree-Cargo.lock;
      cargoPatches = [
        ./zellij-worktree-zellij-0.44.patch
        ./zellij-worktree-trunk-branch.patch
      ];

      postPatch = ''
        cp ${./zellij-worktree-Cargo.lock} Cargo.lock
      '';

      buildPhase = ''
        cargo build --release --target wasm32-wasip1
      '';

      doCheck = false;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp target/wasm32-wasip1/release/zellij-worktree.wasm $out/share/zellij/plugins/zellij-worktree.wasm
      '';

      meta = with final.lib; {
        description = "Git worktree management plugin for Zellij";
        homepage = "https://github.com/sharph/zellij-worktree";
        license = licenses.mit;
      };
    };

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
            # Target the generic pure-Python wheel.
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

    slack-mcp-server = final.buildGoModule {
      pname = "slack-mcp-server";
      version = "1.2.3";
      vendorHash = "sha256-mR+UFQRi98OTCyNISy3e7QTGKusd8XhNW4iz57QvpZE=";
      # integration tests require real API keys
      # checkFlags = [ "-skip=.*Integration.*" ];
      doCheck = false;

      src = final.fetchFromGitHub {
        owner = "korotovsky";
        repo = "slack-mcp-server";
        tag = "v1.2.3";
        hash = "sha256-AfmuQfV3RqFBw9b8B4aFM0EOuFQrUlUpTnMmQcyvCfU=";
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
        # Target the generic pure-Python wheel.
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

    browsermcp = final.buildNpmPackage rec {
      pname = "browsermcp";
      version = "0.1.3";

      src = final.fetchurl {
        url = "https://registry.npmjs.org/@browsermcp/mcp/-/mcp-${version}.tgz";
        hash = "sha256-KtNMKRRcqAxfLn2OyQ4FiWl7GTOLK0WoPJGNSQekz5Y=";
      };

      postPatch = ''
        cp ${./browsermcp/package.json} package.json
        cp ${./browsermcp/package-lock.json} package-lock.json
      '';

      npmDeps = final.importNpmLock {
        npmRoot = ./browsermcp;
      };
      npmConfigHook = final.importNpmLock.npmConfigHook;

      dontNpmBuild = true;

      meta = with final.lib; {
        description = "MCP server for browser automation using Browser MCP";
        homepage = "https://browsermcp.io";
        license = licenses.asl20;
        mainProgram = "mcp-server-browsermcp";
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
  };

  shopify-packages = final: prev: {
    opencode-shopify = final.symlinkJoin {
      name = "opencode-shopify";
      paths = [ final.unstable.opencode ];
      nativeBuildInputs = [ final.makeWrapper ];
      postBuild = ''
        wrapProgram $out/bin/opencode \
          --run '
            OPENCODE_API_KEY="$(devx llm-gateway print-token --key 2>/dev/null)" || {
              echo "Error: Failed to get OPENCODE_API_KEY from devx llm-gateway print-token --key" >&2
              exit 1
            }
            export OPENCODE_API_KEY

            DEFAULT_PROXY_BASE="$(devx llm-gateway print-token --base 2>/dev/null)" || {
              echo "Error: Failed to get DEFAULT_PROXY_BASE from devx llm-gateway print-token --base" >&2
              exit 1
            }
            export DEFAULT_PROXY_BASE

            export OPENCODE_SESSION_ID="$(uuidgen)"
          '
      '';
    };
  };
}
