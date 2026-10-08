#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

assert_contains() {
  local file="$1" expected="$2"
  if ! grep -F -- "$expected" "$file" >/dev/null; then
    printf '%s\n' "--- $file ---" >&2
    printf '%s\n' "$(<"$file")" >&2
    fail "expected '$expected' in $file"
  fi
}

assert_not_contains() {
  local file="$1" unexpected="$2"
  if grep -F -- "$unexpected" "$file" >/dev/null; then
    printf '%s\n' "--- $file ---" >&2
    printf '%s\n' "$(<"$file")" >&2
    fail "did not expect '$unexpected' in $file"
  fi
}

expect_failure() {
  local output="$1"
  shift
  if "$@" >"$output" 2>&1; then
    fail "expected command to fail: $*"
  fi
}

work="$TMPDIR/sqlite-backup-pressure-guard"
rm -rf -- "$work"
mkdir -p "$work/bin" "$work/home" "$work/state/sqlite-backup" "$work/tmp"

export HOME="$work/home"
export XDG_STATE_HOME="$work/state"
export TMPDIR="$work/tmp"
export LAUNCHCTL_LOG="$work/launchctl.log"
export LAUNCHCTL_STATE="$work/launchctl-loaded"
export DU_LOG="$work/du.log"
touch "$LAUNCHCTL_LOG" "$DU_LOG" "$LAUNCHCTL_STATE"

cat >"$work/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$LAUNCHCTL_LOG"
case "${1:-}" in
  list)
    if [ "${TEST_LAUNCHCTL_LIST_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    if [ "${TEST_LAUNCHCTL_WRITE_MARKER:-0}" = "1" ]; then
      cp "$TEST_RACE_MARKER" "$TEST_PRESSURE_MARKER"
    fi
    if [ "${TEST_LAUNCHCTL_MOVE_LOCK_TO_FAILURE:-0}" = "1" ] \
      && [ -d "$TEST_PRESSURE_LOCK" ]; then
      mv -- "$TEST_PRESSURE_LOCK" "$TEST_PRESSURE_FAILED"
    fi
    if [ -f "$LAUNCHCTL_STATE" ]; then
      exit 0
    fi
    exit 113
    ;;
  bootout)
    if [ "${TEST_LAUNCHCTL_BOOTOUT_FAIL:-0}" = "1" ]; then
      exit 1
    fi
    rm -f -- "$LAUNCHCTL_STATE"
    ;;
  bootstrap | kickstart)
    touch "$LAUNCHCTL_STATE"
    ;;
esac
STUB

cat >"$work/bin/df" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_DF_FAIL:-0}" = "1" ]; then
  exit 1
fi
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n'
printf '/dev/fixture 100000 1 %s 1%% /\n' "$TEST_AVAILABLE_KIB"
if [ "${TEST_DF_MULTILINE:-0}" = "1" ]; then
  printf '/dev/extra 100000 1 1 1%% /extra\n'
fi
STUB

cat >"$work/bin/du" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
path="${*: -1}"
if [ "${TEST_DU_REAL:-0}" = "1" ]; then
  exec du "$@"
fi
if [ "${TEST_DU_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ -n "${TEST_DU_FAIL_PATH:-}" ] && [ "$path" = "$TEST_DU_FAIL_PATH" ]; then
  printf 'du: %s: Permission denied\n' "$path" >&2
  exit 1
fi
if [ -n "${TEST_DU_BLOCK_STARTED:-}" ]; then
  touch "$TEST_DU_BLOCK_STARTED"
  while [ ! -e "$TEST_DU_BLOCK_RELEASE" ]; do
    sleep 0.01
  done
fi
printf '%s\n' "$path" >>"$DU_LOG"
printf '%s\t%s\n' "$TEST_MANAGED_KIB" "$path"
if [ "${TEST_DU_MULTILINE:-0}" = "1" ]; then
  printf '1\tunexpected-extra-line\n'
fi
STUB

cat >"$work/bin/date" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_DATE_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ "${TEST_DATE_EMPTY:-0}" = "1" ]; then
  exit 0
fi
if [ "${TEST_DATE_WRITE_MARKER:-0}" = "1" ]; then
  cp "$TEST_RACE_MARKER" "$TEST_PRESSURE_MARKER"
fi
printf '2026-08-29T12:34:56Z\n'
STUB

cat >"$work/bin/mv" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_MV_FAIL:-0}" = "1" ]; then
  exit 1
