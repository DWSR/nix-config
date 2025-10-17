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
          never_show = [".git" ".DS_Store" "thumbs.db"];
        };

        open_files_do_not_replace_types = ["terminal" "Trouble" "qf" "edgy"];
        use_libuv_file_watcher = true;
        follow_current_file.enabled = true;
      };
    };

    autoCmd = [
      {
        event = "BufLeave";
        group = "git_refresh_neotree";
        desc = "Refresh Neotree git status";
        pattern = ["*term*"];
        callback = helpers.mkRaw ''
          function()
            local events = require("neo-tree.events")
            events.fire_event(events.GIT_EVENT)
          end
        '';
      }
    ];

    autoGroups = {"git_refresh_neotree" = {clear = true;};};
  };
}
