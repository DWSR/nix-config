{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.11-darwin";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    op-shell-plugins = {
      url = "github:1Password/shell-plugins";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixneovimplugins = {
      url = "github:NixNeovim/NixNeovimPlugins";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    fenix = {
      url = "github:nix-community/fenix/0b88bfd10f819d000d35d296debe283db89b623b";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim = {
      url = "github:nix-community/nixvim/nixos-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    homebrew = {
      url = "github:zhaofengli/nix-homebrew";
    };

    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };

    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };

    homebrew-bundle = {
      url = "github:homebrew/homebrew-bundle";
      flake = false;
    };

    homebrew-deskflow = {
      url = "github:deskflow/homebrew-tap";
      flake = false;
    };

    homebrew-unf = {
      url = "github:cyrusradfar/homebrew-unf";
      flake = false;
    };

    color-schemes = {
      url = "github:mbadolato/iTerm2-Color-Schemes";
      flake = false;
    };

    mcphub-nvim = {
      url = "github:ravitemer/mcphub.nvim";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    mcphub = {
      url = "github:ravitemer/mcp-hub";
      inputs.nixpkgs.follows = "nixpkgs-unstable";
    };

    git-issue-tracker = {
      url = "github:nnunley/git-issue-tracker";
      flake = false;
    };

    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

  };

  outputs =
    {
      self,
      nixpkgs,
      ...
    }@inputs:
    let
      inherit (self) outputs;

      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

      treefmtEval = forAllSystems (
        system:
        inputs.treefmt-nix.lib.evalModule nixpkgs.legacyPackages.${system} {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
        }
      );
    in
    {
      formatter = forAllSystems (system: treefmtEval.${system}.config.build.wrapper);

      apps = forAllSystems (
        system:
        let
          # mcp-sync-from-1password depends on `_1password-cli`, which is
          # unfree-licensed. The legacyPackages set ships with the
          # default upstream config (no allowUnfree), so importing
          # nixpkgs explicitly with `config.allowUnfree = true` is
          # required for the script's derivation to evaluate. The
          # darwinConfigurations already do this via
          # `configurations/common-darwin/default.nix`'s `nixpkgs.config`
          # block; flake-app context must opt in separately.
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
          };
        in
        {
          bump-shopify-taps = {
            type = "app";
            program = "${import ./scripts/bump-shopify-taps.nix { inherit pkgs; }}/bin/bump-shopify-taps";
          };
          mcp-sync-from-1password = {
            type = "app";
            program = "${
              import ./scripts/mcp-sync-from-1password.nix { inherit pkgs; }
            }/bin/mcp-sync-from-1password";
          };
          mcp-verify-secrets = {
            type = "app";
            program = "${import ./scripts/mcp-verify-secrets.nix { inherit pkgs; }}/bin/mcp-verify-secrets";
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};

          # Nixvim tests (only available on aarch64-darwin where darwin configs exist)
          nixvimTests =
            if system == "aarch64-darwin" then
              let
                hmConfig = self.darwinConfigurations."ShopifyLaptop".config.home-manager.users.brandonmcnama;
                nvimPackage = hmConfig.programs.nixvim.build.package;
                testDir = ./home-manager/nixvim/tests;
              in
              {
                # Tier 1: Smoke test — does nvim start without errors?
                nixvim-smoke = hmConfig.programs.nixvim.build.test;

                # Tier 2: Config assertions — plugins, keybindings, settings, LSP config
                nixvim-config =
                  pkgs.runCommand "nixvim-config"
                    {
                      nativeBuildInputs = [ nvimPackage ];
                    }
                    ''
                      export HOME=$(mktemp -d)
                      nvim --headless -c "luafile ${testDir}/run-tier2.lua" 2>&1
                      touch $out
                    '';

                # Tier 3: Integration tests — LSP attachment, format-on-save, diagnostics
                nixvim-integration =
                  pkgs.runCommand "nixvim-integration"
                    {
                      nativeBuildInputs = [
                        nvimPackage
                        pkgs.git
                        pkgs.nixd
                        pkgs.lua-language-server
                        pkgs.bash-language-server
                        pkgs.nixfmt-rfc-style
                        pkgs.shfmt
                        pkgs.stylua
                      ];
                    }
                    ''
                      export HOME=$(mktemp -d)
                      mkdir -p $HOME/test && cd $HOME/test
                      git init -q
                      git config user.email "test@test.com"
                      git config user.name "test"
                      cp -r ${testDir}/fixtures/* .
                      git add . && git commit -q -m "init"
                      nvim --headless -c "luafile ${testDir}/run-tier3.lua" 2>&1
                      touch $out
                    '';
              }
            else
              { };
        in
        nixvimTests
        // {
          formatting = treefmtEval.${system}.config.build.check self;

          pre-commit-check = inputs.git-hooks.lib.${system}.run {
            src = ./.;
            package = pkgs.prek;

            hooks = {
              # Formatting
              nixfmt-rfc-style.enable = true;

              # Linters
              statix = {
                enable = true;
                settings.config = "./.statix.toml";
              };

              deadnix.enable = true;
              flake-checker.enable = true;

              # Custom guards
              no-tmp-paths = {
                enable = true;
                name = "No /tmp/ paths in nix files";
                entry = "${pkgs.gnugrep}/bin/grep -rn '/tmp/' --include='*.nix'";
                language = "system";
                files = "\\.nix$";
                pass_filenames = false;
              };

              no-builtins-fetch = {
                enable = true;
                name = "No builtins.fetchGit/fetchTarball";
                entry = "${pkgs.bash}/bin/bash -c '${pkgs.gnugrep}/bin/grep -rn \"builtins\\.fetchGit\\|builtins\\.fetchTarball\\|builtins\\.fetchurl\" --include=\"*.nix\" --exclude=flake.nix | ${pkgs.gnugrep}/bin/grep -v \"shopify/default\\.nix\" && exit 1 || exit 0'";
                language = "system";
                pass_filenames = false;
              };

              no-hardcoded-users = {
                enable = true;
                name = "No hardcoded /Users/ in module code";
                entry = "${pkgs.bash}/bin/bash -c '${pkgs.gnugrep}/bin/grep -rn \"/Users/\" --include=\"*.nix\" --exclude=flake.nix | ${pkgs.gnugrep}/bin/grep -v \"\\$\\{\" && exit 1 || exit 0'";
                language = "system";
                pass_filenames = false;
              };
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          preCommitCheck = self.checks.${system}.pre-commit-check;
          # The generated .pre-commit-config.yaml nix store path
          preCommitConfig = preCommitCheck.config.configFile;
        in
        {
          default = pkgs.mkShell {
            buildInputs = preCommitCheck.enabledPackages;

            # Symlink .pre-commit-config.yaml for the global prek hook to find.
            # We do NOT run prek install — hooks are installed globally via
            # home-manager's git-hooks.nix module.
            shellHook = ''
              GIT_WC=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null)
              if [ -n "$GIT_WC" ]; then
                config="${preCommitConfig}"
                if [ -e "$config" ]; then
                  if ! readlink "''${GIT_WC}/.pre-commit-config.yaml" >/dev/null 2>&1 \
                    || [ "$(readlink "''${GIT_WC}/.pre-commit-config.yaml")" != "$config" ]; then
                    [ -L "''${GIT_WC}/.pre-commit-config.yaml" ] && unlink "''${GIT_WC}/.pre-commit-config.yaml"
                    ln -s "$config" "''${GIT_WC}/.pre-commit-config.yaml"
                  fi
                fi
              fi
            '';
          };
        }
      );

      overlays = import ./overlays { inherit inputs; };

      darwinConfigurations = {
        "ShopifyLaptop" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/shopify
          ];
        };
        "Brandons-MacBook-Pro" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/personal
          ];
        };
      };
    };
}