fi
exec mv "$@"
STUB

cat >"$work/bin/marker-jq" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_MARKER_CONFIG_JQ_FAIL:-0}" = "1" ]; then
  exit 1
fi
exec jq "$@"
STUB

cat >"$work/bin/publish-marker-hook" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
touch "$TEST_PRESSURE_MARKER"
rmdir "$TEST_PRESSURE_LOCK"
STUB

cat >"$work/bin/fail-marker-hook" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
mkdir "$TEST_PRESSURE_LOCK"
mv -- "$TEST_PRESSURE_LOCK" "$TEST_PRESSURE_FAILED"
STUB

cat >"$work/bin/repair-marker-hook" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
touch "$TEST_PRESSURE_MARKER"
rmdir "$TEST_PRESSURE_FAILED"
STUB

chmod +x \
  "$work/bin/launchctl" \
  "$work/bin/df" \
  "$work/bin/du" \
  "$work/bin/date" \
  "$work/bin/mv" \
  "$work/bin/marker-jq" \
  "$work/bin/publish-marker-hook" \
  "$work/bin/fail-marker-hook" \
  "$work/bin/repair-marker-hook"
export SQLITE_BACKUP_LAUNCHCTL_BIN="$work/bin/launchctl"
export SQLITE_BACKUP_DF_BIN="$work/bin/df"
export SQLITE_BACKUP_DU_BIN="$work/bin/du"
export SQLITE_BACKUP_DATE_BIN="$work/bin/date"
export SQLITE_BACKUP_MARKER_MV_BIN="$work/bin/mv"
export SQLITE_BACKUP_MARKER_JQ_BIN="$work/bin/marker-jq"

# The HM module renders four agents, a periodic guard, an explicit metadata
# path in Litestream's YAML, and the exact three managed directories.
manifest_path="$(jq -r '.manifestPath' "$SQLITE_BACKUP_RENDER")"
jq -e '
  .guard.Label == "dev.dwsr.sqlite-backup.guard.fixture"
  and .guard.RunAtLoad == true
  and .guard.StartInterval == 60
  and .guard.ProgramArguments[1:] == ["__pressure-guard", "fixture"]
  and .litestream.ProgramArguments[1:] == ["__litestream-trigger", "fixture"]
  and (.agentNames | length) == 4
' "$SQLITE_BACKUP_RENDER" >/dev/null

jq -e '
  .databases[0] as $db
  | .rcloneConfigDestinations == .rcloneDestinations
  and $db.pressureGuard.minimumFilesystemAvailableBytes == 102400
  and $db.pressureGuard.maximumManagedLocalBytes == 3072
  and $db.pressureGuard.checkIntervalSeconds == 60
  and $db.pressureGuard.filesystemPath == "/"
  and $db.litestreamMetadataDir != ""
  and $db.pressureGuard.managedPaths == [
    $db.stagingDir,
    $db.repoDir,
    $db.litestreamMetadataDir
  ]
' "$manifest_path" >/dev/null

litestream_config="$(jq -r '.databases[0].litestreamConfigPath' "$manifest_path")"
metadata_dir="$(jq -r '.databases[0].litestreamMetadataDir' "$manifest_path")"
assert_contains "$litestream_config" "meta-path"
assert_contains "$litestream_config" "$metadata_dir"
if [ -n "$SQLITE_BACKUP_REAL_LITESTREAM" ]; then
  "$SQLITE_BACKUP_REAL_LITESTREAM" databases -config "$litestream_config" \
    >"$work/litestream-config.out"
  assert_contains "$work/litestream-config.out" "sqlite-backup-test.db"
fi

marker="$XDG_STATE_HOME/sqlite-backup/pressure-fixture.json"
lock="$XDG_STATE_HOME/sqlite-backup/pressure-fixture.lock"
failed="$XDG_STATE_HOME/sqlite-backup/pressure-fixture.failed"

