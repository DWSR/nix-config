{
  inputs,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    inputs.nix-index-database.homeModules.nix-index

    ./atuin.nix
    ./gh-cli.nix
    ./ghostty.nix
    ./git.nix
    ./opencode.nix
    ./ssh.nix
    ./starship.nix
    ./zellij.nix
    ./zsh.nix

    ../nixvim

    # Minimal mode only loads shell modules by default.
    # Explicitly import every program module we use, plus their transitive deps.
    "${inputs.home-manager}/modules/programs/atuin.nix"
    "${inputs.home-manager}/modules/programs/bat.nix"
    "${inputs.home-manager}/modules/programs/command-not-found"
    "${inputs.home-manager}/modules/programs/delta.nix"
    "${inputs.home-manager}/modules/programs/diff-highlight.nix"
    "${inputs.home-manager}/modules/programs/diff-so-fancy.nix"
    "${inputs.home-manager}/modules/programs/difftastic.nix"
    "${inputs.home-manager}/modules/programs/direnv.nix"
    "${inputs.home-manager}/modules/programs/emacs.nix"
    "${inputs.home-manager}/modules/programs/eza.nix"
    "${inputs.home-manager}/modules/programs/fd.nix"
    "${inputs.home-manager}/modules/programs/fish.nix"
    "${inputs.home-manager}/modules/programs/fzf.nix"
    "${inputs.home-manager}/modules/programs/gh-dash.nix"
    "${inputs.home-manager}/modules/programs/gh.nix"
    "${inputs.home-manager}/modules/programs/ghostty.nix"
    "${inputs.home-manager}/modules/programs/git.nix"
    "${inputs.home-manager}/modules/programs/gpg.nix"
    "${inputs.home-manager}/modules/programs/home-manager.nix"
    "${inputs.home-manager}/modules/programs/jq.nix"
    "${inputs.home-manager}/modules/programs/jqp.nix"
    "${inputs.home-manager}/modules/programs/jujutsu.nix"
    "${inputs.home-manager}/modules/programs/k9s.nix"
    "${inputs.home-manager}/modules/programs/man.nix"
    "${inputs.home-manager}/modules/programs/nix-index.nix"
    "${inputs.home-manager}/modules/programs/nix-your-shell.nix"
    "${inputs.home-manager}/modules/programs/opencode.nix"
    "${inputs.home-manager}/modules/programs/pandoc.nix"
    "${inputs.home-manager}/modules/programs/patdiff.nix"
    "${inputs.home-manager}/modules/programs/pay-respects.nix"
    "${inputs.home-manager}/modules/programs/readline.nix"
    "${inputs.home-manager}/modules/programs/riff.nix"
    "${inputs.home-manager}/modules/programs/ripgrep.nix"
    "${inputs.home-manager}/modules/programs/ssh.nix"
    "${inputs.home-manager}/modules/programs/starship.nix"
    "${inputs.home-manager}/modules/programs/tealdeer.nix"
    "${inputs.home-manager}/modules/programs/vim.nix"
    "${inputs.home-manager}/modules/programs/zellij.nix"
    "${inputs.home-manager}/modules/programs/zoxide.nix"

    "${inputs.home-manager}/modules/services/tldr-update.nix"
  ];

  home = {
    preferXdgDirectories = true;

    packages = with pkgs; [
      apple-sdk
      atuin
      # Universal formatters for conform.nvim (devshell tools take priority)
      nixfmt-rfc-style
      shfmt
      stylua
      cloc
      cosign
      crane
      curl
      direnv
      dyff
      entr
      karabiner-elements
      kubectl
      k9s
      lazygit
      openssh
      rclone
      readline
      rsync
      shadowenv
      tree
      unstable.keymapp
      unstable.slack
      viddy
      xz

      raycast
    ];

    activation.createScratchDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p ~/scratch
    '';

    activation.createZellijNotesDir = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
      mkdir -p ~/.config/zellij/notes
    '';

    shell = {
      enableShellIntegration = true;
      enableZshIntegration = true;
    };

    shellAliases = {
      ls = "eza";
      l = "eza";
      "--help" = "--help 2>&1 | bat --language=help --style=plain";
      cat = "bat --paging=never --style=plain";
      e = "nvim .";
      gd = "git diff";
    };

    sessionVariables = {
      DO_NOT_TRACK = "1";
      OBJC_DISABLE_INITIALIZE_FORK_SAFETY = "YES";
      KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
      FZF_DEFAULT_OPTS = "--popup";
      _ZO_FZF_OPTS = "--popup";
    };
  };

  programs.eza = {
    enable = true;
    extraOptions = [
      "--long"
      "--all"
      "--header"
      "--group-directories-first"
    ];
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
  programs.zoxide.enable = true;
}
