{ pkgs, ... }:
let
  autolockWasm = "${pkgs.zellij-autolock}/share/zellij/plugins/zellij-autolock.wasm";
  worktreeWasm = "${pkgs.zellij-worktree}/share/zellij/plugins/zellij-worktree.wasm";
  attentionWasm = "${pkgs.zellij-attention}/share/zellij/plugins/zellij-attention.wasm";
  zjstatusWasm = "${pkgs.zjstatus}/share/zellij/plugins/zjstatus.wasm";
  forgotWasm = "${pkgs.zellij-forgot}/share/zellij/plugins/zellij-forgot.wasm";
  notepadWasm = "${pkgs.zellij-notepad}/share/zellij/plugins/zellij-notepad.wasm";
in
{
  xdg.configFile."zellij/layouts/default.kdl" = let
    # Powerline arrow characters (U+E0B0 , U+E0B2 )
    arrow = builtins.fromJSON "\"\\ue0b0\"";
    arrowLeft = builtins.fromJSON "\"\\ue0b2\"";
  in {
    text = ''
      layout {
        default_tab_template {
          children
          pane size=1 borderless=true {
            plugin location="file:~/.local/share/zellij/plugins/zjstatus.wasm" {
              format_left  "{mode}#[bg=#3B4252,fg=#4C566A]${arrow}{tabs}#[bg=default,fg=#3B4252]${arrow}"
              format_right "#[bg=default,fg=#3B4252]${arrowLeft}#[bg=#3B4252,fg=#D8DEE9] {datetime} "
              format_center ""
              format_space ""
              format_hide_on_overlength "true"
              format_precedence "lrc"

              mode_normal  "#[bg=#4C566A,fg=#A3BE8C,bold] NORMAL "
              mode_locked  "#[bg=#4C566A,fg=#BF616A,bold] LOCKED "
              mode_default_to_mode "normal"

              tab_normal           "#[fg=#616E88,bg=#3B4252] {name}"
              tab_active           "#[fg=#88C0D0,bg=#3B4252,bold] {name}"
              tab_normal_fullscreen "#[fg=#616E88,bg=#3B4252] {name} []"
              tab_active_fullscreen "#[fg=#88C0D0,bg=#3B4252,bold] {name} []"
              tab_normal_sync      "#[fg=#616E88,bg=#3B4252] {name} <>"
              tab_active_sync      "#[fg=#88C0D0,bg=#3B4252,bold] {name} <>"

              datetime        "{format}"
              datetime_format "%a %d %b %H:%M"
              datetime_timezone "America/Toronto"

              hide_frame_for_single_pane "true"
            }
          }
        }
      }
    '';
  };

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

    "zjstatus" = {
      source = zjstatusWasm;
      target = "zellij/plugins/zjstatus.wasm";
    };

    "forgot" = {
      source = forgotWasm;
      target = "zellij/plugins/zellij-forgot.wasm";
    };

    "notepad" = {
      source = notepadWasm;
      target = "zellij/plugins/zellij-notepad.wasm";
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
      show_startup_tips = false;

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

          base_path = "/Users/brandonmcnama/scratch";
          checkout_trunk = "true";
        };

        "attention" = {
          _props.location = "file:~/.local/share/zellij/plugins/zellij-attention.wasm";
        };

        "forgot" = {
          _props.location = "file:~/.local/share/zellij/plugins/zellij-forgot.wasm";
        };

        "notepad" = {
          _props.location = "file:~/.local/share/zellij/plugins/zellij-notepad.wasm";
        };
      };

      load_plugins = {
        "autolock" = {};
        "attention" = {};
        "notepad" = {};
      };

      keybinds = {
        shared_except = {
          _args = ["locked"];

          _children = [
            { bind = { _args = ["Ctrl w"]; LaunchOrFocusPlugin = { _args = ["worktree"]; floating = true; }; }; }
            { bind = { _args = ["Alt i"]; MessagePlugin = { _args = ["notepad"]; name = "toggle"; }; }; }
            { bind = { _args = ["Ctrl y"]; LaunchOrFocusPlugin = {
              _args = ["forgot"];
              LOAD_ZELLIJ_BINDINGS = "false";
              floating = true;
              lock = "ctrl + g";
              unlock = "ctrl + g";
              new-pane = "ctrl + p + n";
              change-focus-of-pane = "ctrl + p + arrow key";
              close-pane = "ctrl + p + x";
              rename-pane = "ctrl + p + c";
              toggle-fullscreen = "ctrl + p + f";
              toggle-floating-pane = "ctrl + p + w";
              toggle-embed-pane = "ctrl + p + e";
              choose-right-pane = "ctrl + p + l";
              choose-left-pane = "ctrl + p + r";
              choose-upper-pane = "ctrl + p + k";
              choose-lower-pane = "ctrl + p + j";
              new-tab = "ctrl + t + n";
              close-tab = "ctrl + t + x";
              change-focus-of-tab = "ctrl + t + arrow key";
              rename-tab = "ctrl + t + r";
              sync-tab = "ctrl + t + s";
              break-pane-to-new-tab = "ctrl + t + b";
              break-pane-left = "ctrl + t + [";
              break-pane-right = "ctrl + t + ]";
              toggle-tab = "ctrl + t + tab";
              increase-pane-size = "ctrl + n + +";
              decrease-pane-size = "ctrl + n + -";
              increase-pane-top = "ctrl + n + k";
              increase-pane-right = "ctrl + n + l";
              increase-pane-bottom = "ctrl + n + j";
              increase-pane-left = "ctrl + n + h";
              decrease-pane-top = "ctrl + n + K";
              decrease-pane-right = "ctrl + n + L";
              decrease-pane-bottom = "ctrl + n + J";
              decrease-pane-left = "ctrl + n + H";
              move-pane-to-top = "ctrl + h + k";
              move-pane-to-right = "ctrl + h + l";
              move-pane-to-bottom = "ctrl + h + j";
              move-pane-to-left = "ctrl + h + h";
              search = "ctrl + s + s";
              go-into-edit-mode = "ctrl + s + e";
              detach-session = "ctrl + o + w";
              open-session-manager = "ctrl + o + w";
              quit-zellij = "ctrl + q";
              notepad = "alt + i";
            }; }; }
          ];
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