reset_healthy() {
  rm -f -- "$marker"
  rm -rf -- "$lock"
  rm -rf -- "$failed"
  : >"$LAUNCHCTL_LOG"
  : >"$DU_LOG"
  touch "$LAUNCHCTL_STATE"
  unset \
    TEST_DATE_EMPTY \
    TEST_DATE_FAIL \
    TEST_DATE_WRITE_MARKER \
    TEST_DF_FAIL \
    TEST_DF_MULTILINE \
    TEST_DU_FAIL \
    TEST_DU_FAIL_PATH \
    TEST_DU_MULTILINE \
    TEST_DU_REAL \
    TEST_DU_BLOCK_RELEASE \
    TEST_DU_BLOCK_STARTED \
    TEST_LAUNCHCTL_BOOTOUT_FAIL \
    TEST_LAUNCHCTL_LIST_FAIL \
    TEST_LAUNCHCTL_MOVE_LOCK_TO_FAILURE \
    TEST_LAUNCHCTL_WRITE_MARKER \
    TEST_MARKER_CONFIG_JQ_FAIL \
    TEST_MV_FAIL \
    TEST_PRESSURE_FAILED \
    TEST_PRESSURE_LOCK \
    TEST_PRESSURE_MARKER \
    TEST_RACE_MARKER
  export TEST_AVAILABLE_KIB=100
  export TEST_MANAGED_KIB=1
}

# Reproduce the live ordering: a backup owns the per-database mutex, then the
# guard acquires the pressure gate and waits behind that backup. Status must
# preserve Litestream's actual state while exposing the pending transition.
reset_healthy
mkdir "$TMPDIR/sqlite-backup-fixture.lock"
"$SQLITE_BACKUP_CLI" __pressure-guard fixture >"$work/concurrent-guard.out" 2>&1 &
guard_pid=$!
while [ ! -d "$lock" ]; do
  sleep 0.01
done

test -d "$lock" || fail "guard measurement did not hold the pressure lock"
test -d "$TMPDIR/sqlite-backup-fixture.lock" || fail "backup fixture did not hold its mutex"
"$SQLITE_BACKUP_CLI" status fixture >"$work/concurrent-status.out"
assert_contains "$work/concurrent-status.out" "replication-state: running"
assert_contains "$work/concurrent-status.out" "halt-reason: none"
assert_contains "$work/concurrent-status.out" "pressure-state: transition-active"
expect_failure "$work/concurrent-start.out" "$SQLITE_BACKUP_CLI" start fixture
assert_contains "$work/concurrent-start.out" "pressure transition active"
assert_not_contains "$work/concurrent-start.out" "clear-pressure"
expect_failure "$work/concurrent-tier.out" env \
  SQLITE_BACKUP_LOCK_RETRY_ATTEMPTS=1 \
  "$SQLITE_BACKUP_CLI" __archive-trigger fixture
rmdir "$TMPDIR/sqlite-backup-fixture.lock"
wait "$guard_pid"
test ! -e "$lock" || fail "guard completion leaked the pressure lock"
test ! -e "$TMPDIR/sqlite-backup-fixture.lock" || fail "guard completion leaked the backup lock"

# Classification is one coherent snapshot. If the pressure lock becomes a
# durable failed-write sentinel during the launchctl probe, the current status
# remains transition-active; the next status observes the durable halt.
reset_healthy
mkdir "$lock"
export TEST_LAUNCHCTL_MOVE_LOCK_TO_FAILURE=1
export TEST_PRESSURE_LOCK="$lock"
export TEST_PRESSURE_FAILED="$failed"
"$SQLITE_BACKUP_CLI" status fixture >"$work/lock-to-failed-race.out"
assert_contains "$work/lock-to-failed-race.out" "replication-state: running"
assert_contains "$work/lock-to-failed-race.out" "halt-reason: none"
assert_contains "$work/lock-to-failed-race.out" "pressure-state: transition-active"
test -d "$failed" || fail "status race fixture did not move lock to failed sentinel"
unset TEST_LAUNCHCTL_MOVE_LOCK_TO_FAILURE TEST_PRESSURE_LOCK TEST_PRESSURE_FAILED
"$SQLITE_BACKUP_CLI" status fixture >"$work/failed-sentinel-status.out"
assert_contains "$work/failed-sentinel-status.out" "replication-state: halted-disk-pressure"
assert_contains "$work/failed-sentinel-status.out" "halt-reason: disk-pressure"
assert_contains "$work/failed-sentinel-status.out" "pressure-state: halted"
mkdir "$lock"
"$SQLITE_BACKUP_CLI" status fixture >"$work/failed-sentinel-repair-status.out"
assert_contains "$work/failed-sentinel-repair-status.out" "replication-state: halted-disk-pressure"
assert_contains "$work/failed-sentinel-repair-status.out" "halt-reason: disk-pressure"
assert_contains "$work/failed-sentinel-repair-status.out" "pressure-state: halted"

