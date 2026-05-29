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
  #   stats      – tokscale on the left, mcpproxy tui and caffeinate on the right
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
          pane name="tokscale" {
            command "tokscale"
          }
          pane split_direction="horizontal" {
            pane name="mcpproxy tui" {
              command "mcpproxy"
              args "tui"
            }
            pane name="caffeinate -dimsu" {
              command "caffeinate"
              args "-dimsu"
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
