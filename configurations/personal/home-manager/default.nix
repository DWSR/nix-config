{
  inputs,
  outputs,
  config,
  pkgs,
  lib,
  username,
  ...
}: {
  imports = [
    inputs.op-shell-plugins.hmModules.default

    ../../../home-manager/common
    ./git.nix
  ];

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
      nh
      vfkit
      tree
      unstable.keymapp
      viddy
      shadowenv
      karabiner-elements
      alejandra
      apple-sdk
      lazygit
      xz
      hcloud
      butane
      raycast
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

  programs._1password-shell-plugins = {
    enable = true;

    plugins = with pkgs; [
      flyctl
      gh
      hcloud
    ];
  };

  nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [
    "1password-cli"
    "1password"
    "raycast"
    "keymapp"
  ];
}
