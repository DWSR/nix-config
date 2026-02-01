{
  pkgs,
  lib,
  ...
}: let
  gcloud = pkgs.google-cloud-sdk.withExtraComponents [
    pkgs.google-cloud-sdk.components.gke-gcloud-auth-plugin
  ];
in {

  home = {
    stateVersion = "24.11";
    enableNixpkgsReleaseCheck = true;
    preferXdgDirectories = true;

    packages = with pkgs; [
      podman
      atuin
      kubectl
      k9s
      direnv
      shadowenv
      openssh
      dyff
      cloc
      cosign
      crane
      curl
      entr
      rclone
      rsync
      readline
      stern
      tree
      viddy
      karabiner-elements
      alejandra
      apple-sdk
      lazygit
      xz
      gcloud
      unstable.slack
      raycast
    ];
  };

  programs.ssh = {
    enable = true;
    extraConfig = "IdentityAgent \"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";
  };

  programs.nixvim.extraPlugins = [
    (
      pkgs.vimUtils.buildVimPlugin {
        name = "Shopify/shadowenv.vim";

        src = pkgs.fetchFromGitHub {
          owner = "Shopify";
          repo = "shadowenv.vim";
          rev = "c306d272b2280b7163b160fc27630eb9c16a3f4a";
          hash = "sha256-MEcZfUmjXsBXuyeMTUNS778Kq4g4+lJ/NkeXVawoQpA=";
        };
      }
    )
  ];

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
    "1password-cli"
    "1password"
    "raycast"
    "keymapp"
    "slack"
  ];

  imports = [
    ../../../home-manager/common
    ./dev.nix
    ./git.nix
    ./wish.nix
  ];
}
