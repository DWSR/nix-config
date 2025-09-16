{
  inputs,
  outputs,
  config,
  pkgs,
  lib,
  username,
  ...
}: {

  home = {
    stateVersion = "24.11";

    # TODO: Remove this once 25.05 is released
    enableNixpkgsReleaseCheck = false;
    preferXdgDirectories = true;

    packages = with pkgs; [
      podman
      atuin
      kubectl
      k9s
      direnv
      # lunarvim
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
      tree
      viddy
      karabiner-elements
      alejandra
      # nodejs-slim_22
      apple-sdk
      lazygit
      xz
      google-cloud-sdk
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


  imports = [
    ../../../home-manager/common
    ./dev.nix
    ./git.nix
  ];
}
