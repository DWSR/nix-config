{
  inputs,
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (config.home.mcp) readKeychainSecret;
in
{
  imports = [
    # Local override of inputs.op-shell-plugins.hmModules.default to silence
    # the `programs.zsh.initExtra is deprecated` home-manager warning until
    # upstream migrates to `initContent`. See op-shell-plugins.nix for details.
    ./op-shell-plugins.nix

    ../../../home-manager/common
    ../../../home-manager/common/cavemem.nix
    ../../../home-manager/mcp
    ./deskflow.nix
    ./git.nix
    ./opencode.nix
    ./pi-agent.nix
    ./sqlite-backup.nix
  ];

  disabledModules = [
    # Replaced by ./op-shell-plugins.nix above.
    "${inputs.op-shell-plugins}/nix/home-manager.nix"
  ];

  home = {
    stateVersion = "26.05";

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
      obsidianVaultPath = "${config.home.homeDirectory}/Library/Mobile Documents/iCloud~md~obsidian/Documents/data-bank";
      githubToken = readKeychainSecret "mcp-github-token";

      gitMcpSigning = {
        enable = true;
        identityLabel = "git-mcp-Brandons-MacBook-Pro";
        ctkPublicKeyHash = "b1e127793b64711c7559f1b6d5d41db292b6d96c";
        sshPublicKey = "sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBIiDRKcjop0g6wtGiK3xdz8HSUxkPKJgEmpAoouVF4EFDtcvXfkMtBmWNZJPb3K/455uE1X3JmIQpQMy1Lu8M5kAAAAEc3NoOg==";
        sshFingerprint = "SHA256:dFsOKcsaspDUGy0LbSIJbDZmb0kq8F5jx00LUjw8buo";
        githubSigningKeyRegistered = true;
      };

      keychainSecrets = {
        "mcp-github-token" = "op://Private/GitHub/Tokens/Full Control";
        "mcp-kagi-token" = "op://Private/Kagi/API Token";
        "mcp-fastmail-token" = "op://Private/Fastmail/API Tokens/mcp";
        "mcp-fastmail-username" = "op://Private/Fastmail/username";
        "mcp-fastmail-caldav-password" = "op://Private/Fastmail/App Passwords/MCP";
        "mcp-beeper-token" = "op://Private/Beeper/Desktop API Access Tokens/mcphub";
        "mcp-hangops-xoxc" = "op://Private/HangOps/Tokens/xoxc";
        "mcp-hangops-xoxd" = "op://Private/HangOps/Tokens/xoxd";
        "agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
      };

      # gh CLI auth token. Reuses the same PAT as mcp-github-token because
      # both consumers need the same GitHub repo / read scopes; the PAT is
      # already provisioned for mcphub's github MCP server. If you ever
      # need a separately-scoped gh CLI token, point this at a distinct
      # 1P item.
      ghAuthToken = "op://Private/GitHub/Tokens/Full Control";

      # Expose the same GitHub PAT to Nix as `access-tokens = github.com=…`
      # so `nix` / `darwin-rebuild` can fetch `github:` flake inputs and
      # tarballs without rate-limiting/auth failures. Reuses the existing
      # `mcp-github-token` secret; the sops bridge renders it into
      # /etc/nix/nix.conf.d/github-access-token.conf at activation.
      nixAccessTokenSecret = "mcp-github-token";

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

        grep-app = {
          command = "${pkgs.grep-app-mcp}/bin/grep-app-mcp";
        };

        ast-grep = {
          command = "${pkgs.ast-grep-mcp}/bin/ast-grep-mcp";
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

  programs.agentmemory = {
    enable = true;
    dataDir = "${config.xdg.dataHome}/agentmemory";
    runtimeDir = "${config.home.homeDirectory}/.agentmemory";
    logDir = "${config.home.homeDirectory}/Library/Logs/agentmemory";
    bearerReference = "agentmemory-bearer";
  };

  programs.ssh = {
    includes = [ "~/.orbstack/ssh/config" ];

    settings = {
      "192.168.1.1" = {
        User = "root";
        IdentitiesOnly = true;
        IdentityFile = "~/.ssh/unifi.pub";
        SetEnv.TERM = "xterm-256color";

        PasswordAuthentication = "no";
        HostKeyAlgorithms = "+ssh-rsa";
      };

      "192.168.1.69" = {
        User = "root";
        SetEnv.TERM = "xterm-256color";
        PasswordAuthentication = "yes";
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
