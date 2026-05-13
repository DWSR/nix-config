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
    # `rclone` is consumed by `verify-credentials` (read-only access
    # check via `rclone lsd <remote>:<remotePath>/<db>` and pre-flight
    # `rclone config encryption check`) and by the tier-trigger flows
    # implemented in task 3.5 (as the `rclone:` backend for `restic`).
    # Pinned to nixpkgs 25.11's rclone per design.md §"Architecture
    # Pattern" (v1.72.1) and the minimum-version assertion in
    # `home-manager/common/sqlite-backup.nix`.
    rclone
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
    get_database_field() {
      local name="$1" field_path="$2"
      jq -r --arg name "$name" --arg path "$field_path" '
        .databases[]
        | select(.name == $name)
        | getpath($path | split("."))
        // empty
      ' "$MANIFEST_PATH"
    }

    # get_retention_args <db-name> <tier-field>
    # tier-field is the manifest object key for the tier
    # ("replicationTier" or "archiveTier"). Prints one retention
    # argument per line so callers can read the variable-length list
    # into a bash array via while-read; the manifest stores retention
    # as a JSON array of strings (e.g. ["--keep-hourly","24"]) per
    # design.md §"Components and Interfaces" manifest shape. Empty
    # stdout (and exit 0) when the tier or its retention array is
    # missing — callers treat empty as "no retention args supplied",
    # which is a valid restic invocation (no snapshots are forgotten).
    get_retention_args() {
      local name="$1" tier_field="$2"
      jq -r --arg name "$name" --arg tier "$tier_field" '
        .databases[]
        | select(.name == $name)
        | .[$tier].retention[]?
      ' "$MANIFEST_PATH"
    }

    # get_secret_service <kind>
    # Returns the Keychain SERVICE name (the `-s` argument to
    # `security`) for one of the two secret kinds the pipeline
    # consumes. The matching account is always KEYCHAIN_ACCOUNT.
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
    # Litestream agent identity (consumed by start/stop and status)
    # ----------------------------------------------------------------

    # litestream_label <db>
    # The launchd label of the per-DB Litestream daemon, mirroring the
    # `Label` rendered by the HM module's `mkAgent db "litestream"` in
    # `home-manager/common/sqlite-backup.nix`. Centralised so a future
    # rename only has to be made in one place.
    litestream_label() {
      printf 'dev.dwsr.sqlite-backup.litestream.%s' "$1"
    }

    # litestream_plist_path <db>
    # Absolute path to the per-DB Litestream agent's launchd plist as
    # rendered by HM. nix-darwin / HM `launchd.agents.<name>` always
    # writes to `''${HOME}/Library/LaunchAgents/<label>.plist`; relying
    # on that convention here keeps the CLI self-contained (no need to
    # thread a second baked path through the manifest).
    litestream_plist_path() {
      printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(litestream_label "$1")"
    }

    # ----------------------------------------------------------------
    # Tier-trigger flow (shared by __replicate-trigger / __archive-trigger)
    # ----------------------------------------------------------------

    # tier_trigger <tier> <db> [<bypass_halt>]
    # tier is "replication" or "archive"; db is a manifest-validated
    # database name. bypass_halt is an optional boolean (default
    # "false"); when "true" the step 1 halt-flag early-exit is
    # bypassed (R13.19: operator-invoked `backup` overrides halt
    # without modifying it). Implements the 10-step batch contract
    # from design.md §"CLI Script → Batch / Job Contract" verbatim:
    #
    #   1. Halt-flag check (tier-aware skip semantics; bypassed for
    #      operator-invoked one-shots when bypass_halt="true", in
    #      which case the flag is read for a logged operator-visible
    #      "proceeding despite halt" line but never modified).
    #   2. Per-DB mkdir mutex (early-exit 0 if held).
    #   3. Export Keychain-backed RESTIC_PASSWORD_COMMAND,
    #      RCLONE_PASSWORD_COMMAND, and RESTIC_FROM_PASSWORD_COMMAND
    #      (the latter is what `restic copy` and
    #      `restic init --copy-chunker-params --from-repo` consult
    #      for the `--from-repo` end of cross-repo operations; both
    #      ends share the archive passphrase per design.md
    #      §"Implementation Notes").
    #   4. Idempotent local repo init.
    #   5. Idempotent remote repo init with `--copy-chunker-params`
    #      so cross-repo deduplication is preserved (R16.AC1, R16.AC5).
    #   6. `restic backup --tag <tier> --exclude='*.tmp' <stagingDir>`
    #      — the `*.tmp` exclude is mandatory (R3.AC5): Litestream
    #      uses atomic-rename `.tmp` intermediates during LTX rotation
    #      and capturing them yields an unrestorable snapshot.
    #   7. `restic copy` propagates new snapshots to the remote.
    #   8. `restic forget --tag <tier> <retention> --prune` against
    #      the LOCAL repo.
    #   9. Same `forget --prune` against the REMOTE repo to mirror
    #      retention deletions off-host (R16.AC5: the off-host repo
    #      must remain a complete and consistent copy of the on-host
    #      repo INCLUDING propagated retention deletes).
    #   10. Release lock; on any step failure, log cause to stderr
    #       (which launchd captures to the per-agent error log) and
    #       return non-zero so the dispatcher exits non-zero.
    #
    # The function uses the `if ! cmd; then ... return 1; fi` pattern
    # for every restic invocation so a custom error message is logged
    # before exit. The EXIT trap installed by acquire_lock is the
    # safety net that releases the mkdir lock on early-return paths;
    # the explicit release_lock at the success-path tail clears both
    # the lock and the trap so the script exits cleanly.
    tier_trigger() {
      local tier="$1" db="$2"
      local bypass_halt="''${3:-false}"
      local tier_field
      case "$tier" in
        replication) tier_field=replicationTier ;;
        archive) tier_field=archiveTier ;;
        *)
          echo "sqlite-backup: tier_trigger: invalid tier: $tier" >&2
          return 1
          ;;
      esac
      local subcmd="$tier-trigger"

      log_start "$db" "$subcmd"

      # Step 1: tier-specific halt-flag semantics.
      #   * `whole-pipeline`     → skip both replication and archive.
      #   * `replication-only`   → skip replication only; archive runs.
      # Skipping is exit 0 with a logged reason so launchd does not
      # spuriously page on "failed" runs that were intentionally
      # halted by the operator.
      #
      # When bypass_halt="true" (operator-invoked `backup` subcommand,
      # R13.19), the halt flag is read for an operator-visible log
      # line but never causes early exit; the flag itself is never
      # modified, written, or removed by this codepath, so a
      # previously-set halt state is preserved across the on-demand
      # run.
      local halt
      halt="$(get_halt_content "$db")"
      if [ "$bypass_halt" = "true" ]; then
        if [ -n "$halt" ]; then
          printf 'sqlite-backup: %s: %s proceeding despite %s halt (operator override)\n' \
            "$db" "$subcmd" "$halt"
        fi
      else
        case "$tier:$halt" in
          *:whole-pipeline)
            printf 'sqlite-backup: %s: %s skipped (whole-pipeline halt)\n' \
              "$db" "$subcmd"
            log_end "$db" "$subcmd" 0
            return 0
            ;;
          replication:replication-only)
            printf 'sqlite-backup: %s: %s skipped (replication-only halt)\n' \
              "$db" "$subcmd"
            log_end "$db" "$subcmd" 0
            return 0
            ;;
        esac
      fi

      # Step 2: per-DB mkdir mutex. Held iff another wrapper for the
      # same DB is mid-run; treat as a no-op skip (exit 0 with logged
      # reason) per the tier-trigger contract.
      if ! acquire_lock "$db"; then
        printf 'sqlite-backup: %s: %s skipped (lock held by another run)\n' \
          "$db" "$subcmd"
        log_end "$db" "$subcmd" 0
        return 0
      fi

      # Step 3: build and export the Keychain-backed password command
      # strings. restic and rclone both fork+exec these strings via
      # their own shell to obtain the relevant passphrase on demand,
      # so the plaintext never lives in our process memory and never
      # appears in argv. Both ends of every cross-repo restic
      # operation use the same archive passphrase (Risks bullet #2 in
      # design.md §"Implementation Notes"), so RESTIC_FROM_PASSWORD_COMMAND
      # is always equal to RESTIC_PASSWORD_COMMAND.
      local archive_secret rclone_secret
      archive_secret="$(get_secret_service archive)"
      rclone_secret="$(get_secret_service rclone-config)"
      if [ -z "$archive_secret" ] || [ "$archive_secret" = "null" ]; then
        echo "sqlite-backup: $db: $subcmd: missing archivePassphraseSecret in manifest" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi
      if [ -z "$rclone_secret" ] || [ "$rclone_secret" = "null" ]; then
        echo "sqlite-backup: $db: $subcmd: missing rcloneConfigPassphraseSecret in manifest" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi

      # KEYCHAIN_ACCOUNT and the secret service names are
      # Nix-rendered identifiers from the HM module surface (by
      # convention `[a-z0-9-]+`), so no shell metacharacters require
      # quoting in the command string. The exported value is parsed
      # by restic's / rclone's own shell when each tool needs the
      # passphrase, so the value MUST be a properly word-quoted
      # shell command — the simple concatenation here is intentional.
      RESTIC_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $archive_secret -a $KEYCHAIN_ACCOUNT -w"
      RCLONE_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $rclone_secret -a $KEYCHAIN_ACCOUNT -w"
      RESTIC_FROM_PASSWORD_COMMAND="$RESTIC_PASSWORD_COMMAND"
      export RESTIC_PASSWORD_COMMAND RCLONE_PASSWORD_COMMAND RESTIC_FROM_PASSWORD_COMMAND

      # Per-DB manifest lookups for repo paths and remote target.
      # Validated up-front so an operator-misconfigured manifest
      # surfaces as a single clear error rather than a series of
      # confusing restic / rclone failures down-stream.
      local repo_dir staging_dir remote remote_path
      repo_dir="$(get_database_field "$db" repoDir)"
      staging_dir="$(get_database_field "$db" stagingDir)"
      remote="$(get_database_field "$db" remote)"
      remote_path="$(get_database_field "$db" remotePath)"
      if [ -z "$repo_dir" ] || [ -z "$staging_dir" ] || [ -z "$remote" ] || [ -z "$remote_path" ]; then
        echo "sqlite-backup: $db: $subcmd: manifest missing repoDir/stagingDir/remote/remotePath" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi
      local remote_repo="rclone:$remote:$remote_path/$db"

      # Read the per-tier retention args (variable-length JSON array
      # of strings) into a bash array. Empty array → no `--keep-*`
      # flags are passed to `restic forget`, which restic interprets
      # as "no snapshots match the retention policy, so do not delete
      # anything"; safe vacuous behaviour.
      local -a retention_args=()
      local arg
      while IFS= read -r arg; do
        [ -z "$arg" ] && continue
        retention_args+=("$arg")
      done < <(get_retention_args "$db" "$tier_field")

      # Step 4: idempotent local repo init. `mkdir -p` so first-run
      # hosts where the manifest declares a repo path under a
      # not-yet-created parent directory don't fail at the snapshots
      # probe before init has a chance to run.
      mkdir -p "$repo_dir"
      if ! restic -r "$repo_dir" snapshots >/dev/null 2>&1; then
        if ! restic -r "$repo_dir" init; then
          echo "sqlite-backup: $db: $subcmd: local restic init failed" >&2
          log_end "$db" "$subcmd" 1
          return 1
        fi
      fi

      # Step 5: idempotent remote repo init. `--copy-chunker-params`
      # makes the new remote repo share the local repo's chunker
      # polynomial so blob deduplication carries across the two repos
      # (without it, `restic copy` would re-chunk every blob and
      # bloat the remote). The `--from-repo` end is authenticated by
      # RESTIC_FROM_PASSWORD_COMMAND exported above.
      if ! restic -r "$remote_repo" snapshots >/dev/null 2>&1; then
        if ! restic init --copy-chunker-params --from-repo "$repo_dir" --repo "$remote_repo"; then
          echo "sqlite-backup: $db: $subcmd: remote restic init failed" >&2
          log_end "$db" "$subcmd" 1
          return 1
        fi
      fi

      # Step 6: capture the snapshot. The `--exclude='*.tmp'` is
      # required by R3.AC5 — Litestream uses atomic-rename `.tmp`
      # intermediates during LTX rotation, so a backup that fires
      # mid-rotation would otherwise capture in-flight files and
      # produce an unrestorable snapshot.
      local hostname_short
      hostname_short="$(hostname -s)"
      if ! restic -r "$repo_dir" backup \
        --tag "$tier" \
        --host "$hostname_short" \
        --exclude='*.tmp' \
        "$staging_dir"; then
        echo "sqlite-backup: $db: $subcmd: restic backup failed" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi

      # Step 7: propagate new snapshots local→remote. Idempotent —
      # `restic copy` skips snapshots already present on the
      # destination, so a re-run after a partial failure is safe.
      if ! restic copy --from-repo "$repo_dir" --repo "$remote_repo"; then
        echo "sqlite-backup: $db: $subcmd: restic copy local->remote failed" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi

      # Step 8: apply the tier's retention to the LOCAL repo and
      # prune unreferenced data immediately. The `--tag <tier>`
      # filter ensures replication-tier prune does not touch
      # archive-tier snapshots and vice versa, so the two tiers'
      # independent retention policies coexist in one repo (R16.AC1).
      if ! restic -r "$repo_dir" forget --tag "$tier" "''${retention_args[@]}" --prune; then
        echo "sqlite-backup: $db: $subcmd: local restic forget+prune failed" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi

      # Step 9: apply the same retention to the REMOTE repo. R16.AC5
      # requires the off-host repo to be a complete and consistent
      # copy of the on-host repo INCLUDING propagated retention
      # deletes; without this step, recovery from off-host alone
      # would yield extra snapshots the operator believed had been
      # pruned. Adds one network round-trip per cycle (Risks bullet
      # in design.md), accepted as the cost of mirror equivalence.
      if ! restic -r "$remote_repo" forget --tag "$tier" "''${retention_args[@]}" --prune; then
        echo "sqlite-backup: $db: $subcmd: remote restic forget+prune failed" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi

      # Step 10: explicit lock release on the success path so the
      # EXIT trap is cleared and the script exits cleanly. Failure
      # paths above intentionally leave the trap armed so that an
      # unexpected errexit between an `if !` block and its
      # `return 1` still tears the lock down on script exit.
      release_lock
      log_end "$db" "$subcmd" 0
      return 0
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
        # R13.20-13.24: read-only credential probe.
        #
        # Two-phase contract per design.md §"CLI Script → Service
        # Interface" `verify-credentials` block:
        #
        # 1. Pre-flight `rclone config encryption check`. On non-zero
        #    exit (decryption failure, plaintext config, missing
        #    config, etc.), report a SINGLE global error to stderr
        #    distinguishing config-level failure from per-destination
        #    credential failure (R13.24) and exit non-zero WITHOUT
        #    attempting any per-destination work. The matching
        #    confirm step in tasks.md exercises exactly this path.
        #
        # 2. Per-database `rclone lsd <remote>:<remotePath>/<db>`.
        #    Iterates every configured database (no arg) or just the
        #    one named (with arg, validated by optional_db_check
        #    above). The `lsd` operation is read-only — no repository
        #    writes, no halt-flag mutation, no restic invocation, no
        #    launchctl interaction (R13.22). The path is per-DB-
        #    suffixed (`<remotePath>/<db>`) so the iteration is
        #    naturally per-database even when multiple databases
        #    share an underlying rclone destination remote.
        #
        # Aggregate exit code is non-zero iff any destination failed
        # (R13.23). Per-destination outcome lines (`<target>: OK` or
        # `<target>: FAIL: <cause>`) go to stdout so they remain
        # ordered relative to one another; the global pre-flight
        # error goes to stderr so scripted callers can distinguish
        # global from per-destination failure by stream.
        optional_db_check "''${1:-}"
        scope_db="''${1:-}"

        rclone_secret_service="$(get_secret_service rclone-config)"
        if [ -z "$rclone_secret_service" ] || [ "$rclone_secret_service" = "null" ]; then
          echo "sqlite-backup: manifest does not declare rcloneConfigPassphraseSecret" >&2
          exit 1
        fi

        # `rclone` exec's RCLONE_PASSWORD_COMMAND through its own
        # shell to obtain the config-decryption passphrase. Both
        # KEYCHAIN_ACCOUNT (a script constant) and the secret
        # service name (a Nix-rendered identifier from the HM module
        # surface, by convention `[a-z0-9-]+`) are free of shell
        # metacharacters, so the unquoted concatenation is intentional.
        RCLONE_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $rclone_secret_service -a $KEYCHAIN_ACCOUNT -w"
        export RCLONE_PASSWORD_COMMAND

        if ! preflight_out="$(rclone config encryption check 2>&1)"; then
          echo "sqlite-backup: rclone config decryption failed: $preflight_out" >&2
          exit 1
        fi

        any_failed=0
        if [ -n "$scope_db" ]; then
          db_list="$scope_db"
        else
          db_list="$(get_database_names)"
        fi

        # Per-DB iteration. The empty-`db_list` case (no databases
        # configured AND no arg supplied) yields zero iterations and
        # exits 0, matching the vacuous-truth interpretation of
        # R13.23 ("if all verifications succeed").
        while IFS= read -r db_name; do
          [ -z "$db_name" ] && continue
          remote="$(get_database_field "$db_name" remote)"
          remote_path="$(get_database_field "$db_name" remotePath)"
          if [ -z "$remote" ] || [ -z "$remote_path" ]; then
            printf '%s: FAIL: missing remote/remotePath in manifest\n' "$db_name"
            any_failed=1
            continue
          fi
          target="$remote:$remote_path/$db_name"
          if lsd_out="$(rclone lsd "$target" 2>&1)"; then
            printf '%s: OK\n' "$target"
          else
            printf '%s: FAIL: %s\n' "$target" "$lsd_out"
            any_failed=1
          fi
        done <<<"$db_list"

        if [ "$any_failed" -ne 0 ]; then
          exit 1
        fi
        exit 0
        ;;

      backup)
        # R13.3, R13.4, R13.5, R13.19: on-demand operator backup.
        # Invokes the same archive-tier flow as __archive-trigger (so
        # the on-demand run shares the scheduled flow's snapshot
        # capture, retention, off-host shipment, mkdir mutex, and
        # error-propagation semantics — R13.3, R13.4, R13.5) but
        # passes bypass_halt="true" to tier_trigger so step 1's
        # halt-flag check is bypassed (R13.19: explicit operator
        # override). The halt flag itself is never written,
        # modified, or removed by this arm or by tier_trigger when
        # bypass_halt="true"; halt state is preserved across the
        # on-demand run. The trailing `exit 0` is reached only when
        # tier_trigger returns 0 — under `set -e` (writeShellApplication
        # default), a non-zero return from tier_trigger aborts the
        # script and propagates that exit code, so any pipeline-step
        # failure is faithfully reported to the operator's terminal
        # with the cause printed to stderr by tier_trigger itself.
        require_db "''${1:-}"
        tier_trigger archive "$1" true
        exit 0
        ;;

      restore)
        require_db "''${1:-}"
        placeholder restore 3.7
        ;;

      start)
        # R13.12, R13.16: clear halt flag and re-bootstrap the per-DB
        # Litestream agent. Idempotent — when no halt flag is present
        # we report "already running" and skip the bootstrap (the agent
        # was never unloaded by us, so re-bootstrapping it would error
        # with "service already loaded" and add nothing).
        require_db "''${1:-}"
        start_db="$1"

        log_start "$start_db" start

        start_flag="$STATE_DIR/halt-$start_db.flag"
        if [ ! -f "$start_flag" ]; then
          printf 'sqlite-backup: %s: already running\n' "$start_db"
          log_end "$start_db" start 0
          exit 0
        fi

        rm -f -- "$start_flag"
        printf 'sqlite-backup: %s: halt cleared\n' "$start_db"

        # Bootstrap the Litestream daemon. Failure here is non-fatal
        # from the operator's perspective — the most common cause is
        # "service already loaded" (e.g., on a host where the agent
        # was never actually unloaded), and the halt flag — the
        # authoritative state per the wrappers — is already cleared.
        start_plist="$(litestream_plist_path "$start_db")"
        start_uid="$(id -u)"
        if [ ! -f "$start_plist" ]; then
          printf 'sqlite-backup: %s: litestream plist not found at %s; skipping bootstrap\n' \
            "$start_db" "$start_plist" >&2
        elif "$LAUNCHCTL_BIN" bootstrap "gui/$start_uid" "$start_plist" >/dev/null 2>&1; then
          printf 'sqlite-backup: %s: litestream agent bootstrapped\n' "$start_db"
        else
          printf 'sqlite-backup: %s: litestream agent already loaded\n' "$start_db"
        fi

        log_end "$start_db" start 0
        exit 0
        ;;

      stop)
        # R13.11, R13.13, R13.14, R13.16: write halt flag and unload
        # the per-DB Litestream agent. Default content is
        # `replication-only`; `--include-archive` escalates to
        # `whole-pipeline` (consulted by the archive-tier wrapper in
        # task 3.5). Idempotent — same content rerun is a no-op;
        # different content is reported as a transition.
        #
        # Argument parsing is operator-friendly: `--include-archive`
        # may appear before or after the database name, anywhere in
        # the remaining argv.
        stop_include_archive=0
        stop_db=""
        for stop_arg in "$@"; do
          case "$stop_arg" in
            --include-archive)
              stop_include_archive=1
              ;;
            --*)
              echo "sqlite-backup: stop: unknown flag: $stop_arg" >&2
              exit 1
              ;;
            *)
              if [ -z "$stop_db" ]; then
                stop_db="$stop_arg"
              else
                echo "sqlite-backup: stop: unexpected positional arg: $stop_arg" >&2
                exit 1
              fi
              ;;
          esac
        done
        require_db "$stop_db"

        if [ "$stop_include_archive" = "1" ]; then
          stop_desired=whole-pipeline
        else
          stop_desired=replication-only
        fi

        log_start "$stop_db" stop

        stop_flag="$STATE_DIR/halt-$stop_db.flag"
        stop_current="$(get_halt_content "$stop_db")"

        if [ "$stop_current" = "$stop_desired" ]; then
          # Idempotent same-state rerun: leave file untouched, still
          # attempt the launchctl unload below — if the operator has
          # somehow re-loaded the agent out-of-band the right thing is
          # to bring it back in line with the declared halt state.
          printf 'sqlite-backup: %s: already halted (%s)\n' "$stop_db" "$stop_desired"
        else
          mkdir -p "$STATE_DIR"
          printf '%s' "$stop_desired" >"$stop_flag"
          if [ -n "$stop_current" ]; then
            printf 'sqlite-backup: %s: halt updated %s -> %s\n' \
              "$stop_db" "$stop_current" "$stop_desired"
          else
            printf 'sqlite-backup: %s: halted (%s)\n' "$stop_db" "$stop_desired"
          fi
        fi

        # Unload the Litestream daemon. `bootout` of an already-
        # unloaded agent exits non-zero; treat that as the agent
        # already being in the desired state (the halt flag is the
        # authoritative record per design.md §"State Management").
        stop_label="$(litestream_label "$stop_db")"
        stop_uid="$(id -u)"
        if "$LAUNCHCTL_BIN" bootout "gui/$stop_uid/$stop_label" >/dev/null 2>&1; then
          printf 'sqlite-backup: %s: litestream agent unloaded\n' "$stop_db"
        else
          printf 'sqlite-backup: %s: litestream agent already unloaded\n' "$stop_db"
        fi

        log_end "$stop_db" stop 0
        exit 0
        ;;

      __replicate-trigger)
        # Internal subcommand fired by the per-DB launchd
        # `dev.dwsr.sqlite-backup.replicate.<db>` agent on its
        # `StartInterval` cadence. Delegates to the shared
        # tier_trigger helper with `tier=replication`; the helper
        # implements the 10-step batch contract end-to-end and
        # returns the exit code propagated to launchd.
        require_db "''${1:-}"
        tier_trigger replication "$1"
        exit 0
        ;;

      __archive-trigger)
        # Internal subcommand fired by the per-DB launchd
        # `dev.dwsr.sqlite-backup.archive.<db>` agent on its
        # `StartCalendarInterval` schedule. Same 10-step contract
        # as __replicate-trigger but with `tier=archive`, the
        # archive-tier retention args (read from the manifest by
        # tier_trigger), and a coarser halt-skip rule (only
        # `whole-pipeline` halts skip; `replication-only` halt
        # leaves the archive tier running so an operator can stop
        # off-host shipment of WAL state without also losing the
        # daily archival snapshot).
        require_db "''${1:-}"
        tier_trigger archive "$1"
        exit 0
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
