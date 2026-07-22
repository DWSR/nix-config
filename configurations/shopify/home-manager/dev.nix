{
  config,
  lib,
  pkgs,
  ...
}:
let
  devxWrapper = pkgs.writeShellApplication {
    name = "devx";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      if [[ "''${1-}" == "shame" ]]; then
        exec /usr/bin/open "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      fi

      self="$(realpath "$0")"
      IFS=: read -ra pathEntries <<< "$PATH"
      for directory in "''${pathEntries[@]}"; do
        candidate="''${directory:-.}/devx"
        if [[ -x "$candidate" ]] && [[ "$(realpath "$candidate")" != "$self" ]]; then
          exec "$candidate" "$@"
        fi
      done

      printf 'devx: real executable not found in PATH\n' >&2
      exit 127
    '';
  };
in
{
  home.sessionVariables = {
    DEV_NO_AUTO_UPDATE = "1";

    # Hardcoded equivalent of `eval $(/opt/homebrew/bin/brew shellenv)`,
    # captured by running that command on the Shopify host. Skips the
    # ~18ms subprocess fork on every interactive shell start.
    #
    # The PATH entries (/opt/homebrew/bin, /opt/homebrew/sbin) are set
    # via home.sessionPath below. Order is preserved: home.sessionPath
    # runs in .zshenv (before .zshrc), so by the time the order-550
    # initContent block runs in .zshrc, brew paths are already prepended.
    # tec init in initContent then prepends tec paths in front of brew.
    # The devx wrapper is restored to the front afterward, while tec remains
    # ahead of brew as required by homebrew_path_order.rb (verified at
    # /opt/dev/lib/dev/tasks/prereq/
    # homebrew_path_order.rb).
    HOMEBREW_PREFIX = "/opt/homebrew";
    HOMEBREW_CELLAR = "/opt/homebrew/Cellar";
    HOMEBREW_REPOSITORY = "/opt/homebrew/Library/.homebrew-is-managed-by-nix";
    INFOPATH = "/opt/homebrew/share/info";
  };

  home.sessionPath = [
    "${devxWrapper}/bin"
    "/opt/homebrew/bin"
    "/opt/homebrew/sbin"
  ];

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
        "git.maintenance.adaptive-scheduling" = false;
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
      # Brew env is now set via home.sessionVariables + home.sessionPath
      # (above) instead of `eval $(/opt/homebrew/bin/brew shellenv)`.
      # The dev/tec PATH-order check at /opt/dev/lib/dev/tasks/prereq/
      # homebrew_path_order.rb inspects ENV['PATH'] order at runtime, not
      # the literal .zshrc content, so this transformation is safe.
      ''[[ -f /opt/dev/sh/chruby/chruby.sh ]] && { type chruby >/dev/null 2>&1 || chruby () { source /opt/dev/sh/chruby/chruby.sh; chruby "$@"; } }''
      # tec setup
      # No longer need [ -f /opt/dev/dev.sh ] && source /opt/dev/dev.sh because tec setup does it.
      #
      # The trailing `tec tools shell-hook 2>/dev/null || true` line in tec
      # init zsh's output costs ~146ms per shell start (queries Windex to
      # check if the tools profile is stale, then prints a notification
      # if so). We pin tec's profile declaratively in nix (see tec.nix),
      # which means the only way to update is `darwin-rebuild switch` —
      # the staleness notification is useless. Sed strips that one line
      # before eval-ing the rest of tec init.
      ''[[ -x ${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/init ]] && eval "$(${config.home.homeDirectory}/.local/state/tec/profiles/base/current/global/init zsh | ${pkgs.gnused}/bin/sed '/^tec tools shell-hook/d')"''
      ''export PATH="${devxWrapper}/bin:$PATH"''
    ]
  );
}
