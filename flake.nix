{
  nixConfig = {
    trusted-users = ["brandonmcnama"];

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
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.05-darwin";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    op-shell-plugins.url = "github:1Password/shell-plugins";
    flake-utils.url = "github:numtide/flake-utils";
    nixneovimplugins.url = "github:NixNeovim/NixNeovimPlugins";

    # TODO Use NUR to install Ghostty: https://github.com/NixOS/nixpkgs/issues/388984
    # nur = {
    #   url = "github.com:nix-community/NUR";
    #   inputs.nixpkgs.follows = "nixpkgs";
    # };

    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    dotenv = {
      url = "github:pcasaretto/dotenv";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    lix-module = {
      type = "git";
      url = "https://git.lix.systems/lix-project/nixos-module";
      ref = "release-2.93";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim = {
      url = "github:nix-community/nixvim/nixos-25.05";
    };

    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-25.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.05";
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

    homebrew-withgraphite = {
      url = "github:withgraphite/homebrew-tap";
      flake = false;
    };

    color-schemes = {
      url = "github:mbadolato/iTerm2-Color-Schemes";
      flake = false;
    };

    mcphub-nvim.url = "github:ravitemer/mcphub.nvim";
    mcphub.url = "github:ravitemer/mcp-hub";
  };

  outputs = {
    self,
    nixpkgs,
    home-manager,
    ...
  } @ inputs: let
    inherit (self) outputs;

    systems = [
      "aarch64-darwin"
      "x86_64-darwin"
    ];

    # This is a function that generates an attribute by calling a function you
    # pass to it, with each system as an argument
    forAllSystems = nixpkgs.lib.genAttrs systems;

    # Formatter for your nix files, available through 'nix fmt'
    # Other options beside 'alejandra' include 'nixpkgs-fmt'
    formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.alejandra);
  in {
    overlays = import ./overlays { inherit inputs; };

    darwinConfigurations = {
      "ShopifyLaptop" = inputs.darwin.lib.darwinSystem {
        specialArgs = {inherit inputs outputs;};

        modules = [
          ./modules/nix-core.nix
          ./configurations/shopify
        ];
      };
      "Brandons-MacBook-Pro" = let
        pkgs = import nixpkgs {
          config.allowUnfree = true;
        };
      in inputs.darwin.lib.darwinSystem {
        specialArgs = {inherit inputs outputs;};

        modules = [
          inputs.lix-module.nixosModules.default
          ./modules/nix-core.nix
          ./configurations/personal
        ];
      };
    };
  };
}