# Sentinel repair publishes the marker before clearing .failed while retaining
# the transition lock. Even if the first durable probe straddles that handoff,
# the observed lock must not downgrade durable state to transition-only.
reset_healthy
mkdir "$failed" "$lock"
export TEST_PRESSURE_MARKER="$marker"
export TEST_PRESSURE_FAILED="$failed"
env SQLITE_BACKUP_DURABLE_PRESSURE_PROBE_HOOK="$work/bin/repair-marker-hook" \
  "$SQLITE_BACKUP_CLI" status fixture >"$work/failed-to-marker-race.out"
assert_contains "$work/failed-to-marker-race.out" "replication-state: halted-disk-pressure"
assert_contains "$work/failed-to-marker-race.out" "halt-reason: disk-pressure"
assert_contains "$work/failed-to-marker-race.out" "pressure-state: halted"

# Marker publication precedes pressure-lock release. If those operations land
# between the first durable-state probe and the lock probe, status must recheck
# durable state rather than report a state that never existed.
reset_healthy
mkdir "$lock"
export TEST_PRESSURE_MARKER="$marker"
export TEST_PRESSURE_LOCK="$lock"
env SQLITE_BACKUP_PRESSURE_STATE_PROBE_HOOK="$work/bin/publish-marker-hook" \
  "$SQLITE_BACKUP_CLI" status fixture >"$work/publish-marker-race.out"
assert_contains "$work/publish-marker-race.out" "replication-state: halted-disk-pressure"
assert_contains "$work/publish-marker-race.out" "halt-reason: disk-pressure"
assert_contains "$work/publish-marker-race.out" "pressure-state: halted"

# A guard can rename pressure lock -> failed after tier preflight. Every tier
# must detect the durable sentinel after acquiring a replacement pressure lock
# and skip before taking the backup mutex or invoking Restic.
for failed_tier in __archive-trigger __replicate-trigger backup; do
  reset_healthy
  export TEST_PRESSURE_LOCK="$lock"
  export TEST_PRESSURE_FAILED="$failed"
  env SQLITE_BACKUP_TIER_PRESSURE_PROBE_HOOK="$work/bin/fail-marker-hook" \
    "$SQLITE_BACKUP_CLI" "$failed_tier" fixture >"$work/$failed_tier-failed-race.out"
  assert_contains "$work/$failed_tier-failed-race.out" "disk-pressure halt"
  test -d "$failed" || fail "$failed_tier lost the failed-write sentinel"
  test ! -e "$TMPDIR/sqlite-backup-fixture.lock" \
    || fail "$failed_tier acquired the backup mutex after failed-marker state"
done

# A healthy tier reaches the post-gate path and then fails on the intentionally
# unwritable fixture repository. The shared EXIT trap must still release the
# backup lock after the pressure lock has already been released.
reset_healthy
expect_failure "$work/healthy-tier-late-failure.out" "$SQLITE_BACKUP_CLI" __archive-trigger fixture
test ! -e "$lock" || fail "late tier failure leaked the pressure lock"
test ! -e "$TMPDIR/sqlite-backup-fixture.lock" || fail "late tier failure leaked the backup lock"

# Equality at both limits is healthy. All existing managed paths are counted,
# the missing fourth path contributes zero, and no state is mutated.
reset_healthy
"$SQLITE_BACKUP_CLI" __pressure-guard fixture >"$work/healthy.out"
test ! -e "$marker" || fail "healthy guard wrote a pressure marker"
test ! -e "$lock" || fail "healthy guard left a transition lock"
test -f "$LAUNCHCTL_STATE" || fail "healthy guard unloaded Litestream"
test ! -s "$LAUNCHCTL_LOG" || fail "healthy guard invoked launchctl"
test "$(wc -l <"$DU_LOG")" = 3 || fail "guard did not measure exactly three existing managed paths"
assert_contains "$work/healthy.out" "filesystem-available=102400 minimum=102400"
assert_contains "$work/healthy.out" "managed-local=3072 maximum=3072"

# A managed root may itself be a symlink (for example, an XDG data root moved
# to another volume). Account the target's physical allocation rather than the
# symlink inode, which GNU du otherwise reports as zero for a command-line arg.
reset_healthy
test -L "$SQLITE_BACKUP_MANAGED_SYMLINK" \
  || fail "managed-path symlink fixture is not a symlink"
