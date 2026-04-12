{
  inputs,
  config,
  lib,
  pkgs,
  ...
}:
let
  readKeychainSecret = config.home.mcp.readKeychainSecret;
in
{
  imports = [
    inputs.op-shell-plugins.hmModules.default

    ../../../home-manager/common
    ../../../home-manager/mcp
    ./git.nix
  ];

  home = {
    stateVersion = "24.11";

    # TODO: Remove this once 25.05 is released
    enableNixpkgsReleaseCheck = false;

    packages = with pkgs; [
      butane
      fastmail-mcp
      flyctl
      ghq
      git-issue-tracker
      hcloud
      kagimcp
      nh
      slack-mcp-server
      vfkit
      wireshark
    ];

    mcp = {
      obsidianVaultPath = "/Users/brandonmcnama/Library/Mobile Documents/iCloud~md~obsidian/Documents/data-bank";
      githubToken = readKeychainSecret "mcp-github-token";

      keychainSecrets = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
        "mcp-kagi-token" = "op://Private/Kagi/API Token";
        "mcp-fastmail-token" = "op://Private/Fastmail/API Tokens/mcp";
        "mcp-fastmail-username" = "op://Private/Fastmail/username";
        "mcp-fastmail-caldav-password" = "op://Private/Fastmail/App Passwords/MCP";
        "mcp-beeper-token" = "op://Private/Beeper/Desktop API Access Tokens/mcphub";
        "mcp-hangops-xoxc" = "op://Private/HangOps/Tokens/xoxc";
        "mcp-hangops-xoxd" = "op://Private/HangOps/Tokens/xoxd";
      };

      extraServers = {
        kagi = {
          command = "${pkgs.kagimcp}/bin/kagimcp";
          env.KAGI_API_KEY = readKeychainSecret "mcp-kagi-token";
        };

        fastmail = {
          command = "${pkgs.fastmail-mcp}/bin/fastmail-mcp";
          env = {
            FASTMAIL_API_TOKEN = readKeychainSecret "mcp-fastmail-token";
            FASTMAIL_CALDAV_USERNAME = readKeychainSecret "mcp-fastmail-username";
            FASTMAIL_CALDAV_PASSWORD = readKeychainSecret "mcp-fastmail-caldav-password";
          };
        };

        beeper = {
          type = "http";
          url = "http://localhost:23373/v0/mcp";
          headers = {
            Authorization = "Bearer " + readKeychainSecret "mcp-beeper-token";
          };
        };

        slack-hangops = {
          command = "${pkgs.slack-mcp-server}/bin/slack-mcp-server";
          env = {
            SLACK_MCP_XOXC_TOKEN = readKeychainSecret "mcp-hangops-xoxc";
            SLACK_MCP_XOXD_TOKEN = readKeychainSecret "mcp-hangops-xoxd";
            SLACK_MCP_ENABLED_TOOLS = lib.strings.concatStringsSep "," [
              "conversations_history"
              "conversations_replies"
              "conversations_add_message"
              "reactions_add"
              "reactions_remove"
              "attachment_get_data"
              "conversations_search_messages"
              "channels_list"
              "usergroups_list"
              "usergroups_me"
              "usergroups_create"
              "usergroups_update"
              "usergroups_users_update"
            ];
          };
        };
      };
    };
  };

  programs.ssh = {
    includes = [ "~/.orbstack/ssh/config" ];

    matchBlocks = {
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

}
