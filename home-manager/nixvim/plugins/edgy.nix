{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    opts.splitkeep = "screen";

    extraConfigLuaPre = ''
      -- https://github.com/folke/edgy.nvim/discussions/126
      ---@param win Edgy.Window
      local function toggle_auto_expand_width(win)
        -- to load the filetypes
        require("edgy")
        local neotree_sources_common_commands = require("neo-tree.sources.common.commands")
        local win_width = vim.api.nvim_win_get_width(0)
        local state = require("neo-tree.sources.manager").get_state("filesystem")
        if state.window.auto_expand_width then
          neotree_sources_common_commands.toggle_auto_expand_width(state)
          win.view.edgebar:equalize()
          return
        end
        neotree_sources_common_commands.toggle_auto_expand_width(state)
        while win_width < state.win_width + 1 do
          win:resize("width", 1)
          win_width = win_width + 1
        end
      end
    '';

    plugins.edgy = {
      enable = true;

      settings = {
        animate.enabled = false;
        close_when_all_hidden = false;
        wo.signcolumn = "yes";

        keys = {
          e = helpers.mkRaw "toggle_auto_expand_width";
        };

        left = helpers.mkRaw ''
          {
            {
              title = "Files",
              ft = "neo-tree",
              filter = function(buf)
                return vim.b[buf].neo_tree_source == "filesystem"
              end,
              size = { height = 0.6 },
            },
            {
              title = "Git",
              ft = "neo-tree",
              filter = function(buf)
                return vim.b[buf].neo_tree_source == "git_status"
              end,
              pinned = true,
              collapsed = false,
              size = { height = 0.2 },
              open = "Neotree position=right git_status",
            },
            {
              title = "Buffers",
              ft = "neo-tree",
              filter = function(buf)
                return vim.b[buf].neo_tree_source == "buffers"
              end,
              pinned = true,
              collapsed = false,
              size = { height = 0.2 },
              open = "Neotree position=top buffers",
            },
            "neo-tree",
          }
        '';
      };
    };
  };
}
