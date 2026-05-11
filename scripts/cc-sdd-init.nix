{ pkgs, cc-sdd-skills }:
# cc-sdd-init: per-project bootstrap for the Kiro template tree.
#
# Skills install globally via home-manager (see
# home-manager/common/cc-sdd.nix), so /kiro-* slash commands are always
# available. They reference templates living at
# <cwd>/.kiro/settings/templates/ when generating spec artifacts; this
# helper materialises that tree from the Nix-managed cc-sdd-skills
# derivation so the user never has to invoke the upstream cc-sdd CLI
# directly to bootstrap a project.
#
# Steering documents (.kiro/steering/*.md) are NOT bootstrapped here —
# they are created on-demand by /kiro-steering when the user is ready
# to capture project-wide conventions.
pkgs.writeShellApplication {
  name = "cc-sdd-init";
  runtimeInputs = with pkgs; [ coreutils ];
  text = ''
    FORCE=false
    for arg in "$@"; do
      case "$arg" in
        --force|-f) FORCE=true ;;
        --help|-h)
          cat <<'USAGE'
    cc-sdd-init: materialise .kiro/settings/ for spec-driven development.

    The kiro-* OpenCode skills are installed globally on this host and
    always available. This helper only materialises the project-local
    templates that those skills reference when generating spec
    artifacts (requirements.md, design.md, tasks.md, etc).

    Run once per project, then commit .kiro/ (or .gitignore it for solo
    work). Steering documents are NOT bootstrapped here; they are
    created on demand by /kiro-steering.

    Usage:
      cc-sdd-init [--force]

    Options:
      --force, -f    Overwrite an existing .kiro/settings/ tree
      --help, -h     Show this message
    USAGE
          exit 0
          ;;
        *)
          echo "cc-sdd-init: unknown option: $arg" >&2
          echo "run cc-sdd-init --help for usage" >&2
          exit 2
          ;;
      esac
    done

    if [ ! -d ".git" ] && [ ! -f "flake.nix" ] && [ ! -f "package.json" ]; then
      echo "cc-sdd-init: warning: cwd does not look like a project root" >&2
      echo "  (no .git, flake.nix, or package.json found)" >&2
    fi

    DEST=".kiro/settings"

    if [ -e "$DEST" ] && [ "$FORCE" != true ]; then
      echo "cc-sdd-init: error: $DEST already exists" >&2
      echo "  pass --force to overwrite, or remove the directory first" >&2
      exit 1
    fi

    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"

    # cp -RL dereferences symlinks so the project gets a real,
    # editable copy of the templates rather than a Nix-store-bound
    # symlink. chmod ensures the user can edit the result without
    # fighting Nix store immutability.
    cp -RL ${cc-sdd-skills}/kiro-settings "$DEST"
    chmod -R u+w "$DEST"

    echo "cc-sdd-init: materialised $DEST from cc-sdd v${cc-sdd-skills.version}"
    echo
    echo "Next steps:"
    echo "  1. Restart any running OpenCode session (skills are cached)"
    echo "  2. Run /kiro-discovery <idea> to scope the work, or"
    echo "     /kiro-spec-init <feature> to start a single spec"
    echo "  3. Run /kiro-steering when you are ready to capture"
    echo "     project-wide steering documents"
  '';
}
