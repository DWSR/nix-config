{ pkgs, ... }:
{
  programs.nixvim = {
    plugins.codecompanion = {
      enable = true;
      package = pkgs.unstable.vimPlugins.codecompanion-nvim;
      settings = {
        display = {
          action_palette = {
            provider = "snacks";
          };
        };
        adapters = {
          acp = {
            claude_code.__raw = ''
              function()
                return require("codecompanion.adapters").extend("claude_code", {
                  commands = {
                    default = {
                      "${pkgs.claude-agent-acp}/bin/claude-agent-acp",
                    },
                    yolo = {
                      "${pkgs.claude-agent-acp}/bin/claude-agent-acp",
                      "--yolo",
                    },
                  },
                })
              end
            '';
          };
        };
        interactions = {
          chat = {
            adapter = "claude_code";
          };
        };
        extensions = {
          mcphub = {
            callback = "mcphub.extensions.codecompanion";
            opts = {
              # MCP Tools
              make_tools = true; # Make individual tools (@server__tool) and server groups (@server) from MCP servers
              show_server_tools_in_chat = true; # Show individual tools in chat completion (when make_tools=true)
              add_mcp_prefix_to_tool_names = false; # Add mcp__ prefix (e.g `@mcp__github`, `@mcp__neovim__list_issues`)
              show_result_in_chat = true; # Show tool results directly in chat buffer
              # MCP Resources
              make_vars = false; # Disabled: mcphub expects codecompanion config.interactions.chat.variables which doesn't exist in this version
              # MCP Prompts
              make_slash_commands = true; # Add MCP prompts as /slash commands
            };
          };
        };
      };
    };

    keymaps = [
      {
        mode = "n";
        key = "<leader>ac";
        action = "<cmd>CodeCompanionChat Toggle<CR>";
        options = {
          desc = "Toggle CodeCompanion chat";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "n";
        key = "<leader>aa";
        action = "<cmd>CodeCompanionActions<CR>";
        options = {
          desc = "Open CodeCompanion actions palette";
          noremap = true;
          silent = true;
        };
      }
    ];
  };
}
