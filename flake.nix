{
  inputs = {
    Neve.url = "github:redyf/Neve/fa836860e7865e8b44236e475617c498a60b450c";
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-24.11-darwin";
    op-shell-plugins.url = "github:1Password/shell-plugins";

    lix-module = {
      type = "git";
      url = "https://git.lix.systems/lix-project/nixos-module";
      ref = "stable";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim = {
      url = "github:nix-community/nixvim/nixos-24.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-24.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/master";
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
  };

  outputs = inputs @ {
    self,
    darwin,
    nixpkgs,
    homebrew,
    homebrew-core,
    homebrew-cask,
    homebrew-bundle,
    homebrew-deskflow,
    home-manager,
    color-schemes,
    op-shell-plugins,
    lix-module,
    ...
  }: let
    specialArgs = inputs;
    username = "brandonmcnama";
  in {
    darwinConfigurations = {
      "ShopifyLaptop" = darwin.lib.darwinSystem {
        inherit specialArgs;

        modules = [
          lix-module.nixosModules.default
          ./modules/nix-core.nix
          ./modules/system.nix
          ./modules/homebrew-base.nix
          ./modules/home-manager-base.nix
          ./modules/ghostty.nix
          ./modules/zellij.nix
          ./modules/starship.nix
          ./modules/gh-cli.nix
          ./modules/mise.nix
          ./modules/zsh.nix
          ./overlays/shopify.nix
        ];
      };
      "Brandons-MacBook-Pro" = darwin.lib.darwinSystem {
        inherit specialArgs;

        modules = [
          lix-module.nixosModules.default
          ./modules/nix-core.nix
          ./modules/system.nix
          ./modules/homebrew-base.nix
          ./modules/home-manager-base.nix
          ./modules/ghostty.nix
          ./modules/zellij.nix
          ./modules/starship.nix
          ./modules/gh-cli.nix
          ./modules/mise.nix
          ./modules/zsh.nix
          ./overlays/personal.nix
        ];
      };
    };
  };
}
