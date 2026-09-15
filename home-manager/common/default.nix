{
  config,
  inputs,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    inputs.nix-index-database.homeModules.nix-index

    ./agentmemory.nix
    ./atuin.nix
    ./cc-sdd.nix
    ./deskflow
    ./gh-cli.nix
    ./ghostty.nix
    ./git.nix
    ./git-hooks.nix
    ./git-clone-isolation.nix
    ./hammerspoon-brightness-ac
    ./hammerspoon-caffeinate
    ./hammerspoon-deskflow-watchdog
    ./hammerspoon-keybindings
    ./hammerspoon-mic-mute
    ./hammerspoon-timezone-menubar
    ./launchd-activation.nix
    ./memory-sync.nix
    ./opencode-cost-diagnosis.nix
    ./opencode-nono.nix
    ./opencode-nono-audit.nix
    ./opencode-rtk.nix
    ./opencode.nix
    ./pi.nix
    ./session-compaction.nix
    ./sqlite-backup.nix
    ./subagent-context-budget.nix
    ./ssh.nix
    ./starship.nix
    ./stylix.nix
    ./tailscale-serve.nix
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
    "${inputs.home-manager}/modules/programs/man"
    # nixvim's HM wrapper asserts `!config.programs.neovim.enable`, which
    # requires the neovim module to be present. Minimal mode does not load
    # it by default; import it (disabled) so the assertion can evaluate.
    "${inputs.home-manager}/modules/programs/neovim"
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

  # Disable home-manager's man-pages package. It defaults to enabled, which
  # pulls `docs.manPages` (and its transitive `options.json` builder) into
  # `home.packages`, producing a `Using 'builtins.derivation' to create a
  # derivation named 'options.json' that references the store path
  # '<nixpkgs-source>' without a proper context` warning on every `nix eval`.
  # We use `nix-index`/`command-not-found` for command lookups, not
  # `man home-configuration.nix`.
  manual.manpages.enable = false;

  home = {
    preferXdgDirectories = true;

    packages = with pkgs; [
      apple-sdk
      atuin
      # Universal formatters for conform.nvim (devshell tools take priority)
      nixfmt
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
      tokscale
      tree
      unstable.keymapp
      unstable.slack
      viddy
      xz

      unstable.raycast
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
      p = "pi";
      gd = "git diff";
    };

    sessionVariables = {
      DO_NOT_TRACK = "1";
      OBJC_DISABLE_INITIALIZE_FORK_SAFETY = "YES";
      KUBECTL_EXTERNAL_DIFF = "dyff between --omit-header --set-exit-code";
      _ZO_FZF_OPTS = "--popup";
    };
  };

  # Hammerspoon keybindings: enabled binding-free; consumers declare bindings.
  home.hammerspoon.enable = true;
  # Maximize the built-in display brightness when switching to AC power.
  home.hammerspoon.maximizeBrightnessOnAc.enable = true;
  home.hammerspoon.timezoneMenubar = {
    enable = true;
    timezones = [
      {
        label = "Toronto";
        timeZone = "America/Toronto";
      }
      {
        label = "UTC";
        timeZone = "Etc/UTC";
      }
      {
        label = "Vancouver";
        timeZone = "America/Vancouver";
      }
    ];
  };

  programs.cc-sdd.enable = true;
  programs.git-clone-isolation.enable = true;

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
      "style" = "numbers,changes,header";
    };
  };

  programs.direnv = {
    enable = true;
    mise.enable = false;
    nix-direnv.enable = true;
  };

  programs.fd = {
    enable = true;
    hidden = true;
  };

  # `--popup` is kept here (not in home.sessionVariables) so the Stylix fzf
  # target's colors merge into FZF_DEFAULT_OPTS (defaultOptions ++ "--color …")
  # rather than colliding with a manual home.sessionVariables.FZF_DEFAULT_OPTS.
  programs.fzf = {
    enable = true;
    defaultOptions = [ "--popup" ];
  };
  programs.jq.enable = true;
  programs.jqp.enable = true;
  programs.k9s.enable = true;
  programs.memory-sync.enable = config.home.opencode.memoryBackend == "cavemem";
  programs.opencode-cost-diagnosis.enable = true;
  programs.opencode-nono.enable = true;
  programs.opencode-nono-audit.enable = true;
  programs.opencode-rtk.enable = true;
  programs.subagent-context-budget.enable = true;
  programs.session-compaction.enable = true;
  programs.nix-index.enable = true;
  programs.nix-index-database.comma.enable = true;
  programs.nix-your-shell.enable = true;
  programs.pandoc.enable = true;
  programs.pay-respects.enable = true;
  programs.readline.enable = true;
  programs.ripgrep.enable = true;
  programs.tealdeer.enable = true;
  programs.zoxide.enable = true;

  xdg.configFile."opencode/plugins/zellij-attention.ts".source =
    ./opencode-plugins/zellij-attention.ts;
}
