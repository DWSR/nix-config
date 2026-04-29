_: {
  programs.zsh = {
    enable = true;
    enableCompletion = true;
    enableVteIntegration = true;
    autocd = true;

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
