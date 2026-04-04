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
      system = final.system;
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
    mcp-hub = inputs.mcphub.packages.${final.system}.default;

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

    zellij-worktree = final.stdenv.mkDerivation {
      pname = "zellij-worktree";
      version = "0.1.0";

      src = final.fetchurl {
        url = "https://github.com/sharph/zellij-worktree/releases/download/v0.1.0/zellij-worktree.wasm";
        hash = "sha256-Ux4vUuZ9vnb1K3xJrX8sk2dYdNe3cRK6rVx+ZPrPH4I=";
      };

      dontUnpack = true;
      dontBuild = true;

      installPhase = ''
        mkdir -p $out/share/zellij/plugins
        cp $src $out/share/zellij/plugins/zellij-worktree.wasm
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
