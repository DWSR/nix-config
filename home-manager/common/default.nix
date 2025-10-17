{ inputs, outputs, pkgs, ... }:
{
  imports = [
    inputs.nix-index-database.homeModules.nix-index

    ./atuin.nix
    ./ghostty.nix
    ./zellij.nix
    ./starship.nix
    ./gh-cli.nix
    ./zsh.nix
    ../nixvim
  ];

  nixpkgs.overlays = [
    outputs.overlays.unstable-packages
    inputs.nixneovimplugins.overlays.default
  ];

  xdg.enable = true;
  xdg.configFile."mcphub/servers.json" = {
    enable = true;
    text = builtins.toJSON ({
      mcpServers = {
        nixos = {
          command = "nix";
          args = ["run" "github:utensils/mcp-nixos" "--"];
        };
      };
    });
  };

  editorconfig = {
    enable = true;

    settings = {
      "*" = {
        end_of_line = "lf";
        insert_final_newline = true;
        indent_style = "space";
        indent_size = 2;
        charset = "utf-8";
        trim_trailing_whitespace = true;
        max_line_length = 119;
      };

      "*.go" = {
        indent_style = "tab";
      };

      "*.py" = {
        indent_style = "space";
        indent_size = 4;
        max_line_length = 79;
      };

      "Makefile" = {
        indent_style = "tab";
      };

      "*.{yml,yaml}" = {
        indent_style = "space";
        indent_size = 2;
      };
    };
  };

  fonts = {
    fontconfig = {
      enable = true;

      defaultFonts = {
        monospace = ["MonaspiceNe Nerd Font Medium"];
      };
    };
  };


  home = {
    shell = {
      enableShellIntegration = true;
      enableZshIntegration = true;
    };

    shellAliases = {
      ls = "eza";
      l = "eza";
      "--help" = "--help 2>&1 | bat --language=help --style=plain'";
      cat = "bat --paging=never --style=plain";
      e = "nvim .";
      gd = "git diff";
    };

    sessionVariables = {
      DO_NOT_TRACK = "1";
      OBJC_DISABLE_INITIALIZE_FORK_SAFETY = "YES";
      KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
    };
  };

  programs.eza = {
    enable = true;
    extraOptions = ["--long" "--all" "--header" "--group-directories-first"];
    colors = "auto";
    git = true;
    icons = "auto";
  };

  programs.home-manager.enable = true;
  programs.bat = {
    enable = true;

    config = {
      "theme" = "Nord";
      "style" = "numbers,changes,header";
    };
  };

  programs.direnv = {
    enable = true;
    mise.enable = true;
    nix-direnv.enable = true;
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
  programs.nix-index-database.comma.enable = true;
  programs.nix-your-shell.enable = true;
  programs.pandoc.enable = true;
  programs.pay-respects.enable = true;
  programs.readline.enable = true;
  programs.ripgrep.enable = true;
  programs.tealdeer.enable = true;
}
