{
  writeShellApplication,
  coreutils,
  git,
}:

writeShellApplication {
  name = "git-cache-clone";
  runtimeInputs = [
    coreutils
    git
  ];
  text = ''
        VERSION="0.1.0"

        fail() {
          printf '[git-cache-clone: %s] %s\n' "$1" "$2" >&2
          exit 1
        }

        usage() {
          cat <<'USAGE'
    git cache-clone — create isolated Git clones from a local base-branch cache

    USAGE:
      git cache-clone refresh --repo <url> [--branch <name>] [--cache-root <path>]
      git cache-clone clone --repo <url> [--dest <path>] [--branch <name>] [--cache-root <path>] [--clone-root <path>]
      git cache-clone --help
      git cache-clone --version

    COMMANDS:
      refresh       Create or update the local bare cache for a repository.
      clone         Create an isolated working clone from the local cache.

    OPTIONS:
      --repo        Upstream repository URL.
      --branch      Base branch name. Defaults to the configured branch or main.
      --cache-root  Cache state root. Defaults to XDG state.
      --dest        Destination path for clone.
      --clone-root  Root directory for generated clone destinations.
      --help, -h    Print this help and exit 0.
      --version     Print the command version and exit 0.

    FAILURE CONTRACT:
      [git-cache-clone: <label>] <detail>

      Labels currently emitted by the command:
        invalid_arguments
        cache_fetch_failed
        cache_lock_failed
        unsafe_destination
        clone_failed
        remote_rewrite_failed
        checkout_failed
        isolation_check_failed
    USAGE
        }

        require_value() {
          local option="$1"
          local value="''${2:-}"
          if [[ -z "$value" || "$value" == --* ]]; then
            fail "invalid_arguments" "$option requires a value; see --help"
          fi
        }

        default_cache_root() {
          if [[ -n "''${GIT_CLONE_ISOLATION_CACHE_ROOT:-}" ]]; then
            printf '%s\n' "$GIT_CLONE_ISOLATION_CACHE_ROOT"
            return
          fi

          printf '%s/git-clone-isolation\n' "''${XDG_STATE_HOME:-$HOME/.local/state}"
        }

        default_clone_root() {
          if [[ -n "''${GIT_CLONE_ISOLATION_CLONE_ROOT:-}" ]]; then
            printf '%s\n' "$GIT_CLONE_ISOLATION_CLONE_ROOT"
            return
          fi

          printf '%s/scratch\n' "$HOME"
        }

        repo_slug() {
          local repo="$1"
          local name="''${repo%/}"
          name="''${name##*/}"
          name="''${name%.git}"

          if [[ -z "$name" ]]; then
            name="repository"
          fi

          printf '%s' "$name" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]._-' '-'
        }

        cache_identity() {
          local repo="$1"
          local cache_root="$3"
          local relative_path

          relative_path="$(cache_relative_path "$repo")"
          printf '%s/%s\n' "$cache_root" "$relative_path"
        }

        cache_relative_path() {
          local repo="$1"
          local normalized="$repo"

          case "$normalized" in
            http://*|https://*)
              normalized="''${normalized#*://}"
              ;;
            ssh://*)
              normalized="''${normalized#ssh://}"
              normalized="''${normalized#*@}"
              ;;
            *@*:*)
              normalized="''${normalized#*@}"
              normalized="''${normalized/:/\/}"
              ;;
            file://*)
              normalized="local/''${normalized#file://}"
              ;;
            /*)
              normalized="local/$normalized"
              ;;
          esac

          normalized="''${normalized%%\?*}"
          normalized="''${normalized%%#*}"
          normalized="''${normalized%/}"
          normalized="''${normalized%.git}"
          normalized="$(printf '%s' "$normalized" | tr -cs '[:alnum:]._/-' '-')"
          normalized="''${normalized#/}"
          normalized="''${normalized//../-}"
          while [[ "$normalized" == *"//"* ]]; do
            normalized="''${normalized//\/\//\/}"
          done

          if [[ -z "$normalized" ]]; then
            normalized="repository"
          fi

          printf '%s\n' "$normalized"
        }

        refresh_cache() {
          local repo="$1"
          local branch="$2"
          local cache_root="$3"
          local cache_path="$4"
          local lock_dir="$cache_path.lock"
          local temp_dir=""
          local temp_cache=""
          local backup_path=""
          local lock_acquired=0
          local cache_parent=""

          cache_parent="$(dirname "$cache_path")"
          mkdir -p "$cache_parent" || fail "cache_fetch_failed" "failed to create cache parent: $cache_parent"

          if ! mkdir "$lock_dir" 2>/dev/null; then
            fail "cache_lock_failed" "cache lock already held for $cache_path: $lock_dir"
          fi
          lock_acquired=1
          trap 'if [[ "''${lock_acquired:-0}" == 1 ]]; then rmdir "$lock_dir" >/dev/null 2>&1 || true; fi' EXIT INT TERM

          temp_dir="$(mktemp -d "$cache_parent/.refresh.XXXXXXXX")" || fail "cache_fetch_failed" "failed to create temporary cache under $cache_parent"
          temp_cache="$temp_dir/cache.git"

          if ! git init --bare "$temp_cache" >/dev/null 2>&1; then
            rm -rf "$temp_dir"
            fail "cache_fetch_failed" "failed to initialize temporary bare cache for $repo"
          fi

          if ! git --git-dir="$temp_cache" remote add origin "$repo" >/dev/null 2>&1; then
            rm -rf "$temp_dir"
            fail "cache_fetch_failed" "failed to configure origin for $repo"
          fi

          if ! git --git-dir="$temp_cache" fetch --no-tags origin "+refs/heads/$branch:refs/heads/$branch" >/dev/null 2>&1; then
            rm -rf "$temp_dir"
            fail "cache_fetch_failed" "failed to fetch branch '$branch' from $repo; existing cache preserved at $cache_path"
          fi

          if ! git --git-dir="$temp_cache" symbolic-ref HEAD "refs/heads/$branch" >/dev/null 2>&1; then
            rm -rf "$temp_dir"
            fail "cache_fetch_failed" "failed to set cache HEAD to branch '$branch'; existing cache preserved at $cache_path"
          fi

          if [[ -e "$cache_path" ]]; then
            backup_path="$cache_path.previous.$$"
            if ! mv "$cache_path" "$backup_path"; then
              rm -rf "$temp_dir"
              fail "cache_fetch_failed" "failed to preserve existing cache before refresh: $cache_path"
            fi
          fi

          if ! mv "$temp_cache" "$cache_path"; then
            if [[ -n "$backup_path" && -e "$backup_path" ]]; then
              mv "$backup_path" "$cache_path" >/dev/null 2>&1 || true
            fi
            rm -rf "$temp_dir"
            fail "cache_fetch_failed" "failed to install refreshed cache; existing cache preserved at $cache_path"
          fi

          rm -rf "$temp_dir"
          if [[ -n "$backup_path" && -e "$backup_path" ]]; then
            rm -rf "$backup_path"
          fi

          lock_acquired=0
          if ! rmdir "$lock_dir"; then
            fail "cache_lock_failed" "failed to release cache lock for $cache_path: $lock_dir"
          fi
          trap - EXIT INT TERM
        }

        ensure_safe_destination() {
          local dest="$1"
          local cache_root="$2"

          if [[ -z "$dest" || "$dest" == "/" ]]; then
            fail "unsafe_destination" "destination is unsafe: $dest"
          fi

          case "$dest" in
            "$cache_root"|"$cache_root"/*)
              fail "unsafe_destination" "destination must not be inside cache root: dest=$dest cache-root=$cache_root"
              ;;
          esac

          if [[ -L "$dest" ]]; then
            fail "unsafe_destination" "destination must not be a symlink: $dest"
          fi

          if [[ -e "$dest" && ! -d "$dest" ]]; then
            fail "unsafe_destination" "destination exists and is not a directory: $dest"
          fi

          if [[ -d "$dest" && -n "$(ls -A "$dest")" ]]; then
            fail "unsafe_destination" "destination is not empty: $dest"
          fi
        }

        create_isolated_clone() {
          local repo="$1"
          local branch="$2"
          local cache_root="$3"
          local cache_path="$4"
          local dest="$5"
          local dest_parent=""

          ensure_safe_destination "$dest" "$cache_root"

          dest_parent="$(dirname "$dest")"
          if ! mkdir -p "$dest_parent"; then
            fail "clone_failed" "step=prepare_destination dest=$dest failed to create parent directory: $dest_parent"
          fi

          if ! git clone --no-local --single-branch --branch "$branch" --reference-if-able "$cache_path" --dissociate "$cache_path" "$dest" >/dev/null 2>&1; then
            fail "clone_failed" "step=clone_from_cache dest=$dest cache=$cache_path branch=$branch"
          fi

          if [[ ! -d "$dest/.git" ]]; then
            fail "isolation_check_failed" "step=verify_git_dir dest=$dest expected independent .git directory"
          fi

          if [[ -e "$dest/.git/objects/info/alternates" ]]; then
            fail "isolation_check_failed" "step=verify_no_alternates dest=$dest alternates=$dest/.git/objects/info/alternates"
          fi

          if ! git -C "$dest" remote set-url origin "$repo" >/dev/null 2>&1; then
            fail "remote_rewrite_failed" "step=remote_set_url dest=$dest origin=$repo"
          fi

          if ! git -C "$dest" checkout "$branch" >/dev/null 2>&1; then
            fail "checkout_failed" "step=checkout dest=$dest branch=$branch"
          fi
        }

        route_refresh() {
          local repo=""
          local branch="''${GIT_CLONE_ISOLATION_DEFAULT_BRANCH:-main}"
          local cache_root
          local cache_path=""

          cache_root="$(default_cache_root)"

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

          cache_path="$(cache_identity "$repo" "$branch" "$cache_root")"
          refresh_cache "$repo" "$branch" "$cache_root" "$cache_path"
          printf 'git-cache-clone: refreshed cache repo=%s branch=%s cache-root=%s cache-path=%s\n' \
            "$repo" "$branch" "$cache_root" "$cache_path"
        }

        route_clone() {
          local repo=""
          local dest=""
          local branch="''${GIT_CLONE_ISOLATION_DEFAULT_BRANCH:-main}"
          local cache_root
          local clone_root
          local cache_path=""
          local slug=""

          cache_root="$(default_cache_root)"
          clone_root="$(default_clone_root)"

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

          slug="$(repo_slug "$repo")"
          if [[ -z "$dest" ]]; then
            dest="$clone_root/$slug"
          fi
          cache_path="$(cache_identity "$repo" "$branch" "$cache_root")"
          create_isolated_clone "$repo" "$branch" "$cache_root" "$cache_path" "$dest"

          printf 'git-cache-clone: cloned repo=%s branch=%s dest=%s cache-root=%s clone-root=%s cache-path=%s\n' \
            "$repo" "$branch" "$dest" "$cache_root" "$clone_root" "$cache_path"
        }

        case "''${1:-}" in
          --help|-h)
            usage
            exit 0
            ;;
          --version)
            printf 'git-cache-clone %s\n' "$VERSION"
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
