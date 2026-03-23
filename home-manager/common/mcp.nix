{ pkgs, lib, ... }:
let
  readOpSecretCmd = x: "\${cmd: op read --no-newline '${x}'}";
in
{
  home.packages = with pkgs; [
    kagimcp
    slack-mcp-server

    github-mcp-server
    mcp-nixos
  ];

  xdg.configFile."mcphub/servers.json" = {
    enable = true;
    text = builtins.toJSON {
      servers = {
        nixos = {
          command = "${pkgs.mcp-nixos}/bin/mcp-nixos";
          args = [ "--" ];
        };

        # git-issue-tracker = {
        #   command = "${pkgs.git-issue-tracker}/bin/git-issue-mcp-server";
        # };

        github = {
          command = "${pkgs.github-mcp-server}/bin/github-mcp-server";

          args = [
            "stdio"
            "--toolsets=all"
          ];

          env.GITHUB_PERSONAL_ACCESS_TOKEN = readOpSecretCmd "op://Private/GitHub/Tokens/Full Control";
        };

        kagi = {
          command = "${pkgs.kagimcp}/bin/kagimcp";
          env.KAGI_API_KEY = readOpSecretCmd "op://Private/Kagi/API Token";
        };

        slack-hangops = {
          command = "${pkgs.slack-mcp-server}/bin/slack-mcp-server";

          env = {
            SLACK_MCP_XOXC_TOKEN = readOpSecretCmd "op://Private/HangOps/Tokens/xoxc";
            SLACK_MCP_XOXD_TOKEN = readOpSecretCmd "op://Private/HangOps/Tokens/xoxd";
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
}
