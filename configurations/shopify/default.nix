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

  programs._1password.enable = true;
  programs._1password-gui = {
    enable = true;
    package = pkgs.unstable._1password-gui-beta;
  };

  nix-homebrew = {
    user = username;

    taps = {
      "Shopify/homebrew-shopify" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-shopify.git";
        ref = "master";
        rev = "fa9554e4e713e918aa28c74c94c0531ffb4f1d99";
      };
      "Shopify/homebrew-private" = builtins.fetchGit {
        url = "https://github.com/Shopify/homebrew-private.git";
        ref = "main";
        rev = "6a2a72c799c06a5f4d0431824cc0ddbc595208c2";
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
      "contexts"
      "fellow"
      "ears"
      "rectangle"
      "shortcat"
      "loopback"
      "deskflow"
      "obsidian"
      "podman-desktop"
    ];
  };
}
