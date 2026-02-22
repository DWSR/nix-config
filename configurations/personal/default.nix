{
  inputs,
  outputs,
  lib,
  config,
  pkgs,
  username,
  ...
}:
{
  imports = [
    inputs.home-manager.darwinModules.home-manager

    ../common-darwin
  ];

  nix = {
    nixPath = [ "/etc/nix/path" ];

    # settings = {
    #   trusted-users = ["${username}"];
    #   substituters = ["https://cache.nixos.org"];
    # };

    # To make nix3 commands consistent with your flake
    registry = (lib.mapAttrs (_: flake: { inherit flake; })) (
      (lib.filterAttrs (_: lib.isType "flake")) inputs
    );
  };

  nixpkgs = {
    hostPlatform = "aarch64-darwin";

    overlays = [
      outputs.overlays.unstable-packages
    ];
  };

  environment = {
    # This will additionally add your inputs to the system's legacy channels
    # Making legacy nix commands consistent as well, awesome!
    etc =
      lib.mapAttrs' (name: value: {
        name = "nix/path/${name}";
        value.source = value.flake;
      }) config.nix.registry
      // {
        nix-darwin.source = "/Users/brandonmcnama/repos/github.com/DWSR/nix-config";
      };
  };

  users.users."${username}".home = "/Users/${username}";

  home-manager = {
    extraSpecialArgs = { inherit inputs outputs username; };

    users = {
      "${username}" = import ./home-manager;
    };
  };

  fonts = {
    packages = [
      pkgs.nerd-fonts.monaspace
      pkgs.monaspace
    ];
  };

  homebrew = {
    casks = [
      "contexts"
      "domzilla-caffeine"
      "ungoogled-chromium"
      "ears"
      "moom"
      "orbstack"
      "oversight"
      "orion"
      # "pocket-casts"
      "deskflow"
      "homerow"
      "obs"
      "loopback"
      "audio-hijack"
      "deskflow"
      "obsidian"
    ];
  };
}
