{
  inputs,
  outputs,
  lib,
  config,
  pkgs,
  ...
}: let
  username = "brandonmcnama";
in {
  imports = [
    inputs.home-manager.darwinModules.home-manager

    ../common-darwin
  ];

  nix = {
    enable = false;
    nixPath = ["/etc/nix/path"];

    settings = {
      trusted-users = ["${username}"];
      substituters = ["https://cache.nixos.org"];
    };

    # To make nix3 commands consistent with your flake
    registry = (lib.mapAttrs (_: flake: {inherit flake;})) ((lib.filterAttrs (_: lib.isType "flake")) inputs);

    extraOptions = ''
      !include nix.conf.d/dev.conf
    '';
  };

  nixpkgs = {
    hostPlatform = "aarch64-darwin";

    overlays = [
      outputs.overlays.unstable-packages
    ];
  };

  # This will additionally add your inputs to the system's legacy channels
  # Making legacy nix commands consistent as well, awesome!
  environment.etc =
    lib.mapAttrs'
    (name: value: {
      name = "nix/path/${name}";
      value.source = value.flake;
    })
    config.nix.registry;

  users.users."${username}".home = "/Users/${username}";

  home-manager = {
    extraSpecialArgs = { inherit inputs outputs username; };


    users = {
      "${username}" = import ./home-manager;
    };
  };

  nix-homebrew = {
    user = username;

    taps = {
      "Shopify/homebrew-shopify" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-shopify.git";
        ref = "master";
        rev = "3b185d67706b0319f703c114085d68c44fbfc3d4";
      };
      "Shopify/homebrew-private" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-private.git";
        ref = "main";
        rev = "2761ad607b3f6645c489d36d6cf688375e5143b0";
      };

      "withgraphite/homebrew-tap" = inputs.homebrew-withgraphite;
    };
  };

  fonts = {
    packages = with pkgs; [
      pkgs.nerd-fonts.monaspace
      pkgs.monaspace
    ];
  };

  homebrew = {
    brews = [
      "ejson"
      "pkg-config"
      "withgraphite/tap/graphite"
    ];

    casks = [
      "1password@beta"
      "1password-cli"
      "contexts"
      "ghostty"
      "fellow"
      "ears"
      "rectangle"
      "raycast"
      "shortcat"
      "loopback"
      "slack"
      "deskflow"
      "keymapp"
      "obsidian"
      "podman-desktop"
    ];
  };
}
