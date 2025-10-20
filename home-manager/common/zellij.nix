{ pkgs, ... }:
let
  autolock = builtins.fetchurl {
    url = "https://github.com/fresh2dev/zellij-autolock/releases/download/0.2.2/zellij-autolock.wasm";
    sha256 = "aclWB7/ZfgddZ2KkT9vHA6gqPEkJ27vkOVLwIEh7jqQ=";
  };

  zj-quit = builtins.fetchurl {
    url = "https://github.com/cristiand391/zj-quit/releases/download/0.3.1/zj-quit.wasm";
    sha256 = "JSYnGGN2SLNComhMg4P814dV3TV6jRvTv9fts9oTf5Q=";
  };
in
{
  xdg.dataFile = {
    "autolock" = {
      source = autolock;
      target = "zellij/plugins/autolock.wasm";
    };

    "zj-quit" = {
      source = zj-quit;
      target = "zellij/plugins/zj-quit.wasm";
    };
  };

  programs.zellij = {
    enable = true;
    attachExistingSession = true;
    enableZshIntegration = true;

    settings = {
      pane_frames = false;
      theme = "nord";
      default_mode = "locked";
      copy_command = "pbcopy";

      plugins = {
        "zj-quit" = {
          _props.location = "file:~/.local/share/zellij/plugins/zj-quit.wasm";

          confirm_key = "Enter";
          cancel_key = "Esc";
        };

        "autolock" = {
          _props.location = "file:~/.local/share/zellij/plugins/autolock.wasm";

          is_enabled = false;
          triggers = "nvim|vim|v|nv";
          watch_triggers = "fzf|zoxide|atuin";
          watch_interval = "1.0";
        };
      };

      load_plugins = {
        "autolock" = {};
      };

      keybinds = {
        shared_except = {
          _args = ["locked"];

          bind = {
            _args = ["Ctrl q"];

            LaunchOrFocusPlugin = {
              _args = ["zj-quit"];
              floating = true;
            };
          };
        };
      };
    };
  };
}
