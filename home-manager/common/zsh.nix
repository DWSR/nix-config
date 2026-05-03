{ lib, ... }:
{
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
    # mkOrder 550 block in configurations/shopify/home-manager/dev.nix
    # and mkOrder 1000 in configurations/personal/home-manager/op-shell-plugins.nix).
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
