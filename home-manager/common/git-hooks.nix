{
  pkgs,
  config,
  ...
}:
let
  hooksDir = "${config.xdg.configHome}/git/hooks";
  dispatcherSrc = ./git-hooks/dispatcher.sh;

  # All standard git hook stages
  allStages = [
    "applypatch-msg"
    "commit-msg"
    "post-applypatch"
    "post-checkout"
    "post-commit"
    "post-merge"
    "post-rewrite"
    "pre-applypatch"
    "pre-commit"
    "pre-merge-commit"
    "pre-push"
    "pre-rebase"
    "prepare-commit-msg"
  ];

  # Stages where prek hooks should run
  prekStages = [
    "commit-msg"
    "post-checkout"
    "post-commit"
    "post-merge"
    "post-rewrite"
    "pre-commit"
    "pre-merge-commit"
    "pre-push"
    "pre-rebase"
    "prepare-commit-msg"
  ];

  # Stages where git-lfs hooks should run
  lfsStages = [
    "post-checkout"
    "post-commit"
    "post-merge"
    "pre-push"
  ];

  # Generate a dispatcher script for a hook stage
  mkDispatcher =
    stage:
    pkgs.writeShellScript "git-hook-${stage}" ''
      . "$(dirname "$0")/_dispatcher.sh"
      _dispatch ${stage} "$@"
    '';

  # Generate a prek .d/ hook wrapper for a specific stage
  mkPrekHook =
    stage:
    pkgs.writeShellScript "prek-${stage}" ''
      _repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
      if [ -f "''${_repo_root}/.pre-commit-config.yaml" ]; then
        if command -v prek >/dev/null 2>&1; then
          exec prek run --hook-stage "${stage}" --config "''${_repo_root}/.pre-commit-config.yaml"
        fi
      fi
    '';

  # Generate an LFS .d/ hook wrapper for a specific stage
  mkLfsHook =
    stage:
    pkgs.writeShellScript "lfs-${stage}" ''
      command -v git-lfs >/dev/null 2>&1 || exit 0
      exec git lfs "${stage}" "$@"
    '';

  # Build xdg.configFile entries for dispatcher scripts
  dispatcherFiles = builtins.listToAttrs (
    map (stage: {
      name = "git/hooks/${stage}";
      value = {
        source = mkDispatcher stage;
        executable = true;
      };
    }) allStages
  );

  # Build xdg.configFile entries for prek .d/ hooks
  prekFiles = builtins.listToAttrs (
    map (stage: {
      name = "git/hooks/${stage}.d/01-prek";
      value = {
        source = mkPrekHook stage;
        executable = true;
      };
    }) prekStages
  );

  # Build xdg.configFile entries for LFS .d/ hooks
  lfsFiles = builtins.listToAttrs (
    map (stage: {
      name = "git/hooks/${stage}.d/01-lfs";
      value = {
        source = mkLfsHook stage;
        executable = true;
      };
    }) lfsStages
  );
in
{
  home.packages = with pkgs; [
    commitlint-rs
    prek
  ];

  programs.git.settings.core.hooksPath = hooksDir;

  xdg.configFile = {
    "git/hooks/_dispatcher.sh" = {
      source = dispatcherSrc;
    };

    # commitlint only runs on commit-msg stage
    "git/hooks/commit-msg.d/00-commitlint" = {
      source = ./git-hooks/hooks.d/commitlint;
      executable = true;
    };
  }
  // dispatcherFiles
  // prekFiles
  // lfsFiles;
}
