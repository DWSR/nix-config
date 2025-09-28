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
    nixPath = ["/etc/nix/path"];

    # settings = {
    #   trusted-users = ["${username}"];
    #   substituters = ["https://cache.nixos.org"];
    # };

    # To make nix3 commands consistent with your flake
    registry = (lib.mapAttrs (_: flake: {inherit flake;})) ((lib.filterAttrs (_: lib.isType "flake")) inputs);
  };

  nixpkgs = {
    hostPlatform = "aarch64-darwin";

    overlays = [
      outputs.overlays.unstable-packages
    ];
  };

  environment = {
    darwinConfig = "/Users/brandonmcnama/repos/github.com/DWSR/nix-config";
    # This will additionally add your inputs to the system's legacy channels
    # Making legacy nix commands consistent as well, awesome!
    etc = lib.mapAttrs'
    (name: value: {
      name = "nix/path/${name}";
      value.source = value.flake;
    })
    config.nix.registry;
  };

  users.users."${username}".home = "/Users/${username}";

  home-manager = {
    extraSpecialArgs = {inherit inputs outputs username;};

    users = {
      "${username}" = import ./home-manager;
    };
  };

  nix-homebrew = {
    user = username;
  };

  fonts = {
    packages = with pkgs; [
      pkgs.nerd-fonts.monaspace
      pkgs.monaspace
    ];
  };

  homebrew = {
    casks = [
      "1password"
      "1password-cli"
      "contexts"
      "domzilla-caffeine"
      "ears"
      "moom"
      "orbstack"
      "ghostty"
      "ears"
      "oversight"
      "orion"
      "pocket-casts"
      "zsa-wally"
      "deskflow"
      "raycast"
      "keymapp"
      "raycast"
      "homerow"
      "obs"
      "loopback"
      "audio-hijack"
      "slack"
      "deskflow"
      "keymapp"
      "obsidian"
      "podman-desktop"
    ];
  };
}
