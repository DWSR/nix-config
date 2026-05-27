{
  writeShellApplication,
  coreutils,
  git,
}:

writeShellApplication {
  name = "git-clone-isolation";
  runtimeInputs = [
    coreutils
    git
  ];
  text = ''
        VERSION="0.1.0"

        fail() {
          printf '[git-clone-isolation: %s] %s\n' "$1" "$2" >&2
          exit 1
        }

        usage() {
          cat <<'USAGE'
    git-clone-isolation — create isolated Git clones from a local base-branch cache

    USAGE:
      git-clone-isolation refresh --repo <url> [--branch <name>] [--cache-root <path>]
      git-clone-isolation clone --repo <url> [--dest <path>] [--branch <name>] [--cache-root <path>] [--clone-root <path>]
      git-clone-isolation --help
      git-clone-isolation --version

    COMMANDS:
      refresh       Create or update the local bare cache for a repository.
      clone         Create an isolated working clone from the local cache.

    OPTIONS:
      --repo        Upstream repository URL.
      --branch      Base branch name. Defaults to the configured branch or main.
      --cache-root  Cache state root. Defaults to XDG state when implemented.
      --dest        Destination path for clone.
      --clone-root  Root directory for generated clone destinations.
      --help, -h    Print this help and exit 0.
      --version     Print the command version and exit 0.

    FAILURE CONTRACT:
      [git-clone-isolation: <label>] <detail>

      Labels currently emitted by the command skeleton:
        invalid_arguments
    USAGE
        }

        require_value() {
          local option="$1"
          local value="''${2:-}"
          if [[ -z "$value" || "$value" == --* ]]; then
            fail "invalid_arguments" "$option requires a value; see --help"
          fi
        }

        route_refresh() {
          local repo=""
          local branch="''${GIT_CLONE_ISOLATION_DEFAULT_BRANCH:-main}"
          local cache_root=""

          while [[ $# -gt 0 ]]; do
            case "$1" in
              --repo)
                require_value "$1" "''${2:-}"
                repo="$2"
                shift 2
                ;;
              --branch)
                require_value "$1" "''${2:-}"
                branch="$2"
                shift 2
                ;;
              --cache-root)
                require_value "$1" "''${2:-}"
                cache_root="$2"
                shift 2
                ;;
              --help|-h)
                usage
                exit 0
                ;;
              --*)
                fail "invalid_arguments" "unknown refresh option: $1 (try --help)"
                ;;
              *)
                fail "invalid_arguments" "unexpected refresh argument: $1 (try --help)"
                ;;
            esac
          done

          if [[ -z "$repo" ]]; then
            fail "invalid_arguments" "refresh requires --repo <url>; see --help"
          fi

          printf 'git-clone-isolation: refresh route accepted repo=%s branch=%s' "$repo" "$branch"
          if [[ -n "$cache_root" ]]; then
            printf ' cache-root=%s' "$cache_root"
          fi
          printf '\n'
        }

        route_clone() {
          local repo=""
          local dest=""
          local branch="''${GIT_CLONE_ISOLATION_DEFAULT_BRANCH:-main}"
          local cache_root=""
          local clone_root="''${GIT_CLONE_ISOLATION_CLONE_ROOT:-}"

          while [[ $# -gt 0 ]]; do
            case "$1" in
              --repo)
                require_value "$1" "''${2:-}"
                repo="$2"
                shift 2
                ;;
              --dest)
                require_value "$1" "''${2:-}"
                dest="$2"
                shift 2
                ;;
              --branch)
                require_value "$1" "''${2:-}"
                branch="$2"
                shift 2
                ;;
              --cache-root)
                require_value "$1" "''${2:-}"
                cache_root="$2"
                shift 2
                ;;
              --clone-root)
                require_value "$1" "''${2:-}"
                clone_root="$2"
                shift 2
                ;;
              --help|-h)
                usage
                exit 0
                ;;
              --*)
                fail "invalid_arguments" "unknown clone option: $1 (try --help)"
                ;;
              *)
                fail "invalid_arguments" "unexpected clone argument: $1 (try --help)"
                ;;
            esac
          done

          if [[ -z "$repo" ]]; then
            fail "invalid_arguments" "clone requires --repo <url>; see --help"
          fi

          printf 'git-clone-isolation: clone route accepted repo=%s branch=%s' "$repo" "$branch"
          if [[ -n "$dest" ]]; then
            printf ' dest=%s' "$dest"
          fi
          if [[ -n "$cache_root" ]]; then
            printf ' cache-root=%s' "$cache_root"
          fi
          if [[ -n "$clone_root" ]]; then
            printf ' clone-root=%s' "$clone_root"
          fi
          printf '\n'
        }

        case "''${1:-}" in
          --help|-h)
            usage
            exit 0
            ;;
          --version)
            printf 'git-clone-isolation %s\n' "$VERSION"
            exit 0
            ;;
          refresh)
            shift
            route_refresh "$@"
            ;;
          clone)
            shift
            route_clone "$@"
            ;;
          "")
            usage >&2
            fail "invalid_arguments" "subcommand required; see --help"
            ;;
          *)
            fail "invalid_arguments" "unknown subcommand: $1 (try --help)"
            ;;
        esac
  '';
}
