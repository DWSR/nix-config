{
  inputs,
  outputs,
  config,
  pkgs,
  lib,
  username,
  ...
}:
{
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
      ghq
      git-issue-tracker
      rclone
      rsync
      readline
      nh
      vfkit
      tree
      unstable.keymapp
      unstable.slack
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
      wireshark
    ];
  };

  programs.ssh = {
    enable = true;
    enableDefaultConfig = false;
    includes = [ "~/.orbstack/ssh/config" ];

    extraConfig = ''IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"'';

    matchBlocks = {
      "*" = {
        forwardAgent = false;
        addKeysToAgent = "no";
        controlMaster = "auto";
        controlPath = "~/.ssh/master-%r@%n:%p";
        controlPersist = "no";
        hashKnownHosts = false;
        userKnownHostsFile = "~/.ssh/known_hosts";
        serverAliveInterval = 0;
        serverAliveCountMax = 3;
        compression = true;
      };

      "192.168.1.1" = {
        user = "root";
        identitiesOnly = true;
        identityFile = "~/.ssh/unifi.pub";
        setEnv.TERM = "xterm-256color";

        extraOptions = {
          "PasswordAuthentication" = "no";
          "HostKeyAlgorithms" = "+ssh-rsa";
        };
      };

      "192.168.1.69" = {
        user = "root";
        setEnv.TERM = "xterm-256color";
        extraOptions.PasswordAuthentication = "yes";
      };
    };
  };

  programs.atuin.settings.sync_address = "https://atuin.mcnama.family";

  programs._1password-shell-plugins = {
    enable = true;

    plugins = with pkgs; [
      flyctl
      gh
      hcloud
    ];
  };

  nixpkgs.config.allowUnfreePredicate =
    pkg:
    builtins.elem (lib.getName pkg) [
      "1password-cli"
      "1password"
      "raycast"
      "keymapp"
      "slack"
    ];
}
