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
              make_vars = true; # Convert MCP resources to #variables for prompts
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
        key = "<leader>Cc";
        action = "<cmd>CodeCompanionToggle<CR>";
        options = {
          desc = "Toggle CodeCompanion buffer";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "n";
        key = "<leader>Ca";
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
