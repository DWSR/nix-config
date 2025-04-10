{home-manager, username, ... }: {
  imports = [ home-manager.darwinModules.home-manager ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;

    users."brandonmcnama" = {
      xdg.enable = true;

      home = {
        # TODO: Remove this once 25.05 is released
        enableNixpkgsReleaseCheck = false;
        stateVersion = "24.11";
        preferXdgDirectories = true;

        shellAliases = {
          ls = "eza -lah --git";
          l = "ls";
          vim = "lvim";
        };

        sessionPath = [
          "$HOME/.local/bin"
          "$HOME/bin"
          "$HOME/go/bin"
        ];

        sessionVariables = {
          DO_NOT_TRACK = "1";
          GOPATH = "$HOME/go:$HOME/repos";
          OBJC_DISABLE_INITIALIZE_FORK_SAFETY = "YES";
          KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
        };
      };

      programs.home-manager.enable = true;
      programs.bat.enable = true;

      programs.direnv = {
        enable = true;
        mise.enable = true;
        nix-direnv.enable = true;
      };


      programs.eza = {
        enable = true;
        extraOptions = ["--long" "--all" "--header" "--group-directories-first"];
        colors = "auto";
        git = true;
        icons = "auto";
      };

      programs.fd = {
        enable = true;
        hidden = true;
      };

      programs.fzf.enable = true;
      programs.jq.enable = true;
      programs.jqp.enable = true;
      programs.k9s.enable = true;
      programs.nix-index.enable = true;
      programs.nix-your-shell.enable = true;
      programs.pandoc.enable = true;
      programs.pay-respects.enable = true;
      programs.readline.enable = true;
      programs.ripgrep.enable = true;
      programs.tealdeer.enable = true;
    };
  };
}
