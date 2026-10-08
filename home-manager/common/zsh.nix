{
  pkgs,
  lib,
  config,
  ...
}:
let
  # Build a derivation containing the captured stdout of `script` as a
  # zsh script suitable for `source`-ing. Replaces a runtime
  # `eval "$(<tool> init zsh)"` (subprocess fork on every shell start)
  # with a `source <cached-file>` (read from page cache, no fork).
  #
  # The script body must redirect its tool-init invocation to $out
  # itself (e.g. `<tool> init zsh > $out`). Multi-line setup before the
  # redirect is supported (atuin needs HOME-tmpdir setup to read its
  # config.toml from within Nix's sandbox).
  #
  # Output stability per tool was verified by xtrace measurement on
  # 2026-04-30: each cached tool's init output is deterministic per
  # tool-version + machine, with no per-invocation runtime state baked
  # into the captured stdout. Re-verify if a tool gains a feature that
  # depends on per-invocation state (e.g. session UUID generation).
  mkInitCache =
    name: script:
    pkgs.runCommand "zsh-init-${name}" { } ''
      set -euo pipefail
      ${script}
    '';

  # Per-tool init-output captures. Each script must redirect tool init
  # output to $out. Programs.<tool>.package is honored so user overrides
  # (e.g. zellij = pkgs.unstable.zellij in zellij.nix) compose correctly.
  cachedInits = {
    # zellij init reads $ZELLIJ_AUTO_ATTACH at runtime (the snippet has an
    # `if [[ "$ZELLIJ_AUTO_ATTACH" == "true" ]]; then zellij attach -c; …`
    # branch). The home-manager zellij module would set this env var via
    # programs.zellij.attachExistingSession + enableZshIntegration, but we
    # disabled enableZshIntegration to use the cached init. Prepending the
    # export to the cached file restores the attach-existing behavior
    # without resurrecting the live `eval $(zellij setup …)` subprocess.
    zellij = mkInitCache "zellij" ''
      echo 'export ZELLIJ_AUTO_ATTACH=true' > $out
      ${config.programs.zellij.package}/bin/zellij setup --generate-auto-start zsh >> $out
    '';
    zoxide = mkInitCache "zoxide" "${config.programs.zoxide.package}/bin/zoxide init zsh > $out";
    fzf = mkInitCache "fzf" "${config.programs.fzf.package}/bin/fzf --zsh > $out";
    starship = mkInitCache "starship" "${config.programs.starship.package}/bin/starship init zsh > $out";
    pay-respects = mkInitCache "pay-respects" "${config.programs.pay-respects.package}/bin/pay-respects zsh --alias > $out";
    nix-your-shell = mkInitCache "nix-your-shell" "${config.programs.nix-your-shell.package}/bin/nix-your-shell zsh > $out";
    direnv = mkInitCache "direnv" "${config.programs.direnv.package}/bin/direnv hook zsh > $out";
    # atuin init zsh reads ~/.config/atuin/config.toml to decide which
    # bindkey/keymap_mode lines to emit. Within Nix's sandbox HOME is
    # /homeless-shelter (read-only), so atuin can't read or auto-create
    # its config there. We seed a writable HOME with the same config.toml
    # that the home-manager atuin module renders to xdg.configFile, so
    # the cached output reflects the user's actual settings (vim-insert
    # keymap, fuzzy search, etc.).
    atuin = mkInitCache "atuin" ''
      export HOME=$(mktemp -d)
      mkdir -p "$HOME/.config/atuin"
      cp "${config.xdg.configFile."atuin/config.toml".source}" "$HOME/.config/atuin/config.toml"
      ${config.programs.atuin.package}/bin/atuin init zsh > $out
    '';
  };
