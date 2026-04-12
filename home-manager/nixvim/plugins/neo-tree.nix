{ config, ... }:
let
  helpers = config.lib.nixvim;
in
{
  programs.nixvim = {
    plugins.neo-tree = {
      enable = true;

      settings = {
        filesystem.filtered_items = {
          visible = true;
          never_show = [
            ".git"
            ".DS_Store"
            "thumbs.db"
          ];
        };

        open_files_do_not_replace_types = [
          "terminal"
          "Trouble"
          "qf"
          "edgy"
        ];
        use_libuv_file_watcher = true;
        follow_current_file = {
          enabled = true;
          leave_dirs_open = true;
        };
      };
    };

    autoCmd = [
      {
        event = "BufEnter";
        group = "neotree_reveal";
        desc = "Reveal current file in Neotree";
        callback = helpers.mkRaw ''
          function()
            if vim.bo.filetype == "neo-tree" then
              return
            end
            local buf_path = vim.api.nvim_buf_get_name(0)
            if buf_path == "" then
              return
            end
            local ok, manager = pcall(require, "neo-tree.sources.manager")
            if ok then
              pcall(manager.navigate, "filesystem", nil, buf_path)
            end
          end
        '';
      }
      {
        event = "BufLeave";
        group = "git_refresh_neotree";
        desc = "Refresh Neotree git status";
        pattern = [ "*term*" ];
        callback = helpers.mkRaw ''
          function()
            local events = require("neo-tree.events")
            events.fire_event(events.GIT_EVENT)
          end
        '';
      }
    ];

    autoGroups = {
      "neotree_reveal" = {
        clear = true;
      };
      "git_refresh_neotree" = {
        clear = true;
      };
    };
  };
}
