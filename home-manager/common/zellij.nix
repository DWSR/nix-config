{
  pkgs,
  config,
  lib,
  ...
}:
let
  autolockWasm = "${pkgs.zellij-autolock}/share/zellij/plugins/zellij-autolock.wasm";
  worktreeWasm = "${pkgs.zellij-worktree}/share/zellij/plugins/zellij-worktree.wasm";
  attentionWasm = "${pkgs.zellij-attention}/share/zellij/plugins/zellij-attention.wasm";
  zjstatusWasm = "${pkgs.zjstatus}/share/zellij/plugins/zjstatus.wasm";
  forgotWasm = "${pkgs.zellij-forgot}/share/zellij/plugins/zellij-forgot.wasm";
  notepadWasm = "${pkgs.zellij-notepad}/share/zellij/plugins/zellij-notepad.wasm";

  # Powerline arrow characters (U+E0B0 , U+E0B2 )
  arrow = builtins.fromJSON "\"\\ue0b0\"";
  arrowLeft = builtins.fromJSON "\"\\ue0b2\"";

  # base16 palette (Nord via stylix), `#`-prefixed lowercase hex. Used to
  # derive the zjstatus status-bar colors from the active theme instead of
  # hardcoding Nord hex.
  colors = config.lib.stylix.colors.withHashtag;

  # Default zjstatus status-bar pane KDL fragment. Hosts that override
  # the zellij default layout can reference
  # `config.home.zellij.statusBarPane` to keep the bar in sync without
  # duplicating the format strings, colors, and Nix-interpolated arrow
  # characters.
  defaultStatusBarPane = ''
    pane size=1 borderless=true {
      plugin location="file:~/.local/share/zellij/plugins/zjstatus.wasm" {
        format_left  "{mode}#[bg=${colors.base01},fg=${colors.base03}]${arrow}{tabs}#[bg=default,fg=${colors.base01}]${arrow}"
        format_right "#[bg=default,fg=${colors.base01}]${arrowLeft}#[bg=${colors.base01},fg=${colors.base04}] {datetime} "
        format_center ""
        format_space ""
        format_hide_on_overlength "true"
        format_precedence "lrc"

        mode_normal  "#[bg=${colors.base03},fg=${colors.base0B},bold] NORMAL "
        mode_locked  "#[bg=${colors.base03},fg=${colors.base08},bold] LOCKED "
        mode_default_to_mode "normal"

        tab_normal           "#[fg=${colors.base03},bg=${colors.base01}] {name}"
        tab_active           "#[fg=${colors.base0C},bg=${colors.base01},bold] {name}"
        tab_normal_fullscreen "#[fg=${colors.base03},bg=${colors.base01}] {name} []"
        tab_active_fullscreen "#[fg=${colors.base0C},bg=${colors.base01},bold] {name} []"
        tab_normal_sync      "#[fg=${colors.base03},bg=${colors.base01}] {name} <>"
        tab_active_sync      "#[fg=${colors.base0C},bg=${colors.base01},bold] {name} <>"

        datetime        "{format}"
        datetime_format "%a %d %b %H:%M"
        datetime_timezone "America/Toronto"

        hide_frame_for_single_pane "true"
      }
    }
  '';
in
{
  options.home.zellij = {
    statusBarPane = lib.mkOption {
      type = lib.types.lines;
      default = defaultStatusBarPane;
      description = ''
        KDL fragment for the zjstatus status-bar pane appended to every
        zellij tab. Read by both the common default layout and any
        host-specific layout overrides
        per-host module so the
        status bar definition lives in one place.
      '';
    };
  };

  config = {
    xdg.configFile."zellij/layouts/default.kdl".text = lib.mkDefault ''
      layout {
        default_tab_template {
          children
          ${config.home.zellij.statusBarPane}
        }
      }
    '';

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
      # Pinned to 0.44.1 via overlays/misc.nix (built from
      # final.unstable.rustPlatform because stable rustc 1.91.1 < the
      # 1.92 zellij 0.44.1 requires). Pinning gives reproducibility — the
      # previous `pkgs.unstable.zellij` reference picked up whatever
      # unstable happened to ship at evaluation time and silently advanced
      # 0.44.1 → 0.44.2 between channel bumps. To bump intentionally, edit
      # overlays/misc.nix and re-run the hash discovery cycle there.
      # The zellij-plugins overlay (overlays/zellij-plugins.nix) builds
      # plugins against zellij-tile 0.44 — keep zellij on the 0.44.x line
      # to preserve plugin ABI compatibility.
      package = pkgs.zellij;
      # attachExistingSession would inject `export ZELLIJ_AUTO_ATTACH=true`
      # into the shell init via home-manager's zellij module. We disable
      # enableZshIntegration (see home-manager/common/zsh.nix's mkInitCache)
      # to skip the ~93ms-per-shell `eval $(zellij setup --generate-auto-start zsh)`
      # subprocess fork, so the home-manager-injected env var would never
      # land. Setting attachExistingSession = true with enableZshIntegration
      # disabled produces a misleading home-manager warning at eval time.
      # We instead bake `export ZELLIJ_AUTO_ATTACH=true` directly into the
      # cached zellij init file (see zsh.nix:cachedInits.zellij), preserving
      # the attach-existing behavior without the warning.
      attachExistingSession = false;
      enableZshIntegration = true;

      settings = {
        pane_frames = false;
        # The Stylix zellij target writes ~/.config/zellij/themes/stylix.kdl
        # whose inner theme block is named `default` (not `stylix`). Zellij
        # registers themes by their inner block name, so the active theme must
        # be "default" to apply the Stylix Nord palette.
        theme = "default";
        default_mode = "normal";
        copy_command = "pbcopy";
        show_startup_tips = false;

        plugins = {
          "autolock" = {
            _props.location = "file:~/.local/share/zellij/plugins/autolock.wasm";

            is_enabled = true;
            triggers = "nvim|vim|v|nv|opencode";
            watch_triggers = "fzf|zoxide|atuin";
            watch_interval = "1.0";
          };

          "worktree" = {
            _props.location = "file:~/.local/share/zellij/plugins/zellij-worktree.wasm";

            base_path = "${config.home.homeDirectory}/scratch";
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
          "autolock" = { };
          "attention" = { };
          "notepad" = { };
        };

        keybinds = {
          shared_except = {
            _args = [ "locked" ];

            _children = [
              {
                bind = {
                  _args = [ "Ctrl w" ];
                  LaunchOrFocusPlugin = {
                    _args = [ "worktree" ];
                    floating = true;
                  };
                };
              }
              {
                bind = {
                  _args = [ "Alt i" ];
                  MessagePlugin = {
                    _args = [ "notepad" ];
                    name = "toggle";
                  };
                };
              }
              {
                bind = {
                  _args = [ "Ctrl y" ];
                  LaunchOrFocusPlugin = {
                    _args = [ "forgot" ];
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
                  };
                };
              }
            ];
          };

          normal = {
            _children = [
              {
                bind = {
                  _args = [ "Ctrl h" ];
                  MoveFocusOrTab = {
                    _args = [ "Left" ];
                  };
                };
              }
              {
                bind = {
                  _args = [ "Ctrl j" ];
                  MoveFocus = {
                    _args = [ "Down" ];
                  };
                };
              }
              {
                bind = {
                  _args = [ "Ctrl k" ];
                  MoveFocus = {
                    _args = [ "Up" ];
                  };
                };
              }
              {
                bind = {
                  _args = [ "Ctrl l" ];
                  MoveFocusOrTab = {
                    _args = [ "Right" ];
                  };
                };
              }
            ];
          };
        };
      };
    };
  };
}
