{
  config,
  lib,
  ...
}:
let
  home = config.home.homeDirectory;
  nixConfigRepo = "${home}/src/github.com/DWSR/nix-config";
  yugabyteRepo = "${home}/src/github.com/Shopify/globaldb-yugabyte";
in
{
  # Shopify-host zellij default layout: 3 tabs for daily workflow.
  #
  #   stats      – left: tokscale above mcpproxy tui; right: gh dash
  #   nix-config – top: opencode, bottom: shell, cwd: nix-config repo
  #   gdb-yb     – top: opencode, bottom: shell, cwd: globaldb-yugabyte repo
  #
  # Overrides home-manager/common/zellij.nix's empty-tab default. The
  # status bar pane is read from `config.home.zellij.statusBarPane` so
  # the bar definition stays single-source-of-truth in the common module.
  #
  # `lib.mkForce` is required because the common module sets the same
  # `xdg.configFile` entry (with `lib.mkDefault`).
  xdg.configFile."zellij/layouts/default.kdl".text = lib.mkForce ''
    layout {
      default_tab_template {
        children
        ${config.home.zellij.statusBarPane}
      }

      tab name="stats" cwd="${home}" {
        pane split_direction="vertical" {
          pane name="gh dash" {
            command "gh"
            args "dash"
          }
          pane split_direction="horizontal" {
            pane name="tokscale" {
              command "tokscale"
            }
            pane name="mcpproxy tui" {
              command "mcpproxy"
              args "tui"
            }
          }
        }
      }

      tab name="nix-config" cwd="${nixConfigRepo}" {
        pane split_direction="horizontal" {
          pane {
            command "opencode"
          }
          pane
        }
      }

      tab name="gdb-yb" cwd="${yugabyteRepo}" {
        pane split_direction="horizontal" {
          pane {
            command "opencode"
          }
          pane
        }
      }
    }
  '';
}
