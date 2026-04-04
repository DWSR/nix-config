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

    fzf-git-sh = prev.fzf-git-sh.overrideAttrs (old: {
      patches = (old.patches or []) ++ [ ./fzf-git-sh-customizations.patch ];
    });

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
      cargoPatches = [ ./zellij-worktree-zellij-0.44.patch ];

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
}
