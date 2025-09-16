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
      atuin
      kubectl
      k9s
      direnv
      lunarvim
      openssh
      dyff
      cloc
      cosign
      crane
      curl
      entr
      flyctl
      rclone
      rsync
      readline
      vfkit
      tree
      viddy
      shadowenv
      karabiner-elements
      alejandra
      apple-sdk
      lazygit
      xz
      hcloud
      butane
    ];
  };

  programs.ssh = {
    enable = true;
    compression = true;
    controlMaster = "auto";
    includes = ["~/.orbstack/ssh/config"];
    extraConfig = "IdentityAgent \"~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock\"";

    matchBlocks = {
      "192.168.1.1" = {
        user = "root";
        identitiesOnly = true;
        identityFile = "~/.ssh/unifi.pub";

        extraOptions = {
          "PasswordAuthentication" = "no";
          "HostKeyAlgorithms" = "+ssh-rsa";
        };
      };
    };
  };


  imports = [
    ../../../home-manager/common
    ./git.nix
  ];
}