export TEST_DU_REAL=1
"$SQLITE_BACKUP_CLI_MANAGED_SYMLINK" __pressure-guard fixture \
  >"$work/managed-symlink.out"
test -f "$marker" || fail "managed symlink target allocation was not counted"
jq -e '
  .trigger == "maximum-managed-local-bytes"
  and .observedBytes.managedLocal > 0
  and .configuredLimits.maximumManagedLocalBytes == 0
' "$marker" >/dev/null

# The alternate manifests put the same observations exactly one byte below and
# above each configured boundary.
reset_healthy
"$SQLITE_BACKUP_CLI_BELOW_BOUNDARY" __pressure-guard fixture \
  >"$work/one-byte-below.out"
jq -e '
  .trigger == "minimum-filesystem-available-bytes"
  and .observedBytes.filesystemAvailable == 102400
  and .configuredLimits.minimumFilesystemAvailableBytes == 102401
  and .observedBytes.managedLocal == 3072
  and .configuredLimits.maximumManagedLocalBytes == 3073
' "$marker" >/dev/null

reset_healthy
"$SQLITE_BACKUP_CLI_ABOVE_BOUNDARY" __pressure-guard fixture \
  >"$work/one-byte-above.out"
jq -e '
  .trigger == "maximum-managed-local-bytes"
  and .observedBytes.filesystemAvailable == 102400
  and .configuredLimits.minimumFilesystemAvailableBytes == 102399
  and .observedBytes.managedLocal == 3072
  and .configuredLimits.maximumManagedLocalBytes == 3071
' "$marker" >/dev/null

# One KiB below the free-space floor trips; exact and plus-one were healthy.
reset_healthy
export TEST_AVAILABLE_KIB=99
"$SQLITE_BACKUP_CLI" __pressure-guard fixture >"$work/free-space-trip.out"
test -f "$marker" || fail "free-space violation did not write a marker"
test ! -f "$LAUNCHCTL_STATE" || fail "free-space violation did not unload Litestream"
test ! -e "$lock" || fail "free-space violation left a transition lock"
test "$(stat -c %a "$marker")" = 600 || fail "pressure marker permissions are not 0600"
assert_contains "$LAUNCHCTL_LOG" "dev.dwsr.sqlite-backup.litestream.fixture"
test "$(grep -c '^bootout ' "$LAUNCHCTL_LOG")" = 1 \
  || fail "pressure guard unloaded more than one Litestream label"
test ! -e "$XDG_STATE_HOME/sqlite-backup/pressure-other.json" \
  || fail "fixture pressure guard mutated the other database"
jq -e '
  .schemaVersion == 1
  and .database == "fixture"
  and .haltReason == "disk-pressure"
  and .trigger == "minimum-filesystem-available-bytes"
  and .observedBytes.filesystemAvailable == 101376
  and .observedBytes.managedLocal == 3072
  and .configuredLimits.minimumFilesystemAvailableBytes == 102400
  and .configuredLimits.maximumManagedLocalBytes == 3072
  and .timestamp == "2026-08-29T12:34:56Z"
' "$marker" >/dev/null
cp "$marker" "$work/race-marker.json"

# One KiB per path above the managed ceiling trips; free space above its floor
# does not mask the violation.
reset_healthy
export TEST_AVAILABLE_KIB=101
export TEST_MANAGED_KIB=2
"$SQLITE_BACKUP_CLI" __pressure-guard fixture >"$work/managed-trip.out"
jq -e '
  .trigger == "maximum-managed-local-bytes"
  and .observedBytes.filesystemAvailable == 103424
  and .observedBytes.managedLocal == 6144
' "$marker" >/dev/null
test ! -f "$LAUNCHCTL_STATE" || fail "managed-byte violation did not unload Litestream"

# Measurement errors create an emergency marker, unload Litestream, and return
# non-zero with the unavailable observation represented as null.
reset_healthy
export TEST_DF_FAIL=1
expect_failure "$work/df-error.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
jq -e '
  .trigger == "measurement-error"
  and .observedBytes.filesystemAvailable == null
  and .observedBytes.managedLocal == 3072
' "$marker" >/dev/null
assert_contains "$work/df-error.out" "filesystem measurement failed"
test ! -f "$LAUNCHCTL_STATE" || fail "measurement error did not unload Litestream"

