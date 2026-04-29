{
  config,
  lib,
  ...
}:
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

      # Globally suppress the `core.hooksPath is set` prompt from
      # Dev::Helpers::GitHookManager. We manage git hooks via home-manager's
      # global dispatcher (see home-manager/common/git-hooks.nix), so we never
      # want dev to offer to unset core.hooksPath. The literal `*` is the
      # global-disable sentinel introduced upstream alongside glob-pattern
      # support in `hooks.warning_disable` (fnmatch with FNM_PATHNAME).
      # See memories/2026-04-28-git-hook-manager-warning-disable-globs.md.
      "hooks" = {
        "warning_disable" = "*";
      };

      "suppress-info" = {
        "outdated_nix_installation_warning" = true;
        "clang-xclt-17.0.0/0.13.3-too-new" = true;
        "notifications.up" = true;
      };
    };
  };

  programs.zsh.initContent = lib.mkOrder 550 (
    lib.concatStringsSep "\n\n" [
      # dev specifically looks for this string when running tasks :eyeroll:
      # This also has to come before tec setup or tec complains
      "[[ -x /opt/homebrew/bin/brew ]] && eval $(/opt/homebrew/bin/brew shellenv)"
      ''[[ -f /opt/dev/sh/chruby/chruby.sh ]] && { type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; } }''
      # tec setup
      # No longer need [ -f /opt/dev/dev.sh ] && source /opt/dev/dev.sh because tec setup does it.
      ''[[ -x ${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/init ]] && eval "$(${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/init zsh)"''
    ]
  );
}
