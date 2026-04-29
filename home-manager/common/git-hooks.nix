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

  # Generate a prek .d/ hook wrapper for a specific stage.
  # Some stages require extra args from git that prek expects via specific
  # CLI flags. Mapping (verified against prek 0.2.17):
  #   commit-msg / prepare-commit-msg → --commit-msg-filename "$1"
  #   pre-rebase                       → --pre-rebase-upstream "$1"
  #                                     [--pre-rebase-branch "$2"] (optional)
  # Other stages don't require extra flags; prek accepts the remaining
  # positional args via `[HOOK|PROJECT]...` (which we don't pass).
  mkPrekHook =
    stage:
    let
      needsCommitMsg = builtins.elem stage [
        "commit-msg"
        "prepare-commit-msg"
      ];
      needsPreRebase = stage == "pre-rebase";
      extraArgs =
        if needsCommitMsg then
          ''--commit-msg-filename "$1"''
        else if needsPreRebase then
          # When rebasing the current branch, git passes $1 (upstream) only;
          # $2 (branch) is unset/empty. ''${2:+...} expands to the branch
          # arg only when $2 is non-empty.
          ''--pre-rebase-upstream "$1" ''${2:+--pre-rebase-branch "$2"}''
        else
          "";
    in
    pkgs.writeShellScript "prek-${stage}" ''
      _repo_root="$(git rev-parse --show-toplevel 2>/dev/null)"
      if [ -f "''${_repo_root}/.pre-commit-config.yaml" ]; then
        if command -v prek >/dev/null 2>&1; then
          _output="$(prek run --hook-stage "${stage}" --config "''${_repo_root}/.pre-commit-config.yaml" ${extraArgs} 2>&1)"
          _rc=$?
          # Ignore "no hooks found" — not all stages have configured hooks
          if [ $_rc -ne 0 ]; then
            case "$_output" in
              *"No hooks found for stage"*) ;;
              *) echo "$_output" >&2; exit $_rc ;;
            esac
          fi
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
