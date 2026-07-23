{
  config,
  lib,
  pkgs,
  ...
}:
let
  shameTrackLocator = pkgs.writeText "devx-shame-track-locator.applescript" ''
    tell application "System Events"
      tell process "Music"
        set frontmost to true
        set contentArea to scroll area 2 of splitter group 1 of window "Music"
        repeat with trackList in (every UI element of list 1 of contentArea)
          try
            repeat with trackRow in (every UI element of trackList)
              try
                repeat with trackLabel in (every static text of trackRow)
                  if (value of trackLabel) is "Never Gonna Give You Up (2022 Remaster)" then
                    set rowPosition to position of trackRow
                    set rowSize to size of trackRow
                    return (((item 1 of rowPosition) + (item 1 of rowSize) / 2) as text) & "," & ¬
                      (((item 2 of rowPosition) + (item 2 of rowSize) / 2) as text)
                  end if
                end repeat
              end try
            end repeat
          end try
        end repeat
        return "NOT_FOUND"
      end tell
    end tell
  '';

  shameTrackDoubleClick = pkgs.writeText "devx-shame-track-double-click.js" ''
    function run(argv) {
      ObjC.import("CoreGraphics");
      var point = $.CGPointMake(Number(argv[0]), Number(argv[1]));
      for (var click = 1; click <= 2; click++) {
        var down = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
        var up = $.CGEventCreateMouseEvent($(), $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
        $.CGEventSetIntegerValueField(down, 1, click);
        $.CGEventSetIntegerValueField(up, 1, click);
        $.CGEventPost($.kCGHIDEventTap, down);
        delay(0.05);
        $.CGEventPost($.kCGHIDEventTap, up);
        delay(0.05);
      }
    }
  '';

  devxWrapper = pkgs.writeShellApplication {
    name = "devx";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      if [[ "''${1-}" == "shame" ]]; then
        /usr/bin/osascript -e 'set volume output volume 100'
        /usr/bin/open -a /System/Applications/Music.app \
          "https://music.apple.com/ca/album/never-gonna-give-you-up-2022-remaster/1624945511?i=1624945512"

        coordinates=""
        for _ in {1..15}; do
          if coordinates="$(/usr/bin/osascript ${shameTrackLocator} 2>/dev/null)" \
            && [[ "$coordinates" != "NOT_FOUND" ]]; then
            break
          fi
          coordinates=""
          sleep 1
        done

        if [[ -z "$coordinates" ]]; then
          printf 'devx shame: Apple Music track did not load\n' >&2
          exit 1
        fi

        IFS=, read -r x y <<< "$coordinates"
        # Music's custom track rows ignore AXPress, so send a real double-click.
        /usr/bin/osascript -l JavaScript ${shameTrackDoubleClick} "$x" "$y"

        sleep 1
        exec /usr/bin/osascript \
          -e 'tell application "System Events" to keystroke "q" using {control down, command down}'
      fi

      # PATH can retain shims from older Home Manager generations, causing
      # different versions of this wrapper to exec each other forever.
      exec "${config.home.homeDirectory}/.local/state/tec/toolchain/base_profile/share/dev/bin/user/devx" "$@"
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
