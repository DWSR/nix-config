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
        # Make sure mcphub.nvim is loaded BEFORE codecompanion's setup runs
        # — codecompanion's mcphub extension calls
        # `require("mcphub.extensions.codecompanion")`, which needs the plugin
        # on rtp. Without this `before`, the first :CodeCompanion would hit
        # "module 'mcphub.extensions.codecompanion' not found".
        before.__raw = ''
          function()
            require('lz.n').trigger_load('mcphub.nvim')
          end
        '';
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
      {
        mode = "v";
        key = "<leader>ae";
        action = "<cmd>CodeCompanion /explain<CR>";
        options = {
          desc = "Explain selected code";
          noremap = true;
          silent = true;
        };
      }
      {
        mode = "v";
        key = "<leader>af";
        action = "<cmd>CodeCompanion /fix<CR>";
        options = {
          desc = "Fix selected code";
          noremap = true;
          silent = true;
        };
      }
    ];
  };
}
