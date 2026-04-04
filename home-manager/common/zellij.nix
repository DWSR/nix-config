{ pkgs, ... }:
let
  autolockWasm = "${pkgs.zellij-autolock}/share/zellij/plugins/zellij-autolock.wasm";
  worktreeWasm = "${pkgs.zellij-worktree}/share/zellij/plugins/zellij-worktree.wasm";
  attentionWasm = "${pkgs.zellij-attention}/share/zellij/plugins/zellij-attention.wasm";
in
{
  xdg.dataFile = {
    "autolock" = {
      source = autolockWasm;
      target = "zellij/plugins/autolock.wasm";
    };

    "worktree" = {
      source = worktreeWasm;
      target = "zellij/plugins/zellij-worktree.wasm";
    };

    "attention" = {
      source = attentionWasm;
      target = "zellij/plugins/zellij-attention.wasm";
    };
  };

  programs.zellij = {
    enable = true;
    # TODO: Remove once zellij 0.44 is available in stable nixpkgs
    # Unstable required for fzf --popup support (needs zellij >= 0.44)
    package = pkgs.unstable.zellij;
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

        "worktree" = {
          _props.location = "file:~/.local/share/zellij/plugins/zellij-worktree.wasm";

          base_path = "~/scratch";
        };

        "attention" = {
          _props.location = "file:~/.local/share/zellij/plugins/zellij-attention.wasm";
        };
      };

      load_plugins = {
        "autolock" = {};
        "attention" = {};
      };

      keybinds = {
        shared_except = {
          _args = ["locked"];

          bind = {
            _args = ["Ctrl w"];

            LaunchOrFocusPlugin = {
              _args = ["worktree"];
              floating = true;
            };
          };
        };

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
