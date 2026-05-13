{
  pkgs,
  lib,
  manifestPath,
}:
# sqlite-backup: operator-facing CLI for the SQLite backup pipeline.
#
# Single binary owning every public operator command (list, status,
# backup, restore, start, stop, verify-credentials) AND the launchd-
# triggered tier wrappers (__replicate-trigger, __archive-trigger).
# Subcommand dispatch is performed on `$1`; per-subcommand bodies are
# implemented in tasks 3.2 through 3.7. This task (3.1) provides:
#
#   * The dispatcher framework with case-on-`$1` covering all 9
#     subcommands plus `--help`.
#   * Shared helpers used by every subcommand: manifest reader (jq +
#     baked path), Keychain reader (absolute-path
#     /usr/bin/security ... -a mcp-hub), per-database mkdir lockfile,
#     log start/end timestamps, and the unknown-database error UX
#     mandated by R13.AC10 (any subcommand handed an unknown <db>
#     prints the configured database names on stderr).
#   * A working `--help` arm and `list` arm; every other public arm
#     is gated on the missing-DB-name pre-check and then announces
#     the implementing follow-up task on stderr.
#
# Manifest path is baked at derivation time via the `manifestPath`
# argument so the binary is self-contained: `home.sqliteBackup.
# _manifestPath` (rendered by `home-manager/common/sqlite-backup.nix`)
# is threaded through `home.packages = [ (import ./sqlite-backup-cli.nix
# { inherit pkgs lib; manifestPath = ...; }) ]` in task 4. Operators
# never need to discover or pass the path themselves.
#
pkgs.writeShellApplication {
  name = "sqlite-backup";
  runtimeInputs = with pkgs; [
    jq
    coreutils
    # `restic` is consumed by `status` (per-tier last-snapshot lookup
    # via `restic snapshots --tag <tier> --json`) and will additionally
    # be the workhorse for the tier-trigger and restore subcommands
    # implemented in tasks 3.5 / 3.6 / 3.7. Pinned to nixpkgs 25.11's
    # restic per design.md §"Architecture Pattern" (v0.18.1).
    restic
  ];
  text = ''
    # Manifest path baked at derivation time. The HM module renders the
    # JSON via `pkgs.writeText "sqlite-backup-manifest.json" ...` and
    # threads the resulting store path through this derivation's
    # `manifestPath` argument; the interpolation freezes that path into
    # the binary so the operator never has to discover it at run time
    # and so the binary is unaffected by environment. `lib.escapeShellArg`
    # defends against any future store-path that contains shell
    # metacharacters (Nix store paths in practice never do, but the
    # cost of being defensive here is one function call at build time).
    MANIFEST_PATH=${lib.escapeShellArg "${manifestPath}"}

    # Keychain account is a derived constant: every secret consumed by
    # the SQLite backup pipeline lives under the shared `mcp-hub`
    # account established by `mcp-sops-bridge` (design.md §"Boundary
    # Commitments", Mechanism A). Hard-coding it avoids threading a
    # second piece of configuration through the manifest.
    readonly KEYCHAIN_ACCOUNT=mcp-hub

    # Apple's `security` is not a Nix package; the absolute path is the
    # supported way to invoke it from a writeShellApplication's PATH-
    # locked environment (mirrors `scripts/mcp-secrets-activate.nix`).
    readonly SECURITY_BIN=/usr/bin/security

    # `launchctl` is a system binary at the documented `/bin/launchctl`
    # path on every supported macOS release; calling by absolute path
    # avoids any PATH-discovery surprise inside writeShellApplication's
    # locked environment. Used by `status` (R13.AC18) to probe whether
    # the per-DB Litestream agent is currently loaded.
    readonly LAUNCHCTL_BIN=/bin/launchctl

    # Halt-flag root per design.md §"State Management": one file per
    # database, content `replication-only` or `whole-pipeline`. Cleared
    # on every HM activation by the module's `home.activation.sqlite-
    # backup-clear-halts` hook (R13.AC15).
    readonly STATE_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup"

    readonly LOG_DIR="$HOME/Library/Logs"
    readonly LOCK_DIR_BASE="''${TMPDIR:-/var/tmp}"

    # Track the currently-held mkdir lock so the EXIT trap can clean up
    # even if the script is killed mid-run. release_lock clears the
    # variable AND the trap together so the trap never fires twice.
    LOCK_DIR=""

    # ----------------------------------------------------------------
    # Manifest helpers (jq-backed; baked-path-only)
    # ----------------------------------------------------------------

    # Print one configured database name per line, in declaration order.
    # Returns empty stdout (and exit 0) when `databases = [ ]` so the
    # `list` subcommand can pipe directly with no special-casing
    # (R13.AC17).
    get_database_names() {
      jq -r '.databases[].name' "$MANIFEST_PATH"
    }

    # Returns 0 if a database with the given name exists in the
    # manifest, 1 otherwise. Uses `jq -e` so the exit code reflects the
    # boolean directly rather than being stringly-typed.
    db_exists() {
      local name="$1"
      jq -e --arg name "$name" \
        '.databases | any(.name == $name)' \
        "$MANIFEST_PATH" >/dev/null
    }

    # get_database_field <db-name> <dotted-path>
    # Returns the value of a manifest field for a database, addressed
    # by a dotted JSON path (e.g. "path", "remotePath",
    # "replicationTier.cadenceSeconds"). Empty string when missing so
    # callers can `[ -z "$value" ]` without tripping `set -u`.
    # shellcheck disable=SC2329  # consumed by tasks 3.2-3.7
    get_database_field() {
      local name="$1" field_path="$2"
      jq -r --arg name "$name" --arg path "$field_path" '
        .databases[]
        | select(.name == $name)
        | getpath($path | split("."))
        // empty
      ' "$MANIFEST_PATH"
    }

    # get_secret_service <kind>
    # Returns the Keychain SERVICE name (the `-s` argument to
    # `security`) for one of the two secret kinds the pipeline
    # consumes. The matching account is always KEYCHAIN_ACCOUNT.
    # shellcheck disable=SC2329  # consumed by tasks 3.2, 3.3, 3.5
    get_secret_service() {
      local kind="$1"
      case "$kind" in
        archive)
          jq -r '.archivePassphraseSecret' "$MANIFEST_PATH"
          ;;
        rclone-config)
          jq -r '.rcloneConfigPassphraseSecret' "$MANIFEST_PATH"
          ;;
        *)
          echo "sqlite-backup: unknown secret kind: $kind" >&2
          return 1
          ;;
      esac
    }

    # shellcheck disable=SC2329  # consumed by tasks 3.3 and 3.5
    get_keychain_account() {
      printf '%s\n' "$KEYCHAIN_ACCOUNT"
    }

    # ----------------------------------------------------------------
    # Keychain reader
    # ----------------------------------------------------------------

    # read_keychain_secret <service>
    # Print the plaintext password to stdout, propagate `security`'s
    # exit code so callers can distinguish missing-entry from other
    # failures. Used both directly by `verify-credentials` and as the
    # implementation of `RESTIC_PASSWORD_COMMAND` /
    # `RCLONE_PASSWORD_COMMAND` in the tier-trigger flows.
    # shellcheck disable=SC2329  # consumed by tasks 3.2, 3.3, 3.5
    read_keychain_secret() {
      local service="$1"
      "$SECURITY_BIN" find-generic-password \
        -s "$service" -a "$KEYCHAIN_ACCOUNT" -w
    }

    # ----------------------------------------------------------------
    # Per-database mkdir lock
    # ----------------------------------------------------------------

    # acquire_lock <db>
    # Atomic mutex via mkdir on $LOCK_DIR_BASE/sqlite-backup-<db>.lock
    # (design.md §"State Management" → Locks; rationale documented in
    # research.md). Returns 0 on acquisition, 1 if the lock is already
    # held; callers treat the latter as "another wrapper is mid-run,
    # exit 0 with logged reason" per the tier-trigger contract.
    #
    # The trap captures LOCK_DIR by NAME (single-quoted); release_lock
    # clears both the variable AND the trap so the cleanup runs at
    # most once even on signal interruption.
    # shellcheck disable=SC2329  # consumed by task 3.5
    acquire_lock() {
      local db="$1"
      local target="$LOCK_DIR_BASE/sqlite-backup-$db.lock"
      if ! mkdir "$target" 2>/dev/null; then
        return 1
      fi
      LOCK_DIR="$target"
      trap 'rm -rf -- "$LOCK_DIR"' EXIT INT TERM
      return 0
    }

    # shellcheck disable=SC2329  # consumed by task 3.5
    release_lock() {
      if [ -n "$LOCK_DIR" ]; then
        rm -rf -- "$LOCK_DIR"
        LOCK_DIR=""
        trap - EXIT INT TERM
      fi
    }

    # ----------------------------------------------------------------
    # Logging helpers
    # ----------------------------------------------------------------

    # log_start <db> [<subcmd>]
    # log_end   <db> [<subcmd>] [<exit-code>]
    # Append a UTC timestamped marker to
    # $LOG_DIR/sqlite-backup-<db>-cli.log so an operator can correlate
    # CLI invocations with the per-role launchd logs (which use a
    # different filename convention,
    # `sqlite-backup-<db>-{litestream,replicate,archive}.log`).
    # shellcheck disable=SC2329  # consumed by tasks 3.4-3.7
    log_start() {
      local db="$1"
      local subcmd="''${2:-cli}"
      local log_file="$LOG_DIR/sqlite-backup-$db-cli.log"
      mkdir -p "$LOG_DIR"
      printf '[%s] sqlite-backup %s start\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$subcmd" \
        >>"$log_file"
    }

    # shellcheck disable=SC2329  # consumed by tasks 3.4-3.7
    log_end() {
      local db="$1"
      local subcmd="''${2:-cli}"
      local code="''${3:-0}"
      local log_file="$LOG_DIR/sqlite-backup-$db-cli.log"
      mkdir -p "$LOG_DIR"
      printf '[%s] sqlite-backup %s end exit=%s\n' \
        "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$subcmd" "$code" \
        >>"$log_file"
    }

    # ----------------------------------------------------------------
    # Common error UX
    # ----------------------------------------------------------------

    # die_unknown_db [<name>]
    # Single error UX for both R13.AC10 failure modes:
    #   * required <db> arg absent (called with empty/no name)
    #   * required <db> arg present but unknown (called with the name)
    # Always lists the configured database names on stderr so the
    # operator can re-invoke without consulting the HM module.
    die_unknown_db() {
      local supplied="''${1:-}"
      if [ -z "$supplied" ]; then
        echo "sqlite-backup: missing required <db> argument" >&2
      else
        echo "sqlite-backup: database '$supplied' not found in manifest" >&2
      fi
      local names
      names="$(get_database_names 2>/dev/null || true)"
      if [ -n "$names" ]; then
        echo "configured databases:" >&2
        while IFS= read -r db_name; do
          printf '  %s\n' "$db_name" >&2
        done <<<"$names"
      else
        echo "no databases configured in manifest" >&2
      fi
      exit 1
    }

    # require_db <name>
    # Pre-check used by subcommands that REQUIRE a <db> arg (backup,
    # restore, start, stop, __replicate-trigger, __archive-trigger).
    # Either passes silently or terminates via die_unknown_db.
    require_db() {
      local supplied="''${1:-}"
      if [ -z "$supplied" ]; then
        die_unknown_db ""
      fi
      if ! db_exists "$supplied"; then
        die_unknown_db "$supplied"
      fi
    }

    # optional_db_check <name>
    # Used by subcommands where <db> is optional (status,
    # verify-credentials). When supplied, the name must be valid;
    # when empty, this is a no-op.
    optional_db_check() {
      local supplied="''${1:-}"
      if [ -n "$supplied" ] && ! db_exists "$supplied"; then
        die_unknown_db "$supplied"
      fi
    }

    # ----------------------------------------------------------------
    # Status helpers (R13.AC18)
    # ----------------------------------------------------------------

    # get_halt_content <db>
    # Print the halt-flag file's contents (whitespace-stripped) when
    # the file exists; print nothing otherwise. Whitespace stripping
    # tolerates a trailing newline introduced by an operator who
    # writes the flag with `echo replication-only > halt-<db>.flag`.
    get_halt_content() {
      local db="$1"
      local flag="$STATE_DIR/halt-$db.flag"
      if [ -f "$flag" ]; then
        tr -d '[:space:]' <"$flag"
      fi
    }

    # get_replication_state <db>
    # Compute the operator-visible state per design.md §"CLI Script →
    # Service Interface" `status` block. The halt flag, when present,
    # is authoritative; only when no halt is set do we probe
    # `launchctl list <label>` to distinguish a healthy `running`
    # pipeline from a `not-running` one (which can occur briefly
    # during launchd reload, after a `launchctl bootout` outside the
    # CLI, or when the agent has crashed past `KeepAlive` retries).
    get_replication_state() {
      local db="$1"
      local halt
      halt="$(get_halt_content "$db")"
      case "$halt" in
        whole-pipeline)
          printf 'halted-whole-pipeline\n'
          return
          ;;
        replication-only)
          printf 'halted-replication-only\n'
          return
          ;;
      esac
      local label="dev.dwsr.sqlite-backup.litestream.$db"
      if "$LAUNCHCTL_BIN" list "$label" >/dev/null 2>&1; then
        printf 'running\n'
      else
        printf 'not-running\n'
      fi
    }

    # get_last_snapshot <db> <tag>
    # Print the timestamp of the most recent restic snapshot in the
    # per-DB local repo carrying the given tag (RFC3339 UTC, exactly
    # as restic emits it), or `never` when:
    #   * the local repo directory does not yet exist (first-run / not
    #     bootstrapped),
    #   * the manifest's archivePassphraseSecret is unset or its
    #     Keychain entry is missing,
    #   * `restic snapshots` returns non-zero for any reason, or
    #   * the result array is empty.
    # Per R13.AC18 + design.md §"Service Interface" the `status`
    # subcommand exits 0 always; this helper therefore swallows every
    # restic / Keychain error and falls back to `never`.
    get_last_snapshot() {
      local db="$1" tag="$2"
      local repo_dir
      repo_dir="$(get_database_field "$db" repoDir)"
      if [ -z "$repo_dir" ] || [ ! -d "$repo_dir" ]; then
        printf 'never\n'
        return
      fi
      local service
      service="$(get_secret_service archive 2>/dev/null || true)"
      if [ -z "$service" ] || [ "$service" = "null" ]; then
        printf 'never\n'
        return
      fi
      local pw
      if ! pw="$(read_keychain_secret "$service" 2>/dev/null)"; then
        printf 'never\n'
        return
      fi
      local out
      if ! out="$(RESTIC_PASSWORD="$pw" restic -r "$repo_dir" snapshots \
        --tag "$tag" --json 2>/dev/null)"; then
        printf 'never\n'
        return
      fi
      printf '%s\n' "$out" | jq -r '
        if (type == "array") and (length > 0)
        then (max_by(.time) | .time)
        else "never"
        end
      '
    }

    # print_db_status <db>
    # Emit the four-line block format for one database (the format
    # mandated by task 3.2 implementation guidance — operator-friendly
    # YAML-style key/value, distinct from a tabular layout, so that
    # extra fields can be added in future tasks without breaking
    # consumers that already grep `last-replication-snapshot:`).
    print_db_status() {
      local db="$1"
      local state last_rep last_arc
      state="$(get_replication_state "$db")"
      last_rep="$(get_last_snapshot "$db" replication)"
      last_arc="$(get_last_snapshot "$db" archive)"
      printf '%s:\n' "$db"
      printf '  replication-state: %s\n' "$state"
      printf '  last-replication-snapshot: %s\n' "$last_rep"
      printf '  last-archive-snapshot: %s\n' "$last_arc"
    }

    # ----------------------------------------------------------------
    # Help text
    # ----------------------------------------------------------------

    usage() {
      cat <<'USAGE'
    sqlite-backup - operator commands for the SQLite backup pipeline.

    Usage:
      sqlite-backup <subcommand> [args...]

    Public subcommands:
      list                            Print configured database names.
      status [<db>]                   Report pipeline state per database.
      backup <db>                     Run the archive-tier pipeline now.
      restore <db> [opts]             Restore a database from snapshots.
      start <db>                      Resume a halted database's pipeline.
      stop <db> [--include-archive]   Halt a database's pipeline.
      verify-credentials [<db>]       Probe rclone destinations.

    Run `sqlite-backup --help` to print this message.
    USAGE
    }

    # placeholder <subcommand-name> <implementing-task>
    # Bodies for subcommands implemented in subsequent tasks. Tasks 3.2
    # through 3.7 will replace each call with the real implementation.
    placeholder() {
      local subcmd="$1" implementing_task="$2"
      echo "sqlite-backup: '$subcmd' subcommand not yet implemented (task $implementing_task implements it)" >&2
      exit 1
    }

    # ----------------------------------------------------------------
    # Manifest sanity (fail fast on missing or malformed JSON)
    # ----------------------------------------------------------------

    if [ ! -f "$MANIFEST_PATH" ]; then
      echo "sqlite-backup: manifest not found at $MANIFEST_PATH" >&2
      exit 1
    fi
    if ! jq empty "$MANIFEST_PATH" >/dev/null 2>&1; then
      echo "sqlite-backup: manifest at $MANIFEST_PATH is not valid JSON" >&2
      exit 1
    fi

    # ----------------------------------------------------------------
    # Subcommand dispatch
    # ----------------------------------------------------------------

    SUBCMD="''${1:-}"
    if [ $# -gt 0 ]; then
      shift
    fi

    case "$SUBCMD" in
      --help | -h | help)
        usage
        exit 0
        ;;

      list)
        # R13.AC17: one DB name per line; exit 0 with empty stdout when
        # `databases = [ ]`. Implemented inline because it is a one-
        # liner over the manifest reader and has no other dependencies.
        get_database_names
        exit 0
        ;;

      status)
        # R13.AC18: with no <db> arg, iterate over every configured
        # database; with a <db> arg, scope to that one. The empty-
        # manifest case naturally produces no output (the while loop
        # body never executes) — no special-case needed.
        optional_db_check "''${1:-}"
        if [ -n "''${1:-}" ]; then
          print_db_status "$1"
        else
          while IFS= read -r db_name; do
            [ -z "$db_name" ] && continue
            print_db_status "$db_name"
          done < <(get_database_names)
        fi
        exit 0
        ;;

      verify-credentials)
        optional_db_check "''${1:-}"
        placeholder verify-credentials 3.3
        ;;

      backup)
        require_db "''${1:-}"
        placeholder backup 3.6
        ;;

      restore)
        require_db "''${1:-}"
        placeholder restore 3.7
        ;;

      start)
        require_db "''${1:-}"
        placeholder start 3.4
        ;;

      stop)
        require_db "''${1:-}"
        placeholder stop 3.4
        ;;

      __replicate-trigger)
        require_db "''${1:-}"
        placeholder __replicate-trigger 3.5
        ;;

      __archive-trigger)
        require_db "''${1:-}"
        placeholder __archive-trigger 3.5
        ;;

      "")
        echo "sqlite-backup: missing subcommand" >&2
        echo >&2
        usage >&2
        exit 1
        ;;

      *)
        echo "sqlite-backup: unknown subcommand: $SUBCMD" >&2
        echo >&2
        usage >&2
        exit 1
        ;;
    esac
  '';
}