reset_healthy
export TEST_DU_FAIL=1
expect_failure "$work/du-error.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
jq -e '
  .trigger == "measurement-error"
  and .observedBytes.filesystemAvailable == 102400
  and .observedBytes.managedLocal == null
' "$marker" >/dev/null
assert_contains "$work/du-error.out" "managed-byte measurement failed"

# An inaccessible managed path names both the path and the failing measurement
# while still persisting the marker and unloading the affected agent.
reset_healthy
export TEST_DU_FAIL_PATH=/var
expect_failure "$work/du-inaccessible.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
assert_contains "$work/du-inaccessible.out" "managed path /var"
assert_contains "$work/du-inaccessible.out" "Permission denied"
jq -e '
  .trigger == "measurement-error"
  and .observedBytes.managedLocal == null
' "$marker" >/dev/null
test ! -f "$LAUNCHCTL_STATE" || fail "inaccessible managed path did not unload Litestream"

reset_healthy
export TEST_AVAILABLE_KIB=99
export TEST_LAUNCHCTL_BOOTOUT_FAIL=1
expect_failure "$work/launchctl-error.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
test -f "$marker" || fail "launchctl failure lost the pressure marker"
test -f "$LAUNCHCTL_STATE" || fail "launchctl failure unexpectedly changed loaded state"
assert_contains "$work/launchctl-error.out" "could not unload Litestream"

reset_healthy
export TEST_AVAILABLE_KIB=99
export TEST_LAUNCHCTL_BOOTOUT_FAIL=1
export TEST_LAUNCHCTL_LIST_FAIL=1
expect_failure "$work/launchctl-all-fail.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
assert_contains "$work/launchctl-all-fail.out" "could not unload Litestream"

# Malformed command output is a measurement error, not a partial value.
reset_healthy
export TEST_DU_MULTILINE=1
expect_failure "$work/du-malformed.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
assert_contains "$work/du-malformed.out" "managed-byte measurement failed"

reset_healthy
export TEST_DF_MULTILINE=1
expect_failure "$work/df-malformed.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
assert_contains "$work/df-malformed.out" "filesystem measurement failed"

# A failed atomic rename leaves the pressure lock as a durable blocking
# sentinel, so start and future backup work remain fail closed.
reset_healthy
export TEST_AVAILABLE_KIB=99
export TEST_MV_FAIL=1
expect_failure "$work/marker-write-fail.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
test ! -e "$marker" || fail "failed marker rename unexpectedly created the canonical marker"
test ! -e "$lock" || fail "failed marker rename left a transient lock"
test -d "$failed" || fail "failed marker rename did not preserve a blocking sentinel"
expect_failure "$work/sentinel-start.out" "$SQLITE_BACKUP_CLI" start fixture
unset TEST_MV_FAIL
expect_failure "$work/sentinel-repair-unhealthy.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -f "$marker" || fail "clear-pressure did not repair the failed-write sentinel"
test ! -e "$failed" || fail "successful marker repair left the failed-write sentinel"
export TEST_AVAILABLE_KIB=100
"$SQLITE_BACKUP_CLI" clear-pressure fixture >"$work/sentinel-clear-healthy.out"
test ! -e "$marker" || fail "healthy clear did not remove the repaired marker"

# Timestamp generation is part of the atomic marker transition. Both an empty
# result and a failing date command must leave durable fail-closed state rather
# than releasing every pressure sentinel.
for date_mode in TEST_DATE_EMPTY TEST_DATE_FAIL; do
  reset_healthy
  export TEST_AVAILABLE_KIB=99
  export "$date_mode=1"
  expect_failure "$work/$date_mode.out" "$SQLITE_BACKUP_CLI" __pressure-guard fixture
  unset "$date_mode"
  test ! -e "$marker" || fail "$date_mode unexpectedly wrote the canonical marker"
  test -d "$failed" || fail "$date_mode did not preserve a blocking sentinel"
  : >"$LAUNCHCTL_LOG"
  expect_failure "$work/$date_mode-start.out" "$SQLITE_BACKUP_CLI" start fixture
  assert_contains "$work/$date_mode-start.out" "sqlite-backup clear-pressure fixture"
  test ! -s "$LAUNCHCTL_LOG" || fail "$date_mode pressure-blocked start invoked launchctl"
done

# A marker-configuration read failure occurs after measurements and must use
# the same durable fallback as timestamp/render/rename failures.
reset_healthy
export TEST_AVAILABLE_KIB=99
export TEST_MARKER_CONFIG_JQ_FAIL=1
expect_failure "$work/marker-config-read-fail.out" \
  "$SQLITE_BACKUP_CLI" __pressure-guard fixture
