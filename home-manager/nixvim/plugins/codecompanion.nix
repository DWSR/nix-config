{ pkgs, ... }:
{
  programs.nixvim = {
    plugins.codecompanion = {
      enable = true;
      package = pkgs.unstable.vimPlugins.codecompanion-nvim;

      lazyLoad.settings = {
        cmd = [
          "CodeCompanion"
          "CodeCompanionChat"
          "CodeCompanionActions"
          "CodeCompanionCmd"
        ];
      };
      settings = {
        display = {
          action_palette = {
            provider = "snacks";
          };
          chat = {
            window = {
              layout = "vertical";
              width = 0.3;
            };
          };
        };
        interactions = {
          chat = {
            adapter = "opencode";
          };
        };
        extensions = {
          mcphub = {
            callback = "mcphub.extensions.codecompanion";
            opts = {
              # MCP Tools
              make_tools = true;
              show_server_tools_in_chat = true;
              add_mcp_prefix_to_tool_names = false;
              show_result_in_chat = true;
              # MCP Resources
              make_vars = false;
              # MCP Prompts
              make_slash_commands = true;
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