in
{
  # Disable upstream zsh integrations for tools whose init output we cache.
  # Without these mkForce overrides, home-manager would inject a runtime
  # `eval "$(<tool> init zsh)"` line in addition to our cached source.
  programs.zellij.enableZshIntegration = lib.mkForce false;
  programs.zoxide.enableZshIntegration = lib.mkForce false;
  programs.fzf.enableZshIntegration = lib.mkForce false;
  programs.starship.enableZshIntegration = lib.mkForce false;
  programs.pay-respects.enableZshIntegration = lib.mkForce false;
  programs.nix-your-shell.enableZshIntegration = lib.mkForce false;
  programs.direnv.enableZshIntegration = lib.mkForce false;
  programs.atuin.enableZshIntegration = lib.mkForce false;

  programs.zsh = {
    enable = true;
    enableCompletion = true;
    enableVteIntegration = true;
    autocd = true;

    # Diagnostic hooks for shell startup profiling. Both are env-gated so
    # they cost nothing on a normal interactive shell.
    #
    # ZSH_PROFILE=1 zsh -i -c exit > /tmp/zprof.out 2>&1
    #   → loads `zmodload zsh/zprof` very early, prints the per-function
    #     timing table at the very end. Best for "which function is
    #     expensive?".
    #
    # ZSH_XTRACE=1 zsh -i -c exit 2>/tmp/zsh-xtrace.log
    #   → enables `setopt xtrace` with millisecond-resolution PS4
    #     timestamps, dumps every executed line. Best for "which exact
    #     line of which file is expensive?".
    #
    # Order positions: 1 (very early) and 9999 (very late) bracket every
    # other contribution to programs.zsh.initContent (compare with the
    # and mkOrder 1000 in configurations/personal/home-manager/op-shell-plugins.nix).
    #
    # Order 600 hosts the cached tool-init sources — runs after dev.nix's
    # order 550 (so brew/tec/chruby env are set up first) but before any
    # default-order or order-1000 contributions that may want the
    # integrations active.
    initContent = lib.mkMerge [
      (lib.mkOrder 1 ''
        if [[ -n "$ZSH_PROFILE" ]]; then
          zmodload zsh/zprof
        fi
        if [[ -n "$ZSH_XTRACE" ]]; then
          PS4='+%D{%s.%6.}: '
          setopt xtrace
        fi
      '')
      (lib.mkOrder 600 ''
        # Cached tool init sources — replaces upstream HM enableZshIntegration
        # eval-on-startup pattern. Each `source` line is byte-for-byte
        # equivalent to the corresponding `eval "$(<tool> init zsh)"` but
        # avoids a per-invocation subprocess fork. Cumulative measured
        # savings vs. uncached: ~235ms warm.
        source ${cachedInits.zellij}
        source ${cachedInits.zoxide}

        # Extend interactive zoxide selection with top-level ~/scratch
        # project directories without adding a shell-startup subprocess.
        function __zoxide_scratch_dirs() {
          [[ -d "$HOME/scratch" ]] || return 0

          \builtin local candidate
          for candidate in "$HOME"/scratch/*(DN/); do
            \builtin print -r -- "$candidate"
          done
        }

        function __zoxide_candidates() {
          \builtin local -A seen
          \builtin local candidate

          while IFS= read -r candidate; do
            [[ -n "$candidate" ]] || continue
            [[ -z "''${seen[$candidate]:-}" ]] || continue

            seen[$candidate]=1
            \builtin print -r -- "$candidate"
          done < <(
            \command zoxide query --list -- "$@" 2>/dev/null || \builtin true
            __zoxide_scratch_dirs
          )
        }

        function __zoxide_select() {
          \builtin local query
          \builtin local -a fzf_opts

          query="''${(j: :)@}"
          fzf_opts=(''${=:-''${_ZO_FZF_OPTS:-}})
          __zoxide_candidates "$@" | \command fzf "''${fzf_opts[@]}" --query "$query"
        }

        function __zoxide_zi() {
          __zoxide_doctor

          \builtin local result
          result="$(__zoxide_select "$@")" && [[ -n "$result" ]] && __zoxide_cd "$result"
        }

        if [[ -o zle ]]; then
          function __zoxide_z_complete() {
            # Only show completions when the cursor is at the end of the line.
            [[ "''${#words[@]}" -eq "''${CURRENT}" ]] || return 0

            if [[ "''${#words[@]}" -eq 2 ]]; then
              # Show completions for local directories.
              _cd -/

            elif [[ "''${words[-1]}" == "" ]]; then
              __zoxide_result="$(__zoxide_select ''${words[2,-1]})" || __zoxide_result=""

              # Set a result to ensure completion doesn't re-run.
              compadd -Q ""

              # Bind '\e[0n' to helper function.
              \builtin bindkey '\e[0n' '__zoxide_z_complete_helper'
              # Sends query device status code, which results in a '\e[0n' being sent to console input.
              \builtin printf '\e[5n'

              # Report that the completion was successful, so that we don't fall back
              # to another completion function.
              return 0
            fi
          }
        fi

        if [[ $options[zle] = on ]]; then
          source ${cachedInits.fzf}
        fi
        if [[ $TERM != "dumb" ]]; then
          source ${cachedInits.starship}
        fi
        source ${cachedInits.pay-respects}
        source ${cachedInits.nix-your-shell}
        source ${cachedInits.direnv}
        if [[ $options[zle] = on ]]; then
          source ${cachedInits.atuin}
        fi
      '')
      (lib.mkOrder 700 ''
        # opencode TUI teardown workaround (anomalyco/opencode#32336, #28358).
        # opencode's TUI exits without fully restoring the terminal: it leaves
        # mouse tracking, bracketed paste, and the alternate screen enabled, and
        # never drains its terminal-query replies — notably the cursor-position
        # report (ESC[8;1R, the answer to opencode's own ESC[6n). Inside zellij
        # that reply races past opencode's read loop into zsh, whose ZLE consumes
        # the ESC[ CSI introducer and self-inserts the trailing "8;1R" onto the
        # next prompt (the stray characters seen after quitting). This wrapper
        # runs after opencode exits to (1) re-disable the modes opencode forgot
        # and (2) drain any pending query replies so they never reach the prompt.
        #
        # `command opencode` keeps the foreground process named "opencode" so the
        # zellij autolock trigger (home-manager/common/zellij.nix) still fires.
        # Guarded on a tty so a non-interactive `opencode run` in a pipe is left
        # untouched. Remove once the upstream teardown bug is fixed and
        # opencode-pinned (overlays/misc.nix) is bumped past it.
        function opencode() {
          command opencode "$@"
          local _oc_status=$?
          if [[ -t 0 && -t 1 ]]; then
            printf '\e[?1049l\e[?1000l\e[?1002l\e[?1003l\e[?1006l\e[?2004l\e[?1004l\e[?25h'
            local _oc_flush
            while read -t 0.1 -k 1 -s _oc_flush 2>/dev/null; do : ; done
          fi
          return $_oc_status
        }
      '')
      (lib.mkOrder 9999 ''
        if [[ -n "$ZSH_XTRACE" ]]; then
          unsetopt xtrace
        fi
        if [[ -n "$ZSH_PROFILE" ]]; then
          zprof
        fi
      '')
    ];

    autosuggestion = {
      enable = true;
      strategy = [
        "history"
        "completion"
      ];
    };

    # `compinit -C` skips the security audit of $fpath. The Nix-managed
    # function-paths under /nix/store live in a root-owned, world-readable
    # tree where the audit cannot detect a real problem; running it just
    # adds ~100-200ms to every shell startup. Same `-C` applied to bashcompinit.
    completionInit = "autoload -U compinit && compinit -C && autoload -Uz bashcompinit && bashcompinit -C";
    defaultKeymap = "viins";

    history = {
      append = true;
      expireDuplicatesFirst = true;
      extended = true;
      # findNoDups = true;
      ignoreAllDups = true;
      ignoreSpace = true;
      save = 1000000000;
      share = true;
      # saveNoDups = true;
    };

    syntaxHighlighting = {
      enable = true;
      highlighters = [
        "main"
        "brackets"
        "cursor"
      ];
    };

  };
}