unset TEST_MARKER_CONFIG_JQ_FAIL
test ! -e "$marker" || fail "marker config read failure wrote a canonical marker"
test -d "$failed" || fail "marker config read failure did not preserve a blocking sentinel"
assert_contains "$work/marker-config-read-fail.out" "could not read marker configuration"
: >"$LAUNCHCTL_LOG"
expect_failure "$work/marker-config-read-start.out" "$SQLITE_BACKUP_CLI" start fixture
assert_contains "$work/marker-config-read-start.out" "sqlite-backup clear-pressure fixture"
test ! -s "$LAUNCHCTL_LOG" || fail "marker config failure allowed start to invoke launchctl"

# A marker appearing after preflight but before backup-lock acquisition is
# caught by the pressure gate. The adversarial writer intentionally ignores the
# lock to verify the final defensive check.
reset_healthy
export TEST_DATE_WRITE_MARKER=1
export TEST_RACE_MARKER="$work/race-marker.json"
export TEST_PRESSURE_MARKER="$marker"
"$SQLITE_BACKUP_CLI" __archive-trigger fixture >"$work/archive-race.out"
test -f "$marker" || fail "archive race did not leave the concurrent marker"
test ! -e "$TMPDIR/sqlite-backup-fixture.lock" || fail "archive acquired its lock after marker creation"

# A marker appearing during start's launchctl probe is rechecked before
# bootstrap, and a pre-existing marker gates the Litestream RunAtLoad wrapper.
reset_healthy
rm -f -- "$LAUNCHCTL_STATE"
mkdir -p "$HOME/Library/LaunchAgents"
touch "$HOME/Library/LaunchAgents/dev.dwsr.sqlite-backup.litestream.fixture.plist"
export TEST_LAUNCHCTL_WRITE_MARKER=1
export TEST_RACE_MARKER="$work/race-marker.json"
export TEST_PRESSURE_MARKER="$marker"
expect_failure "$work/start-race.out" "$SQLITE_BACKUP_CLI" start fixture
test ! -f "$LAUNCHCTL_STATE" || fail "start loaded Litestream after concurrent marker creation"
if grep -q '^bootstrap ' "$LAUNCHCTL_LOG"; then
  fail "start invoked bootstrap after concurrent marker creation"
fi

reset_healthy
cp "$work/race-marker.json" "$marker"
expect_failure "$work/litestream-marker-gate.out" "$SQLITE_BACKUP_CLI" __litestream-trigger fixture
test ! -f "$LAUNCHCTL_STATE" || fail "Litestream wrapper remained loaded with an active marker"

touch "$work/not-a-directory"
expect_failure "$work/start-log-failure.out" env \
  SQLITE_BACKUP_LOG_DIR="$work/not-a-directory/Logs" \
  "$SQLITE_BACKUP_CLI" start fixture
assert_contains "$work/start-log-failure.out" "sqlite-backup clear-pressure fixture"

# Guard enforcement precedes CLI log writes. Even an unusable log path cannot
# prevent a threshold violation from persisting and unloading Litestream.
reset_healthy
export TEST_AVAILABLE_KIB=99
SQLITE_BACKUP_LOG_DIR="$work/not-a-directory/Logs" \
  "$SQLITE_BACKUP_CLI" __archive-trigger fixture >"$work/log-failure-preflight.out" 2>&1
test -f "$marker" || fail "log failure bypassed pressure marker persistence"
test ! -f "$LAUNCHCTL_STATE" || fail "log failure bypassed Litestream unload"

# Scheduled work executes the same guard before taking the backup lock. A new
# violation writes the marker and stops before any restic operation can begin.
reset_healthy
export TEST_AVAILABLE_KIB=99
"$SQLITE_BACKUP_CLI" __archive-trigger fixture >"$work/archive-preflight.out"
test -f "$marker" || fail "archive preflight did not persist the pressure halt"
test ! -e "$TMPDIR/sqlite-backup-fixture.lock" || fail "archive preflight acquired the backup lock"
test ! -f "$LAUNCHCTL_STATE" || fail "archive preflight did not unload Litestream"
assert_contains "$work/archive-preflight.out" "minimum-filesystem-available-bytes"

printf 'sqlite-backup disk-pressure guard tests passed\n'
