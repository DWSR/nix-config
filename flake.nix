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
    DimitarNestorov.url = "github:DimitarNestorov/Nix-user-repository-packages";

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

    color-schemes = {
      url = "github:mbadolato/iTerm2-Color-Schemes";
      flake = false;
    };

    mcphub-nvim.url = "github:ravitemer/mcphub.nvim";
    mcphub.url = "github:ravitemer/mcp-hub";
  };

  outputs =
    {
      self,
      nixpkgs,
      home-manager,
      ...
    }@inputs:
    let
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
    in
    {
      overlays = import ./overlays { inherit inputs; };

      darwinConfigurations = {
        "ShopifyLaptop" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./modules/nix-core.nix
            ./configurations/shopify
          ];
        };
        "Brandons-MacBook-Pro" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./modules/nix-core.nix
            ./configurations/personal
          ];
        };
      };
    };
}
