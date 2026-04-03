{ pkgs, ... }:
let
  autolockWasm = "${pkgs.zellij-autolock}/share/zellij/plugins/zellij-autolock.wasm";
in
{
  xdg.dataFile = {
    "autolock" = {
      source = autolockWasm;
      target = "zellij/plugins/autolock.wasm";
    };
  };

  programs.zellij = {
    enable = true;
    attachExistingSession = true;
    enableZshIntegration = true;

    settings = {
      pane_frames = false;
      theme = "nord";
      default_mode = "normal";
      copy_command = "pbcopy";

      plugins = {
        "autolock" = {
          _props.location = "file:~/.local/share/zellij/plugins/autolock.wasm";

          is_enabled = true;
          triggers = "nvim|vim|v|nv";
          watch_triggers = "fzf|zoxide|atuin";
          watch_interval = "1.0";
        };
      };

      load_plugins = {
        "autolock" = {};
      };

      keybinds = {
        normal = {
          _children = [
            { bind = { _args = ["Ctrl h"]; MoveFocusOrTab = { _args = ["Left"]; }; }; }
            { bind = { _args = ["Ctrl j"]; MoveFocus = { _args = ["Down"]; }; }; }
            { bind = { _args = ["Ctrl k"]; MoveFocus = { _args = ["Up"]; }; }; }
            { bind = { _args = ["Ctrl l"]; MoveFocusOrTab = { _args = ["Right"]; }; }; }
          ];
        };
      };
    };
  };
}
