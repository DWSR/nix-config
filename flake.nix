{
  nixConfig = {
    trusted-users = [ "brandonmcnama" ];

    extra-substituters = [
      # nix community's cache server
      "https://nix-community.cachix.org"
    ];

    extra-trusted-public-keys = [
      # nix community's cache server public key
      "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
    ];
  };

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.11-darwin";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    op-shell-plugins.url = "github:1Password/shell-plugins";
    flake-utils.url = "github:numtide/flake-utils";
    nixneovimplugins.url = "github:NixNeovim/NixNeovimPlugins";

    fenix = {
      url = "github:nix-community/fenix/0b88bfd10f819d000d35d296debe283db89b623b";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    dotenv = {
      url = "github:pcasaretto/dotenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim = {
      url = "github:nix-community/nixvim/nixos-25.11";
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

    mcphub-nvim.url = "github:ravitemer/mcphub.nvim";
    mcphub.url = "github:ravitemer/mcp-hub";

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

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          formatting = treefmtEval.${system}.config.build.check self;

          pre-commit-check = inputs.git-hooks.lib.${system}.run {
            src = ./.;
            package = pkgs.prek;

            hooks = {
              # Priority 0: Formatting (runs first)
              nixfmt-rfc-style = {
                enable = true;
                priority = 0;
              };

              # Priority 2: Custom guards
              no-tmp-paths = {
                enable = true;
                name = "No /tmp/ paths in nix files";
                entry = "${pkgs.gnugrep}/bin/grep -rn '/tmp/' --include='*.nix'";
                language = "system";
                files = "\\.nix$";
                pass_filenames = false;
                priority = 2;
              };
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (self.checks.${system}.pre-commit-check) shellHook enabledPackages;
        in
        {
          default = pkgs.mkShell {
            inherit shellHook;
            buildInputs = enabledPackages;
          };
        }
      );

      overlays = import ./overlays { inherit inputs; };

      darwinConfigurations = {
        "ShopifyLaptop" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit self inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/shopify
          ];
        };
        "Brandons-MacBook-Pro" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit self inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/personal
          ];
        };
      };
    };
}
