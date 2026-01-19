{ config, pkgs, lib, ... }:
{
  home.sessionVariables = {
    DEV_NO_AUTO_UPDATE = "1";
  };

  xdg.configFile."dev/config" = {
    enable = true;
    text = lib.generators.toINI { mkKeyValue = lib.generators.mkKeyValueDefault { } " = "; } {
      "user" = {
        "team_id" = "1977";
        "team_name" = "Database Platform";
        "team_fetch_next_time" = "4611686018427387903";
        "shopify_email" = "brandon.mcnama@shopify.com";
      };

      "fax" = {
        "suggested" = true;
      };

      "features" = {
        "precheck" = false;
        "new-process-manager" = true;
        "nix.dev-packages" = true;
        "nix.project-packages" = true;
        "notifications.up" = true;
        "nginx.install" = false;
      };

      "suppress-info" = {
        "outdated_nix_installation_warning" = true;
        "clang-xclt-17.0.0/0.13.3-too-new" = true;
        "notifications.up" = true;
      };
    };
  };

  programs.zsh.initContent = lib.mkOrder 550 (lib.concatStringsSep "\n\n" [
    # dev specifically looks for this string when running tasks :eyeroll:
    # This also has to come before tec setup or tec complains
    ''[[ -x /opt/homebrew/bin/brew ]] && eval $(/opt/homebrew/bin/brew shellenv)''
    ''[[ -f /opt/dev/sh/chruby/chruby.sh ]] && { type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; } }''
    # tec setup
    # No longer need [ -f /opt/dev/dev.sh ] && source /opt/dev/dev.sh because tec setup does it.
    ''[[ -x /Users/brandonmcnama/.local/state/tec/profiles/base/current/global/init ]] && eval "$(/Users/brandonmcnama/.local/state/tec/profiles/base/current/global/init zsh)"''
  ]);
}
