{
  pkgs,
  lib,
  manifestPath,
}:
# sqlite-backup: operator-facing CLI for the SQLite backup pipeline.
#
# Single binary owning every public operator command (list, status,
# backup, restore, start, stop, clear-pressure, verify-credentials) AND the launchd-
# triggered wrappers (__litestream-trigger, __replicate-trigger,
# __archive-trigger, __pressure-guard).
# Subcommand dispatch is performed on `$1`; per-subcommand bodies are
# implemented in tasks 3.2 through 3.7. This task (3.1) provides:
#
#   * The dispatcher framework with case-on-`$1` covering all 12
#     subcommands plus `--help`.
#   * Shared helpers used by every subcommand: manifest reader (jq +
#     baked path), Keychain reader (absolute-path
#     /usr/bin/security -s "$(jq -r .keychainService …)" -a <secret>),
#     per-database mkdir lockfile,
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
    # `litestream` is consumed by the `restore` subcommand (task 3.7)
    # for stage-2 of the two-stage restore: after `restic restore`
    # extracts the LTX staging directory under a tmp prefix,
    # `litestream restore -o <target> [-timestamp <ts>] file://<dir>`
    # reconstructs the SQLite database file at the operator's chosen
    # target path. Lifted from `pkgs.unstable.litestream` via the
    # repo's litestream overlay; the minimum-version assertion lives
    # in `home-manager/common/sqlite-backup.nix`.
    litestream
  ];
  text = ''
    export LC_ALL=C

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

    # Keychain service is sourced from the rendered manifest at runtime
    # (R12.AC1, R12.AC3, R12.AC4). The HM module renders
    # `keychainService = "nix-config-secrets"` (post-mcpproxy
    # migration); sqlite-backup secrets live at
    # `(-s nix-config-secrets -a <secret-name>)` to match the
    # axis convention the activation script uses for both MCP
    # (`-s mcpproxy -a <name>`) and sqlite-backup secrets. Reading the
    # value here lets each host configure a different service prefix
    # without re-deriving the cli script. A missing or empty field
    # is a manifest bug worth failing loudly for.
    KEYCHAIN_SERVICE="$(jq -r '.keychainService // empty' "$MANIFEST_PATH")"
    if [ -z "$KEYCHAIN_SERVICE" ]; then
      echo "sqlite-backup: manifest at $MANIFEST_PATH is missing required '.keychainService' field" >&2
      exit 1
    fi
    readonly KEYCHAIN_SERVICE

    # Apple's `security` is not a Nix package; the absolute path is the
    # supported way to invoke it from a writeShellApplication's PATH-
    # locked environment (mirrors `scripts/mcp-secrets-activate.nix`).
    readonly SECURITY_BIN=/usr/bin/security

    # Production uses the documented system launchctl path. The optional
    # override is a narrow test seam so lifecycle transitions can be exercised
    # without touching the live user's launchd domain.
    readonly LAUNCHCTL_BIN="''${SQLITE_BACKUP_LAUNCHCTL_BIN:-/bin/launchctl}"

    # clear-pressure remeasures the byte thresholds captured in the pressure
    # marker. Coreutils supplies the production binaries; overrides keep the
    # boundary-value tests deterministic without filling a real filesystem.
    readonly DF_BIN="''${SQLITE_BACKUP_DF_BIN:-df}"
    readonly DU_BIN="''${SQLITE_BACKUP_DU_BIN:-du}"
    readonly DATE_BIN="''${SQLITE_BACKUP_DATE_BIN:-date}"
    readonly MARKER_JQ_BIN="''${SQLITE_BACKUP_MARKER_JQ_BIN:-jq}"
    readonly MARKER_MV_BIN="''${SQLITE_BACKUP_MARKER_MV_BIN:-mv}"

    # State root per design.md §"State Management". Manual halt flags contain
    # `replication-only` or `whole-pipeline` and remain ephemeral across HM
    # activation. Safety-triggered pressure markers are separate JSON records
    # and survive activation until clear-pressure validates recovery.
    readonly STATE_DIR="''${XDG_STATE_HOME:-$HOME/.local/state}/sqlite-backup"

    readonly LOG_DIR="''${SQLITE_BACKUP_LOG_DIR:-$HOME/Library/Logs}"
    readonly LOCK_DIR_BASE="''${TMPDIR:-/var/tmp}"
    # JSON-safe integer ceiling keeps jq rendering and Bash arithmetic exact.
    readonly MAX_SAFE_INTEGER=9007199254740991
    readonly MAX_SAFE_KIB=8796093022207
    # Zero means wait indefinitely. A guard waiting behind an active backup
    # holds the pressure gate so no new backup/start transition can overtake it.
    readonly PRESSURE_LOCK_RETRY_ATTEMPTS="''${SQLITE_BACKUP_LOCK_RETRY_ATTEMPTS:-0}"
    readonly PRESSURE_LOCK_RETRY_DELAY="''${SQLITE_BACKUP_LOCK_RETRY_DELAY:-0.1}"

    # Track the currently-held mkdir lock so the EXIT trap can clean up
    # even if the script is killed mid-run. release_lock clears the
    # variable AND the trap together so the trap never fires twice.
    LOCK_DIR=""
    PRESSURE_LOCK_DIR=""

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

    # get_secret_account <kind>
    # Returns the Keychain ACCOUNT name (the `-a` argument to
    # `security`) for one of the two secret kinds the pipeline
    # consumes. The matching service is always KEYCHAIN_SERVICE.
    get_secret_account() {
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
    get_keychain_service() {
      printf '%s\n' "$KEYCHAIN_SERVICE"
    }

    # ----------------------------------------------------------------
    # Keychain reader
    # ----------------------------------------------------------------

    # read_keychain_secret <account>
    # Print the plaintext password to stdout, propagate `security`'s
    # exit code so callers can distinguish missing-entry from other
    # failures. Used both directly by `verify-credentials` and as the
    # implementation of `RESTIC_PASSWORD_COMMAND` /
    # `RCLONE_PASSWORD_COMMAND` in the tier-trigger flows. The argument
    # is the keychain ACCOUNT (e.g. `sqlite-backup-archive-passphrase`);
    # the service is always `$KEYCHAIN_SERVICE` (e.g. `nix-config-secrets`).
    # shellcheck disable=SC2329  # consumed by tasks 3.2, 3.3, 3.5
    read_keychain_secret() {
      local account="$1"
      "$SECURITY_BIN" find-generic-password \
        -s "$KEYCHAIN_SERVICE" -a "$account" -w
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
    install_lock_traps() {
      trap 'cleanup_all_locks' EXIT
      trap 'cleanup_all_locks; exit 1' INT TERM
    }

    clear_lock_traps_if_idle() {
      if [ -z "$LOCK_DIR" ] && [ -z "$PRESSURE_LOCK_DIR" ]; then
        trap - EXIT INT TERM
      fi
    }

    cleanup_all_locks() {
      if [ -n "$LOCK_DIR" ]; then
        rm -rf -- "$LOCK_DIR"
        LOCK_DIR=""
      fi
      if [ -n "$PRESSURE_LOCK_DIR" ]; then
        rm -f -- "$PRESSURE_LOCK_DIR/marker.json" 2>/dev/null || true
        rm -f -- "$PRESSURE_LOCK_DIR/new-marker.json" 2>/dev/null || true
        rmdir -- "$PRESSURE_LOCK_DIR" 2>/dev/null || true
        PRESSURE_LOCK_DIR=""
      fi
      trap - EXIT INT TERM
    }

    acquire_lock() {
      local db="$1"
      local target="$LOCK_DIR_BASE/sqlite-backup-$db.lock"
      if ! mkdir "$target" 2>/dev/null; then
        return 1
      fi
      LOCK_DIR="$target"
      install_lock_traps
      return 0
    }

    acquire_lock_with_retry() {
      local db="$1" attempt=1
      while ! acquire_lock "$db"; do
        if [ "$PRESSURE_LOCK_RETRY_ATTEMPTS" -gt 0 ] \
          && [ "$attempt" -ge "$PRESSURE_LOCK_RETRY_ATTEMPTS" ]; then
          return 1
        fi
        sleep "$PRESSURE_LOCK_RETRY_DELAY"
        attempt=$((attempt + 1))
      done
    }

    release_lock() {
      if [ -n "$LOCK_DIR" ]; then
        rm -rf -- "$LOCK_DIR"
        LOCK_DIR=""
        clear_lock_traps_if_idle
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
        "$("$DATE_BIN" -u +%Y-%m-%dT%H:%M:%SZ)" "$subcmd" \
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
        "$("$DATE_BIN" -u +%Y-%m-%dT%H:%M:%SZ)" "$subcmd" "$code" \
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
    # restore, start, stop, clear-pressure, __litestream-trigger,
    # __replicate-trigger, __archive-trigger, __pressure-guard).
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

    pressure_marker_path() {
      printf '%s/pressure-%s.json' "$STATE_DIR" "$1"
    }

    pressure_lock_path() {
      printf '%s/pressure-%s.lock' "$STATE_DIR" "$1"
    }

    pressure_failure_path() {
      printf '%s/pressure-%s.failed' "$STATE_DIR" "$1"
    }

    pressure_marker_blocks_work() {
      path_blocks_pressure_work "$(pressure_marker_path "$1")"
    }

    pressure_lock_blocks_work() {
      path_blocks_pressure_work "$(pressure_lock_path "$1")"
    }

    pressure_failure_blocks_work() {
      path_blocks_pressure_work "$(pressure_failure_path "$1")"
    }

    # Return 0 when a path exists OR when absence cannot be proven because an
    # ancestor is inaccessible. Safety consumers treat uncertainty as halted.
    path_blocks_pressure_work() {
      local path="$1"
      if [ -e "$path" ] || [ -L "$path" ]; then
        return 0
      fi
      ! path_is_confirmed_missing "$path"
    }

    has_pressure_marker() {
      pressure_marker_blocks_work "$1" \
        || pressure_lock_blocks_work "$1" \
        || pressure_failure_blocks_work "$1"
    }

    acquire_pressure_lock() {
      local target
      target="$(pressure_lock_path "$1")"
      if ! mkdir "$target" 2>/dev/null; then
        return 1
      fi
      PRESSURE_LOCK_DIR="$target"
      install_lock_traps
    }

    acquire_pressure_lock_with_retry() {
      local db="$1" attempt=1
      while ! acquire_pressure_lock "$db"; do
        if [ "$PRESSURE_LOCK_RETRY_ATTEMPTS" -gt 0 ] \
          && [ "$attempt" -ge "$PRESSURE_LOCK_RETRY_ATTEMPTS" ]; then
          return 1
        fi
        sleep "$PRESSURE_LOCK_RETRY_DELAY"
        attempt=$((attempt + 1))
      done
    }

    release_pressure_lock() {
      if [ -n "$PRESSURE_LOCK_DIR" ]; then
        rm -f -- "$PRESSURE_LOCK_DIR/marker.json" 2>/dev/null || true
        rm -f -- "$PRESSURE_LOCK_DIR/new-marker.json" 2>/dev/null || true
        rmdir -- "$PRESSURE_LOCK_DIR" 2>/dev/null || true
        PRESSURE_LOCK_DIR=""
        clear_lock_traps_if_idle
      fi
    }

    preserve_pressure_lock() {
      # Leave the directory in place as a durable fail-closed sentinel when a
      # JSON marker cannot be persisted. Future work and start both treat the
      # pressure lock itself as an active halt.
      PRESSURE_LOCK_DIR=""
      clear_lock_traps_if_idle
    }

    preserve_pressure_failure() {
      local db="$1" failure
      failure="$(pressure_failure_path "$db")"
      if [ -d "$failure" ] && [ ! -L "$failure" ]; then
        release_pressure_lock
        return 0
      fi
      if mv -- "$PRESSURE_LOCK_DIR" "$failure" 2>/dev/null; then
        PRESSURE_LOCK_DIR=""
        clear_lock_traps_if_idle
        return 0
      else
        preserve_pressure_lock
        return 1
      fi
    }

    clear_pressure_failure() {
      local failure
      failure="$(pressure_failure_path "$1")"
      if path_is_confirmed_missing "$failure"; then
        return 0
      fi
      if [ -d "$failure" ] && [ ! -L "$failure" ]; then
        rm -f -- "$failure/marker.json" "$failure/new-marker.json" 2>/dev/null || true
        rmdir -- "$failure" 2>/dev/null
        return
      fi
      return 1
    }

    # The marker is deliberately self-contained for the handoff between the
    # future pressure guard and this recovery command. Limits and measurement
    # paths are the exact configuration that triggered the emergency halt.
    validate_pressure_marker() {
      local db="$1" marker="$2"
      jq -e --arg db "$db" --argjson maxSafe "$MAX_SAFE_INTEGER" '
        def uint:
          type == "number" and . >= 0 and . <= $maxSafe and floor == .;
        def observed:
          . == null or uint;

        type == "object"
        and has("schemaVersion")
        and has("database")
        and has("haltReason")
        and has("trigger")
        and has("observedBytes")
        and has("configuredLimits")
        and has("measurement")
        and has("timestamp")
        and .schemaVersion == 1
        and .database == $db
        and .haltReason == "disk-pressure"
        and (.trigger | type == "string" and length > 0)
        and (.timestamp | type == "string" and length > 0)
        and (
          .observedBytes
          | type == "object"
          and has("filesystemAvailable")
          and has("managedLocal")
          and (.filesystemAvailable | observed)
          and (.managedLocal | observed)
        )
        and (
          .configuredLimits
          | type == "object"
          and has("minimumFilesystemAvailableBytes")
          and has("maximumManagedLocalBytes")
          and (.minimumFilesystemAvailableBytes | uint)
          and (.maximumManagedLocalBytes | uint)
        )
        and (
          .measurement
          | type == "object"
          and has("filesystemPath")
          and has("managedPaths")
          and (
            .filesystemPath
            | type == "string" and startswith("/") and length > 0
          )
          and (
            .managedPaths
            | type == "array"
            and length > 0
            and all(.[]; type == "string" and startswith("/") and length > 0)
          )
        )
      ' "$marker" >/dev/null 2>&1
    }

    normalize_uint() {
      local value="$1"
      while [ "''${#value}" -gt 1 ] && [ "''${value#0}" != "$value" ]; do
        value="''${value#0}"
      done
      printf '%s\n' "$value"
    }

    uint_lte() {
      local left="$1" right="$2"
      [[ "$left" =~ ^[0-9]+$ ]] || return 1
      [[ "$right" =~ ^[0-9]+$ ]] || return 1
      left="$(normalize_uint "$left")"
      right="$(normalize_uint "$right")"
      if [ "''${#left}" -lt "''${#right}" ]; then
        return 0
      fi
      if [ "''${#left}" -gt "''${#right}" ]; then
        return 1
      fi
      [[ "$left" == "$right" || "$left" < "$right" ]]
    }

    # Print filesystem available bytes for a path. POSIX `df -Pk` gives a
    # locale-stable available-block column in 1024-byte units.
    measure_filesystem_available_bytes() {
      local path="$1" output line mounted
      local -a lines=()
      if ! output="$(LC_ALL=C "$DF_BIN" -Pk -- "$path" 2>/dev/null)"; then
        return 1
      fi
      mapfile -t lines <<<"$output"
      if [ "''${#lines[@]}" -ne 2 ]; then
        return 1
      fi
      line="''${lines[1]}"

      local available
      read -r _ _ _ available _ mounted <<<"$line"
      if [ -z "$mounted" ] || ! uint_lte "$available" "$MAX_SAFE_KIB"; then
        return 1
      fi
      printf '%s\n' "$((available * 1024))"
    }

    # Return 0 only when a path is provably absent through a searchable
    # existing ancestor. This distinguishes ENOENT from an inaccessible child,
    # for which `[ -e ]` also returns false.
    path_is_confirmed_missing() {
      local candidate="$1" parent
      while [ ! -e "$candidate" ] && [ ! -L "$candidate" ]; do
        parent="''${candidate%/*}"
        if [ -z "$parent" ]; then
          parent=/
        fi
        if [ "$parent" = "$candidate" ]; then
          return 0
        fi
        if [ -e "$parent" ] || [ -L "$parent" ]; then
          [ -d "$parent" ] && [ -x "$parent" ]
          return
        fi
        candidate="$parent"
      done
      return 1
    }

    # Print the sum of physical allocated bytes for paths read from stdin.
    # Missing paths contribute zero; any unreadable path fails closed.
    measure_managed_paths() {
      local total=0 path output kib reported_path
      while IFS= read -r path; do
        [ -n "$path" ] || continue
        if [ ! -e "$path" ]; then
          if path_is_confirmed_missing "$path"; then
            continue
          fi
          printf 'sqlite-backup: pressure guard managed path %s is inaccessible or cannot be resolved\n' \
            "$path" >&2
          return 1
        fi
        if [ -d "$path" ]; then
          if [ ! -r "$path" ] || [ ! -x "$path" ]; then
            printf 'sqlite-backup: pressure guard managed path %s is not readable and searchable\n' \
              "$path" >&2
            return 1
          fi
        elif [ ! -r "$path" ]; then
          printf 'sqlite-backup: pressure guard managed path %s is not readable\n' \
            "$path" >&2
          return 1
        fi
        # `-H` follows a command-line symlink such as an XDG data root moved to
        # another volume, while leaving nested symlinks alone. Without it GNU
        # du reports only the symlink inode (typically zero KiB).
        if ! output="$("$DU_BIN" -skH -- "$path")"; then
          printf 'sqlite-backup: pressure guard could not measure managed path %s with du\n' \
            "$path" >&2
          return 1
        fi
        if [[ "$output" == *$'\n'* ]]; then
          printf 'sqlite-backup: pressure guard received multiline du output for managed path %s\n' \
            "$path" >&2
          return 1
        fi
        read -r kib reported_path <<<"$output"
        if [ "$reported_path" != "$path" ] || ! uint_lte "$kib" "$MAX_SAFE_KIB"; then
          printf 'sqlite-backup: pressure guard received invalid du output for managed path %s\n' \
            "$path" >&2
          return 1
        fi
        local bytes
        bytes=$((kib * 1024))
        if [ "$total" -gt "$((MAX_SAFE_INTEGER - bytes))" ]; then
          printf 'sqlite-backup: pressure guard managed-byte total overflow at path %s\n' \
            "$path" >&2
          return 1
        fi
        total=$((total + bytes))
      done
      printf '%s\n' "$total"
    }

    measure_managed_local_bytes() {
      local marker="$1"
      measure_managed_paths < <(jq -r '.measurement.managedPaths[]' "$marker")
    }

    measure_managed_local_bytes_for_db() {
      local db="$1"
      measure_managed_paths < <(
        jq -r --arg db "$db" '
          .databases[]
          | select(.name == $db)
          | .pressureGuard.managedPaths[]
        ' "$MANIFEST_PATH"
      )
    }

    unload_litestream_for_pressure() {
      local db="$1"
      local label uid
      label="$(litestream_label "$db")"
      uid="$(id -u)"
      if "$LAUNCHCTL_BIN" bootout "gui/$uid/$label" >/dev/null 2>&1; then
        printf 'sqlite-backup: %s: pressure guard unloaded Litestream\n' "$db"
      else
        local list_status
        if "$LAUNCHCTL_BIN" list "$label" >/dev/null 2>&1; then
          list_status=0
        else
          list_status=$?
        fi
        if [ "$list_status" -eq 113 ]; then
          printf 'sqlite-backup: %s: pressure guard confirmed Litestream is unloaded\n' "$db"
          return 0
        fi
        printf 'sqlite-backup: %s: pressure guard could not unload Litestream label=%s\n' \
          "$db" "$label" >&2
        return 1
      fi
    }

    write_pressure_marker_locked() {
      local db="$1" trigger="$2" available_json="$3" managed_json="$4"
      local marker guard_json minimum maximum filesystem_path managed_paths timestamp tmp

      marker="$(pressure_marker_path "$db")"
      if [ -z "$PRESSURE_LOCK_DIR" ]; then
        printf 'sqlite-backup: %s: pressure marker write attempted without pressure lock\n' \
          "$db" >&2
        return 1
      fi

      # shellcheck disable=SC2016  # `$db` below is a jq variable.
      if ! guard_json="$("$MARKER_JQ_BIN" -ce --arg db "$db" '
        .databases[] | select(.name == $db) | .pressureGuard
      ' "$MANIFEST_PATH")" \
        || ! minimum="$("$MARKER_JQ_BIN" -er '.minimumFilesystemAvailableBytes' <<<"$guard_json")" \
        || ! maximum="$("$MARKER_JQ_BIN" -er '.maximumManagedLocalBytes' <<<"$guard_json")" \
        || ! filesystem_path="$("$MARKER_JQ_BIN" -er '.filesystemPath' <<<"$guard_json")" \
        || ! managed_paths="$("$MARKER_JQ_BIN" -ce '.managedPaths' <<<"$guard_json")"; then
        printf 'sqlite-backup: %s: pressure guard could not read marker configuration\n' \
          "$db" >&2
        preserve_pressure_failure "$db" || true
        return 1
      fi
      if ! timestamp="$("$DATE_BIN" -u +%Y-%m-%dT%H:%M:%SZ)" \
        || [ -z "$timestamp" ]; then
        printf 'sqlite-backup: %s: pressure guard could not obtain a timestamp\n' "$db" >&2
        preserve_pressure_failure "$db" || true
        return 1
      fi

      # Preserve the first durable halt if another guard won the race.
      if path_blocks_pressure_work "$marker"; then
        return 0
      fi

      tmp="$PRESSURE_LOCK_DIR/new-marker.json"
      if ! jq -n \
        --arg database "$db" \
        --arg trigger "$trigger" \
        --arg timestamp "$timestamp" \
        --arg filesystemPath "$filesystem_path" \
        --argjson filesystemAvailable "$available_json" \
        --argjson managedLocal "$managed_json" \
        --argjson minimumFilesystemAvailableBytes "$minimum" \
        --argjson maximumManagedLocalBytes "$maximum" \
        --argjson managedPaths "$managed_paths" \
        '{
          schemaVersion: 1,
          database: $database,
          haltReason: "disk-pressure",
          trigger: $trigger,
          observedBytes: {
            filesystemAvailable: $filesystemAvailable,
            managedLocal: $managedLocal
          },
          configuredLimits: {
            minimumFilesystemAvailableBytes: $minimumFilesystemAvailableBytes,
            maximumManagedLocalBytes: $maximumManagedLocalBytes
          },
          measurement: {
            filesystemPath: $filesystemPath,
            managedPaths: $managedPaths
          },
          timestamp: $timestamp
        }' >"$tmp"; then
        printf 'sqlite-backup: %s: pressure guard could not render marker JSON\n' "$db" >&2
        preserve_pressure_failure "$db"
        return 1
      fi
      if ! chmod 600 "$tmp"; then
        printf 'sqlite-backup: %s: pressure guard could not secure marker permissions\n' \
          "$db" >&2
        preserve_pressure_failure "$db"
        return 1
      fi
      if ! "$MARKER_MV_BIN" -fT -- "$tmp" "$marker"; then
        printf 'sqlite-backup: %s: pressure guard could not persist marker %s\n' \
          "$db" "$marker" >&2
        preserve_pressure_failure "$db"
        return 1
      fi
      printf 'sqlite-backup: %s: pressure marker persisted trigger=%s path=%s\n' \
        "$db" "$trigger" "$marker"
    }

    # Return 0 when healthy, 10 after a durable threshold halt, and 11 after a
    # fail-closed measurement/configuration error.
    pressure_guard() {
      local db="$1"
      if pressure_marker_blocks_work "$db"; then
        printf 'sqlite-backup: %s: pressure guard preserving active halt\n' "$db"
        unload_litestream_for_pressure "$db" || return 11
        return 10
      fi

      if ! mkdir -p "$STATE_DIR"; then
        printf 'sqlite-backup: %s: pressure guard could not create state directory %s\n' \
          "$db" "$STATE_DIR" >&2
        unload_litestream_for_pressure "$db" || true
        return 11
      fi
      if ! acquire_pressure_lock_with_retry "$db"; then
        printf 'sqlite-backup: %s: pressure guard timed out waiting for pressure transition\n' \
          "$db" >&2
        unload_litestream_for_pressure "$db" || true
        return 11
      fi
      if pressure_marker_blocks_work "$db"; then
        release_pressure_lock
        unload_litestream_for_pressure "$db" || return 11
        return 10
      fi

      local force_marker=0
      if pressure_failure_blocks_work "$db"; then
        force_marker=1
      fi
      if ! acquire_lock_with_retry "$db"; then
        printf 'sqlite-backup: %s: pressure guard timed out waiting for backup lock\n' \
          "$db" >&2
        preserve_pressure_failure "$db" || true
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi

      local guard_json filesystem_path minimum maximum
      guard_json="$(jq -c --arg db "$db" '
        .databases[] | select(.name == $db) | .pressureGuard // empty
      ' "$MANIFEST_PATH")"
      if [ -z "$guard_json" ] || ! jq -e '
        type == "object"
        and (.filesystemPath | type == "string" and startswith("/"))
        and (
          .managedPaths
          | type == "array"
          and length > 0
          and all(.[]; type == "string" and startswith("/"))
        )
      ' <<<"$guard_json" >/dev/null; then
        printf 'sqlite-backup: %s: pressure guard configuration is missing or invalid\n' "$db" >&2
        preserve_pressure_failure "$db" || true
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi

      filesystem_path="$(jq -r '.filesystemPath' <<<"$guard_json")"
      minimum="$(jq -r '.minimumFilesystemAvailableBytes' <<<"$guard_json")"
      maximum="$(jq -r '.maximumManagedLocalBytes' <<<"$guard_json")"
      if ! uint_lte "$minimum" "$MAX_SAFE_INTEGER" \
        || ! uint_lte "$maximum" "$MAX_SAFE_INTEGER"; then
        printf 'sqlite-backup: %s: pressure guard byte limits are invalid\n' "$db" >&2
        preserve_pressure_failure "$db" || true
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi

      local available=null managed=null measurement_error=0
      if ! available="$(measure_filesystem_available_bytes "$filesystem_path")"; then
        available=null
        measurement_error=1
        printf 'sqlite-backup: %s: pressure guard filesystem measurement failed path=%s\n' \
          "$db" "$filesystem_path" >&2
      fi
      if ! managed="$(measure_managed_local_bytes_for_db "$db")"; then
        managed=null
        measurement_error=1
        printf 'sqlite-backup: %s: pressure guard managed-byte measurement failed\n' \
          "$db" >&2
      fi

      printf 'sqlite-backup: %s: pressure guard filesystem-available=%s minimum=%s managed-local=%s maximum=%s\n' \
        "$db" "$available" "$minimum" "$managed" "$maximum"

      if [ "$measurement_error" -ne 0 ]; then
        if ! write_pressure_marker_locked "$db" measurement-error "$available" "$managed"; then
          release_lock
          release_pressure_lock
          unload_litestream_for_pressure "$db" || true
          return 11
        fi
        if ! clear_pressure_failure "$db"; then
          printf 'sqlite-backup: %s: pressure guard could not clear failed-write sentinel\n' \
            "$db" >&2
        fi
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi

      local filesystem_violated=0 managed_violated=0 trigger
      if [ "$available" -lt "$minimum" ]; then
        filesystem_violated=1
      fi
      if [ "$managed" -gt "$maximum" ]; then
        managed_violated=1
      fi
      if [ "$filesystem_violated" -eq 0 ] \
        && [ "$managed_violated" -eq 0 ] \
        && [ "$force_marker" -eq 0 ]; then
        release_lock
        release_pressure_lock
        return 0
      elif [ "$filesystem_violated" -ne 0 ] && [ "$managed_violated" -ne 0 ]; then
        trigger="multiple-thresholds"
      elif [ "$filesystem_violated" -ne 0 ]; then
        trigger="minimum-filesystem-available-bytes"
      elif [ "$managed_violated" -ne 0 ]; then
        trigger="maximum-managed-local-bytes"
      else
        trigger="marker-persistence-error"
      fi

      printf 'sqlite-backup: %s: pressure guard tripped trigger=%s\n' "$db" "$trigger"
      if ! write_pressure_marker_locked "$db" "$trigger" "$available" "$managed"; then
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi
      if ! clear_pressure_failure "$db"; then
        printf 'sqlite-backup: %s: pressure guard could not clear failed-write sentinel\n' \
          "$db" >&2
        release_lock
        release_pressure_lock
        unload_litestream_for_pressure "$db" || true
        return 11
      fi
      release_lock
      release_pressure_lock
      if ! unload_litestream_for_pressure "$db"; then
        return 11
      fi
      return 10
    }

    litestream_trigger() {
      local db="$1" guard_status config_path

      # Gate launchd's own RunAtLoad path through the same measurement used by
      # the periodic and synchronous guards. A pre-existing or newly-created
      # marker causes pressure_guard to boot out this Litestream job.
      if pressure_guard "$db"; then
        :
      else
        guard_status=$?
        return "$guard_status"
      fi

      # Serialize the last marker check with startup. If another transition is
      # active, KeepAlive retries this wrapper after that transition completes.
      if ! acquire_pressure_lock "$db"; then
        printf 'sqlite-backup: %s: Litestream startup deferred by pressure transition\n' \
          "$db" >&2
        return 11
      fi
      if pressure_marker_blocks_work "$db"; then
        release_pressure_lock
        unload_litestream_for_pressure "$db" || return 11
        return 10
      fi

      config_path="$(get_database_field "$db" litestreamConfigPath)"
      if [ -z "$config_path" ] || [ ! -f "$config_path" ]; then
        release_pressure_lock
        printf 'sqlite-backup: %s: manifest missing readable litestreamConfigPath\n' \
          "$db" >&2
        return 11
      fi
      release_pressure_lock

      exec litestream replicate -config "$config_path"
    }

    get_halt_reason() {
      local db="$1"
      if has_pressure_marker "$db"; then
        printf 'disk-pressure\n'
        return
      fi

      local halt
      halt="$(get_halt_content "$db")"
      if [ -n "$halt" ]; then
        printf '%s\n' "$halt"
      else
        printf 'none\n'
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
      if has_pressure_marker "$db"; then
        printf 'halted-disk-pressure\n'
        return
      fi
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
      local account
      account="$(get_secret_account archive 2>/dev/null || true)"
      if [ -z "$account" ] || [ "$account" = "null" ]; then
        printf 'never\n'
        return
      fi
      local pw
      if ! pw="$(read_keychain_secret "$account" 2>/dev/null)"; then
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
    # Emit the structured block format for one database (the format
    # mandated by task 3.2 implementation guidance — operator-friendly
    # YAML-style key/value, distinct from a tabular layout, so that
    # extra fields can be added in future tasks without breaking
    # consumers that already grep `last-replication-snapshot:`).
    print_db_status() {
      local db="$1"
      local state halt_reason last_rep last_arc
      state="$(get_replication_state "$db")"
      halt_reason="$(get_halt_reason "$db")"
      last_rep="$(get_last_snapshot "$db" replication)"
      last_arc="$(get_last_snapshot "$db" archive)"
      printf '%s:\n' "$db"
      printf '  replication-state: %s\n' "$state"
      printf '  halt-reason: %s\n' "$halt_reason"
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

      # Run the safety guard before log I/O so an unwritable/full log volume
      # cannot bypass pressure enforcement. Halt/error paths log best-effort;
      # healthy paths retain the normal mandatory start/end logging contract.
      local guard_status
      if pressure_guard "$db"; then
        log_start "$db" "$subcmd"
      else
        guard_status=$?
        log_start "$db" "$subcmd" || true
        if [ "$guard_status" -eq 10 ]; then
          printf 'sqlite-backup: %s: %s skipped (disk-pressure halt; guard tripped)\n' \
            "$db" "$subcmd"
          log_end "$db" "$subcmd" 0 || true
          return 0
        fi
        printf 'sqlite-backup: %s: %s failed closed (pressure measurement error)\n' \
          "$db" "$subcmd" >&2
        log_end "$db" "$subcmd" 1 || true
        return 1
      fi

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

      # Serialize the final marker check with backup-lock acquisition. A guard
      # writer cannot publish a marker between these operations because both
      # transitions use the pressure lock.
      if ! acquire_pressure_lock "$db"; then
        printf 'sqlite-backup: %s: %s failed closed (pressure transition active)\n' \
          "$db" "$subcmd" >&2
        log_end "$db" "$subcmd" 1
        return 1
      fi
      if pressure_marker_blocks_work "$db"; then
        release_pressure_lock
        printf 'sqlite-backup: %s: %s skipped (disk-pressure halt)\n' \
          "$db" "$subcmd"
        log_end "$db" "$subcmd" 0
        return 0
      fi

      # Step 2: acquire the per-DB backup mutex while the pressure gate is
      # still held. Once acquired, release only the pressure gate; the backup
      # lock's shared EXIT trap remains armed for the rest of the run.
      if ! acquire_lock "$db"; then
        release_pressure_lock
        printf 'sqlite-backup: %s: %s skipped (lock held by another run)\n' \
          "$db" "$subcmd"
        log_end "$db" "$subcmd" 0
        return 0
      fi
      release_pressure_lock

      # Step 3: build and export the Keychain-backed password command
      # strings. restic and rclone both fork+exec these strings via
      # their own shell to obtain the relevant passphrase on demand,
      # so the plaintext never lives in our process memory and never
      # appears in argv. Both ends of every cross-repo restic
      # operation use the same archive passphrase (Risks bullet #2 in
      # design.md §"Implementation Notes"), so RESTIC_FROM_PASSWORD_COMMAND
      # is always equal to RESTIC_PASSWORD_COMMAND.
      local archive_secret rclone_secret
      archive_secret="$(get_secret_account archive)"
      rclone_secret="$(get_secret_account rclone-config)"
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

      # KEYCHAIN_SERVICE and the secret account names are Nix-rendered
      # identifiers from the HM module surface (by convention
      # `[a-z0-9-]+`), so no shell metacharacters require quoting in
      # the command string. The exported value is parsed by restic's
      # / rclone's own shell when each tool needs the passphrase, so
      # the value MUST be a properly word-quoted shell command — the
      # simple concatenation here is intentional. Axis orientation:
      # `-s <service> -a <secret-name>` matches the activation
      # script's write side.
      RESTIC_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $KEYCHAIN_SERVICE -a $archive_secret -w"
      RCLONE_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $KEYCHAIN_SERVICE -a $rclone_secret -w"
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
      clear-pressure <db>             Clear a healthy emergency pressure halt.
      verify-credentials [<db>]       Probe rclone destinations.

    Run `sqlite-backup --help` to print this message.
    USAGE
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

        rclone_secret_account="$(get_secret_account rclone-config)"
        if [ -z "$rclone_secret_account" ] || [ "$rclone_secret_account" = "null" ]; then
          echo "sqlite-backup: manifest does not declare rcloneConfigPassphraseSecret" >&2
          exit 1
        fi

        # `rclone` exec's RCLONE_PASSWORD_COMMAND through its own
        # shell to obtain the config-decryption passphrase. Both
        # KEYCHAIN_SERVICE (sourced from the manifest's
        # `.keychainService` field at script init; a Nix-rendered
        # identifier from the HM module surface) and the secret
        # account name (also Nix-rendered, by convention `[a-z0-9-]+`)
        # are free of shell metacharacters, so the unquoted
        # concatenation is intentional.
        RCLONE_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $KEYCHAIN_SERVICE -a $rclone_secret_account -w"
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
        # R13.6, R13.7, R13.8, R13.9 + R9.1-9.4: two-stage restore.
        #
        # Surface:
        #   sqlite-backup restore <db> [--target <path>] [--time <ts>]
        #                              [--from-remote] [--force]
        # Defaults: --target = $PWD/<db>-restored.db, --time = latest,
        # --from-remote = false, --force = false. Per design.md
        # §"CLI Script → Service Interface" `restore` block.
        #
        # The function never overwrites the live SQLite database file
        # — the default target deliberately lives under $PWD with a
        # `-restored.db` suffix so an absent-minded operator who omits
        # `--target` cannot stomp the source DB. R13.AC9 mandates the
        # pre-flight refusal of any non-empty existing target without
        # `--force`; the same check applies whether or not `--target`
        # was supplied explicitly (defaulting in $PWD does not bypass
        # the pre-flight).
        #
        # Two-stage restore (design.md §"Recovery from Off-Host
        # Destination Only" + §"Service Interface" `restore` block):
        #
        #   Stage 1: `restic restore <id> --target <tmp>` extracts the
        #            snapshot's contents under <tmp>, preserving the
        #            original absolute paths (so the LTX staging dir
        #            ends up at <tmp><original-staging-path>).
        #   Stage 2: `litestream restore -o <target>
        #            [-timestamp <ts>] file://<extracted-staging>`
        #            reads the LTX segments and reconstructs the
        #            SQLite database file at <target>.
        #
        # Snapshot selection:
        #   * `--time latest` (or omitted): use restic's `latest`
        #     selector (we still query --json once to learn the
        #     extracted absolute path; see below).
        #   * `--time <ts>`: pick the snapshot whose `time` is at-or-
        #     before <ts>, regardless of tag (replication and archive
        #     tags share the same staging directory contents, so the
        #     PIT semantic is "the most recent snapshot of any tier
        #     that does not exceed <ts>"). Per the implementation
        #     guidance / R13.AC7 + R9.AC3.
        #
        # Original-staging-path resolution: a snapshot's `paths` array
        # records the absolute path the backup was taken under. We
        # query `restic snapshots --json` once and pull both the
        # snapshot ID and `paths[0]` from the same record so the
        # extracted-staging path used in stage 2 is always the path
        # the snapshot was actually taken with — important for cross-
        # host restore (R13.AC8 / R9.AC4 host-loss scenario), where
        # the new host's manifest may compute a different stagingDir
        # than the snapshot was originally captured with.
        #
        # `--from-remote` (R13.AC8 / R9.AC4 host-loss scenario): bypass
        # the local repo entirely and address the remote restic repo
        # at `rclone:<remote>:<remotePath>/<db>`. Both
        # RESTIC_PASSWORD_COMMAND (archive passphrase) AND
        # RCLONE_PASSWORD_COMMAND (rclone-config passphrase) MUST be
        # set so restic can decrypt its repo AND rclone can decrypt
        # its config to reach the destination.
        require_db "''${1:-}"
        restore_db="$1"
        shift

        restore_target=""
        restore_timestamp=""
        restore_from_remote=false
        restore_force=false

        while [ $# -gt 0 ]; do
          case "$1" in
            --target)
              if [ $# -lt 2 ]; then
                echo "sqlite-backup: restore: --target requires a value" >&2
                exit 1
              fi
              restore_target="$2"
              shift 2
              ;;
            --time)
              if [ $# -lt 2 ]; then
                echo "sqlite-backup: restore: --time requires a value" >&2
                exit 1
              fi
              restore_timestamp="$2"
              shift 2
              ;;
            --from-remote)
              restore_from_remote=true
              shift
              ;;
            --force)
              restore_force=true
              shift
              ;;
            *)
              echo "sqlite-backup: restore: unknown flag: $1" >&2
              exit 1
              ;;
          esac
        done

        # Apply documented defaults.
        if [ -z "$restore_target" ]; then
          restore_target="$PWD/$restore_db-restored.db"
        fi
        if [ -z "$restore_timestamp" ]; then
          restore_timestamp=latest
        fi

        # R13.AC9: refuse to overwrite a non-empty existing target
        # unless --force. `-e` AND `-s` so an empty file (e.g., a
        # touched placeholder) is treated as overwriteable; matches
        # the spec wording "as a non-empty file".
        if [ -e "$restore_target" ] && [ -s "$restore_target" ]; then
          if [ "$restore_force" != "true" ]; then
            printf 'sqlite-backup: restore: target %s exists and is non-empty; pass --force to overwrite\n' \
              "$restore_target" >&2
            exit 1
          fi
        fi

        log_start "$restore_db" restore

        # Archive passphrase is always required (it encrypts both the
        # local and the remote restic repo).
        restore_archive_secret="$(get_secret_account archive)"
        if [ -z "$restore_archive_secret" ] || [ "$restore_archive_secret" = "null" ]; then
          echo "sqlite-backup: $restore_db: restore: missing archivePassphraseSecret in manifest" >&2
          log_end "$restore_db" restore 1
          exit 1
        fi
        # Same word-quoting note as tier_trigger: KEYCHAIN_SERVICE and
        # the secret account name are Nix-rendered identifiers and
        # contain no shell metacharacters, so the simple unquoted
        # concatenation here is intentional.
        RESTIC_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $KEYCHAIN_SERVICE -a $restore_archive_secret -w"
        export RESTIC_PASSWORD_COMMAND

        # Repo selection.
        if [ "$restore_from_remote" = "true" ]; then
          restore_remote="$(get_database_field "$restore_db" remote)"
          restore_remote_path="$(get_database_field "$restore_db" remotePath)"
          if [ -z "$restore_remote" ] || [ -z "$restore_remote_path" ]; then
            echo "sqlite-backup: $restore_db: restore: manifest missing remote/remotePath" >&2
            log_end "$restore_db" restore 1
            exit 1
          fi
          restore_repo="rclone:$restore_remote:$restore_remote_path/$restore_db"

          # rclone needs its own config-decryption passphrase to
          # reach any encrypted-config destination.
          restore_rclone_secret="$(get_secret_account rclone-config)"
          if [ -z "$restore_rclone_secret" ] || [ "$restore_rclone_secret" = "null" ]; then
            echo "sqlite-backup: $restore_db: restore: missing rcloneConfigPassphraseSecret in manifest" >&2
            log_end "$restore_db" restore 1
            exit 1
          fi
          RCLONE_PASSWORD_COMMAND="$SECURITY_BIN find-generic-password -s $KEYCHAIN_SERVICE -a $restore_rclone_secret -w"
          export RCLONE_PASSWORD_COMMAND
        else
          restore_repo="$(get_database_field "$restore_db" repoDir)"
          if [ -z "$restore_repo" ]; then
            echo "sqlite-backup: $restore_db: restore: manifest missing repoDir" >&2
            log_end "$restore_db" restore 1
            exit 1
          fi
        fi

        # Single snapshots --json query that yields BOTH the snapshot
        # ID we will pass to `restic restore` AND the absolute staging
        # path recorded in the snapshot (used to locate the extracted
        # staging dir for stage 2). For `--time latest`, jq picks
        # `sort_by(.time) | last`; for an explicit timestamp it picks
        # the most recent snapshot at-or-before that timestamp,
        # regardless of tag (replication and archive snapshots share
        # the same staging contents, so PIT is "any snapshot whose
        # time <= <ts>").
        if ! restore_snapshots_json="$(restic -r "$restore_repo" snapshots --json 2>&1)"; then
          printf 'sqlite-backup: %s: restore: failed to list snapshots in %s: %s\n' \
            "$restore_db" "$restore_repo" "$restore_snapshots_json" >&2
          log_end "$restore_db" restore 1
          exit 1
        fi
        restore_snapshot_meta="$(printf '%s' "$restore_snapshots_json" | jq -c --arg ts "$restore_timestamp" '
          if $ts == "latest" then
            sort_by(.time) | last
          else
            [.[] | select(.time <= $ts)] | sort_by(.time) | last
          end
        ')"
        if [ -z "$restore_snapshot_meta" ] || [ "$restore_snapshot_meta" = "null" ]; then
          if [ "$restore_timestamp" = "latest" ]; then
            printf 'sqlite-backup: %s: restore: no snapshots found in %s\n' \
              "$restore_db" "$restore_repo" >&2
          else
            printf 'sqlite-backup: %s: restore: no snapshot found at-or-before %s in %s\n' \
              "$restore_db" "$restore_timestamp" "$restore_repo" >&2
          fi
          log_end "$restore_db" restore 1
          exit 1
        fi
        restore_snapshot_id="$(printf '%s' "$restore_snapshot_meta" | jq -r '.id // empty')"
        restore_original_staging="$(printf '%s' "$restore_snapshot_meta" | jq -r '.paths[0] // empty')"
        if [ -z "$restore_snapshot_id" ] || [ -z "$restore_original_staging" ]; then
          echo "sqlite-backup: $restore_db: restore: could not parse snapshot metadata" >&2
          log_end "$restore_db" restore 1
          exit 1
        fi

        # Stage 1: restic restore to a tmpdir. The trap clears the
        # tmpdir on every exit path including signals, so a
        # mid-restore Ctrl-C does not leak gigabytes of extracted LTX
        # state into $TMPDIR.
        restore_tmp="$(mktemp -d -t sqlite-backup-restore.XXXXXX)"
        # shellcheck disable=SC2064  # capture restore_tmp by value at trap-install time
        trap "rm -rf -- '$restore_tmp'" EXIT INT TERM

        if ! restic -r "$restore_repo" restore "$restore_snapshot_id" --target "$restore_tmp"; then
          echo "sqlite-backup: $restore_db: restore: restic restore failed" >&2
          log_end "$restore_db" restore 1
          exit 1
        fi

        # restic preserves the original absolute path under --target,
        # so the LTX staging directory recorded in the snapshot ends
        # up at <tmp><original-staging-path>.
        restore_extracted="$restore_tmp$restore_original_staging"
        if [ ! -d "$restore_extracted" ]; then
          printf 'sqlite-backup: %s: restore: extracted staging dir not found at %s\n' \
            "$restore_db" "$restore_extracted" >&2
          log_end "$restore_db" restore 1
          exit 1
        fi

        # Stage 2: litestream restore from the extracted staging dir.
        # `-timestamp` is only passed when the operator supplied an
        # explicit point-in-time; for `latest`, omitting the flag has
        # litestream replay the entire LTX chain to the head, which
        # is the documented default and matches `--time latest`
        # semantics.
        if [ "$restore_timestamp" != "latest" ]; then
          if ! litestream restore -o "$restore_target" -timestamp "$restore_timestamp" "file://$restore_extracted"; then
            echo "sqlite-backup: $restore_db: restore: litestream restore failed" >&2
            log_end "$restore_db" restore 1
            exit 1
          fi
        else
          if ! litestream restore -o "$restore_target" "file://$restore_extracted"; then
            echo "sqlite-backup: $restore_db: restore: litestream restore failed" >&2
            log_end "$restore_db" restore 1
            exit 1
          fi
        fi

        printf 'sqlite-backup: %s: restored to %s\n' "$restore_db" "$restore_target"
        log_end "$restore_db" restore 0
        exit 0
        ;;

      start)
        # R13.12, R13.16, R18.4, R18.9: pressure state blocks start.
        # Otherwise clear any manual halt and ensure the per-DB Litestream
        # agent is loaded. No manual halt plus an unloaded agent is the normal
        # post-clear-pressure state and therefore still needs a bootstrap.
        require_db "''${1:-}"
        start_db="$1"

        if has_pressure_marker "$start_db"; then
          printf 'sqlite-backup: %s: disk-pressure halt active; refusing to start\n' \
            "$start_db" >&2
          printf 'sqlite-backup: %s: recovery command: sqlite-backup clear-pressure %s\n' \
            "$start_db" "$start_db" >&2
          log_start "$start_db" start || true
          log_end "$start_db" start 1 || true
          exit 1
        fi

        log_start "$start_db" start

        if ! acquire_pressure_lock "$start_db"; then
          printf 'sqlite-backup: %s: pressure transition active; refusing to start\n' \
            "$start_db" >&2
          log_end "$start_db" start 1
          exit 1
        fi
        if pressure_marker_blocks_work "$start_db"; then
          release_pressure_lock
          printf 'sqlite-backup: %s: disk-pressure halt active; refusing to start\n' \
            "$start_db" >&2
          printf 'sqlite-backup: %s: recovery command: sqlite-backup clear-pressure %s\n' \
            "$start_db" "$start_db" >&2
          log_end "$start_db" start 1
          exit 1
        fi

        start_flag="$STATE_DIR/halt-$start_db.flag"
        if [ ! -f "$start_flag" ]; then
          start_label="$(litestream_label "$start_db")"
          if "$LAUNCHCTL_BIN" list "$start_label" >/dev/null 2>&1; then
            release_pressure_lock
            printf 'sqlite-backup: %s: already running\n' "$start_db"
            log_end "$start_db" start 0
            exit 0
          fi
        else
          rm -f -- "$start_flag"
          printf 'sqlite-backup: %s: halt cleared\n' "$start_db"
        fi

        if pressure_marker_blocks_work "$start_db"; then
          release_pressure_lock
          printf 'sqlite-backup: %s: disk-pressure halt appeared during start; refusing bootstrap\n' \
            "$start_db" >&2
          printf 'sqlite-backup: %s: recovery command: sqlite-backup clear-pressure %s\n' \
            "$start_db" "$start_db" >&2
          log_end "$start_db" start 1
          exit 1
        fi

        # Bootstrap the Litestream daemon. A failed bootstrap is accepted only
        # when a follow-up list proves the agent was already loaded; otherwise
        # start fails rather than claiming an unloaded pipeline is running.
        start_plist="$(litestream_plist_path "$start_db")"
        start_uid="$(id -u)"
        if [ ! -f "$start_plist" ]; then
          release_pressure_lock
          printf 'sqlite-backup: %s: litestream plist not found at %s\n' \
            "$start_db" "$start_plist" >&2
          log_end "$start_db" start 1
          exit 1
        elif "$LAUNCHCTL_BIN" bootstrap "gui/$start_uid" "$start_plist" >/dev/null 2>&1; then
          printf 'sqlite-backup: %s: litestream agent bootstrapped\n' "$start_db"
        elif "$LAUNCHCTL_BIN" list "$(litestream_label "$start_db")" >/dev/null 2>&1; then
          printf 'sqlite-backup: %s: litestream agent already loaded\n' "$start_db"
        else
          release_pressure_lock
          printf 'sqlite-backup: %s: failed to bootstrap litestream agent\n' "$start_db" >&2
          log_end "$start_db" start 1
          exit 1
        fi

        release_pressure_lock
        log_end "$start_db" start 0
        exit 0
        ;;

      clear-pressure)
        require_db "''${1:-}"
        clear_db="$1"
        clear_marker="$(pressure_marker_path "$clear_db")"

        # Convert a prior marker-write failure sentinel into a normal JSON
        # marker using fresh serialized measurements. This keeps the fallback
        # fail closed without making it permanently unrecoverable.
        if ! pressure_marker_blocks_work "$clear_db" \
          && pressure_failure_blocks_work "$clear_db"; then
          if pressure_guard "$clear_db"; then
            :
          else
            clear_repair_status=$?
            if [ "$clear_repair_status" -ne 10 ]; then
              printf 'sqlite-backup: %s: could not repair failed pressure marker state\n' \
                "$clear_db" >&2
              exit 1
            fi
          fi
        fi

        log_start "$clear_db" clear-pressure

        if ! has_pressure_marker "$clear_db"; then
          printf 'sqlite-backup: %s: no disk-pressure halt is active\n' "$clear_db"
          log_end "$clear_db" clear-pressure 0
          exit 0
        fi

        if ! acquire_pressure_lock "$clear_db"; then
          printf 'sqlite-backup: %s: another pressure-state transition is active; marker preserved\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        if [ ! -f "$clear_marker" ] || [ -L "$clear_marker" ]; then
          printf 'sqlite-backup: %s: pressure marker is invalid; refusing to clear %s\n' \
            "$clear_db" "$clear_marker" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        clear_snapshot="$PRESSURE_LOCK_DIR/marker.json"
        if ! cp -- "$clear_marker" "$clear_snapshot" 2>/dev/null \
          || ! validate_pressure_marker "$clear_db" "$clear_snapshot"; then
          printf 'sqlite-backup: %s: pressure marker is invalid; refusing to clear %s\n' \
            "$clear_db" "$clear_marker" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi
        if ! clear_marker_version="$(jq -cS . "$clear_snapshot" 2>/dev/null)"; then
          printf 'sqlite-backup: %s: pressure marker changed before validation completed; marker preserved\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        clear_filesystem_path="$(jq -r '.measurement.filesystemPath' "$clear_snapshot")"
        clear_minimum_available="$(jq -r '.configuredLimits.minimumFilesystemAvailableBytes' "$clear_snapshot")"
        clear_maximum_managed="$(jq -r '.configuredLimits.maximumManagedLocalBytes' "$clear_snapshot")"

        if ! clear_available="$(measure_filesystem_available_bytes "$clear_filesystem_path")"; then
          printf 'sqlite-backup: %s: could not measure filesystem available bytes at %s; pressure marker preserved\n' \
            "$clear_db" "$clear_filesystem_path" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi
        if ! clear_managed="$(measure_managed_local_bytes "$clear_snapshot")"; then
          printf 'sqlite-backup: %s: could not measure managed local bytes; pressure marker preserved\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        printf 'sqlite-backup: %s: pressure check filesystem-available=%s minimum=%s managed-local=%s maximum=%s\n' \
          "$clear_db" "$clear_available" "$clear_minimum_available" \
          "$clear_managed" "$clear_maximum_managed"

        clear_unhealthy=0
        if [ "$clear_available" -lt "$clear_minimum_available" ]; then
          printf 'sqlite-backup: %s: filesystem available bytes %s below minimum %s\n' \
            "$clear_db" "$clear_available" "$clear_minimum_available" >&2
          clear_unhealthy=1
        fi
        if [ "$clear_managed" -gt "$clear_maximum_managed" ]; then
          printf 'sqlite-backup: %s: managed local bytes %s above maximum %s\n' \
            "$clear_db" "$clear_managed" "$clear_maximum_managed" >&2
          clear_unhealthy=1
        fi
        if [ "$clear_unhealthy" -ne 0 ]; then
          printf 'sqlite-backup: %s: pressure marker preserved at %s\n' \
            "$clear_db" "$clear_marker" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        if [ ! -f "$clear_marker" ] || [ -L "$clear_marker" ] \
          || ! clear_current_version="$(jq -cS . "$clear_marker" 2>/dev/null)"; then
          # A non-cooperating concurrent writer may have removed the marker.
          # Restore the validated version when the path is provably absent;
          # otherwise the inaccessible/replacement state remains authoritative.
          if path_is_confirmed_missing "$clear_marker"; then
            clear_restore_tmp="$clear_marker.recover.$$"
            printf '%s\n' "$clear_marker_version" >"$clear_restore_tmp"
            mv -f -- "$clear_restore_tmp" "$clear_marker"
          fi
          printf 'sqlite-backup: %s: pressure marker changed during validation; marker preserved\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi
        if [ "$clear_current_version" != "$clear_marker_version" ]; then
          printf 'sqlite-backup: %s: pressure marker changed during validation; marker preserved\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        if ! clear_pressure_failure "$clear_db"; then
          printf 'sqlite-backup: %s: failed pressure-state sentinel could not be cleared\n' \
            "$clear_db" >&2
          log_end "$clear_db" clear-pressure 1
          exit 1
        fi

        rm -f -- "$clear_marker"
        release_pressure_lock
        printf 'sqlite-backup: %s: pressure halt cleared; pipeline remains stopped\n' "$clear_db"
        printf 'sqlite-backup: %s: start explicitly with: sqlite-backup start %s\n' \
          "$clear_db" "$clear_db"
        log_end "$clear_db" clear-pressure 0
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

      __litestream-trigger)
        require_db "''${1:-}"
        litestream_trigger "$1"
        ;;

      __pressure-guard)
        require_db "''${1:-}"
        if pressure_guard "$1"; then
          exit 0
        else
          pressure_guard_status=$?
          if [ "$pressure_guard_status" -eq 10 ]; then
            exit 0
          fi
          exit 1
        fi
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
