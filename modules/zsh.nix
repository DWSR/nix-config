{ pkgs, home-manager, ... }: {
  home-manager.users."brandonmcnama".programs.zsh = {
    enable = true;
    enableCompletion = true;
    enableVteIntegration = true;
    autocd = true;

    autosuggestion = {
      enable = true;
      strategy = ["history" "completion"];
    };

    completionInit = "autoload -U compinit && compinit && autoload -Uz bashcompinit && bashcompinit";

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
      highlighters = ["main" "brackets" "cursor"];
    };
  };
}
