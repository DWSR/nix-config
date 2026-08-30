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

expect_failure() {
  local output="$1"
  shift
  if "$@" >"$output" 2>&1; then
    fail "expected command to fail: $*"
  fi
}

work="$TMPDIR/sqlite-backup-persistent-halts"
rm -rf -- "$work"
mkdir -p "$work/bin" "$work/home/Library/LaunchAgents" "$work/managed" "$work/state/sqlite-backup"

export HOME="$work/home"
export XDG_STATE_HOME="$work/state"
export TMPDIR="$work/tmp"
mkdir -p "$TMPDIR"

export LAUNCHCTL_LOG="$work/launchctl.log"
export LAUNCHCTL_STATE="$work/launchctl-loaded"
touch "$LAUNCHCTL_LOG" "$LAUNCHCTL_STATE"

cat >"$work/bin/launchctl" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$LAUNCHCTL_LOG"
case "${1:-}" in
  list)
    test -f "$LAUNCHCTL_STATE"
    ;;
  bootout)
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
STUB

cat >"$work/bin/du" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [ "${TEST_DU_FAIL:-0}" = "1" ]; then
  exit 1
fi
if [ "${TEST_DU_REPLACE_MARKER:-0}" = "1" ]; then
  cp "$TEST_DU_REPLACEMENT" "$TEST_PRESSURE_MARKER"
fi
printf '%s\t%s\n' "$TEST_MANAGED_KIB" "${*: -1}"
STUB

chmod +x "$work/bin/launchctl" "$work/bin/df" "$work/bin/du"

export SQLITE_BACKUP_LAUNCHCTL_BIN="$work/bin/launchctl"
export SQLITE_BACKUP_DF_BIN="$work/bin/df"
export SQLITE_BACKUP_DU_BIN="$work/bin/du"
export TEST_AVAILABLE_KIB=100
export TEST_MANAGED_KIB=100

plist="$HOME/Library/LaunchAgents/dev.dwsr.sqlite-backup.litestream.fixture.plist"
touch "$plist"

# Existing manual stop/start behavior remains intact and uses only the stubbed
# launchctl domain. A second start is idempotent while the agent is loaded.
"$SQLITE_BACKUP_CLI" stop fixture --include-archive >"$work/manual-stop.out"
test "$(cat "$XDG_STATE_HOME/sqlite-backup/halt-fixture.flag")" = "whole-pipeline"
test ! -f "$LAUNCHCTL_STATE" || fail "manual stop did not unload the fixture agent"

"$SQLITE_BACKUP_CLI" start fixture >"$work/manual-start.out"
test ! -e "$XDG_STATE_HOME/sqlite-backup/halt-fixture.flag"
test -f "$LAUNCHCTL_STATE" || fail "manual start did not load the fixture agent"

before_idempotent_start="$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG" || true)"
"$SQLITE_BACKUP_CLI" start fixture >"$work/manual-start-idempotent.out"
after_idempotent_start="$(grep -c '^bootstrap ' "$LAUNCHCTL_LOG" || true)"
test "$before_idempotent_start" = "$after_idempotent_start" \
  || fail "already-running start unexpectedly bootstrapped the agent"
assert_contains "$work/manual-start-idempotent.out" "already running"

pressure_marker="$XDG_STATE_HOME/sqlite-backup/pressure-fixture.json"
write_pressure_marker() {
  jq -n \
    --arg database fixture \
    --arg filesystemPath "$work" \
    --arg managedPath "$work/managed" \
    '{
      schemaVersion: 1,
      database: $database,
      haltReason: "disk-pressure",
      trigger: "maximum-managed-local-bytes",
      observedBytes: {
        filesystemAvailable: 101376,
        managedLocal: 103424
      },
      configuredLimits: {
        minimumFilesystemAvailableBytes: 102400,
        maximumManagedLocalBytes: 102400
      },
      measurement: {
        filesystemPath: $filesystemPath,
        managedPaths: [$managedPath]
      },
      timestamp: "2026-08-29T12:00:00Z"
    }' >"$pressure_marker"
}

write_pressure_marker
cp "$pressure_marker" "$work/pressure-before-activation.json"
printf 'whole-pipeline' >"$XDG_STATE_HOME/sqlite-backup/halt-fixture.flag"

# Execute the real HM activation DAG fragment against the temporary state
# fixture. Only its rendered absolute state-home prefix is relocated.
activation="$(cat "$SQLITE_BACKUP_ACTIVATION")"
activation="${activation//$SQLITE_BACKUP_ACTIVATION_STATE_HOME/$XDG_STATE_HOME}"
verboseEcho() { :; }
run() { "$@"; }
eval "$activation"

test ! -e "$XDG_STATE_HOME/sqlite-backup/halt-fixture.flag" \
  || fail "activation did not clear the manual halt"
cmp "$work/pressure-before-activation.json" "$pressure_marker" \
  || fail "activation modified or removed the pressure marker"

# Model the pressure guard having unloaded Litestream. start must refuse and
# must not invoke launchctl while the persistent marker exists.
rm -f -- "$LAUNCHCTL_STATE"
: >"$LAUNCHCTL_LOG"
expect_failure "$work/pressure-start.out" "$SQLITE_BACKUP_CLI" start fixture
assert_contains "$work/pressure-start.out" "sqlite-backup clear-pressure fixture"
test -f "$pressure_marker" || fail "start removed the pressure marker"
test ! -s "$LAUNCHCTL_LOG" || fail "pressure-blocked start invoked launchctl"

# Pressure state is structured in status, and every backup entry point skips
# before taking the per-database lock or doing restic work.
"$SQLITE_BACKUP_CLI" status fixture >"$work/pressure-status.out"
assert_contains "$work/pressure-status.out" "replication-state: halted-disk-pressure"
assert_contains "$work/pressure-status.out" "halt-reason: disk-pressure"

for trigger in __replicate-trigger __archive-trigger backup; do
  "$SQLITE_BACKUP_CLI" "$trigger" fixture >"$work/$trigger.out"
  assert_contains "$work/$trigger.out" "disk-pressure halt"
  test ! -e "$TMPDIR/sqlite-backup-fixture.lock" \
    || fail "$trigger acquired the backup lock while pressure-halted"
done

# Inaccessible state cannot be interpreted as marker absence. Every consumer
# fails closed until the marker parent is searchable again.
chmod 000 "$XDG_STATE_HOME/sqlite-backup"
expect_failure "$work/inaccessible-state-start.out" "$SQLITE_BACKUP_CLI" start fixture
"$SQLITE_BACKUP_CLI" status fixture >"$work/inaccessible-state-status.out"
assert_contains "$work/inaccessible-state-status.out" "halt-reason: disk-pressure"
"$SQLITE_BACKUP_CLI" __archive-trigger fixture >"$work/inaccessible-state-trigger.out"
assert_contains "$work/inaccessible-state-trigger.out" "disk-pressure halt"
chmod 700 "$XDG_STATE_HOME/sqlite-backup"

# Any object at the marker path blocks work. A non-regular marker is invalid
# recovery state, not an absent halt, and clear-pressure must preserve it.
cp "$pressure_marker" "$work/valid-pressure.json"
rm -f -- "$pressure_marker"
mkdir "$pressure_marker"
expect_failure "$work/nonregular-start.out" "$SQLITE_BACKUP_CLI" start fixture
"$SQLITE_BACKUP_CLI" __archive-trigger fixture >"$work/nonregular-trigger.out"
assert_contains "$work/nonregular-trigger.out" "disk-pressure halt"
expect_failure "$work/clear-nonregular.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -d "$pressure_marker" || fail "non-regular marker was removed"
rmdir "$pressure_marker"
cp "$work/valid-pressure.json" "$pressure_marker"

# A guard replacement during measurement must win over the clear attempt. The
# CLI may remove only the exact marker version whose thresholds it measured.
jq '.timestamp = "2026-08-29T12:01:00Z" | .configuredLimits.maximumManagedLocalBytes = 0' \
  "$work/valid-pressure.json" >"$work/replacement-pressure.json"
export TEST_DU_REPLACE_MARKER=1
export TEST_DU_REPLACEMENT="$work/replacement-pressure.json"
export TEST_PRESSURE_MARKER="$pressure_marker"
expect_failure "$work/clear-concurrent-replacement.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$pressure_marker" '"timestamp": "2026-08-29T12:01:00Z"'
unset TEST_DU_REPLACE_MARKER TEST_DU_REPLACEMENT TEST_PRESSURE_MARKER
cp "$work/valid-pressure.json" "$pressure_marker"

# Required schema objects cannot be omitted merely because their child fields
# happen to evaluate as null in jq.
jq 'del(.observedBytes)' "$work/valid-pressure.json" >"$pressure_marker"
expect_failure "$work/clear-missing-observed.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-missing-observed.out" "pressure marker is invalid"
cp "$work/valid-pressure.json" "$pressure_marker"

jq 'del(.configuredLimits.maximumManagedLocalBytes)' \
  "$work/valid-pressure.json" >"$pressure_marker"
expect_failure "$work/clear-missing-child.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-missing-child.out" "pressure marker is invalid"
cp "$work/valid-pressure.json" "$pressure_marker"

# Marker integers are bounded to a range that Bash can compare exactly.
jq '.configuredLimits.maximumManagedLocalBytes = 1000000000000000000000000' \
  "$work/valid-pressure.json" >"$pressure_marker"
expect_failure "$work/clear-oversized-limit.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-oversized-limit.out" "pressure marker is invalid"
cp "$work/valid-pressure.json" "$pressure_marker"

rm -f -- "$pressure_marker"
ln -s "$work/valid-pressure.json" "$pressure_marker"
expect_failure "$work/clear-symlink.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -L "$pressure_marker" || fail "symlink marker was removed"
rm -f -- "$pressure_marker"
mkfifo "$pressure_marker"
expect_failure "$work/clear-fifo.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -p "$pressure_marker" || fail "FIFO marker was removed"
rm -f -- "$pressure_marker"
cp "$work/valid-pressure.json" "$pressure_marker"

# A missing path counts as zero, but an unsearchable ancestor must fail closed
# rather than making an inaccessible child look absent.
mkdir "$work/inaccessible"
chmod 000 "$work/inaccessible"
jq --arg path "$work/inaccessible/child" '.measurement.managedPaths = [$path]' \
  "$work/valid-pressure.json" >"$pressure_marker"
expect_failure "$work/clear-inaccessible.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-inaccessible.out" "could not measure managed local bytes"
test -f "$pressure_marker" || fail "inaccessible-path refusal removed the marker"
chmod 700 "$work/inaccessible"
cp "$work/valid-pressure.json" "$pressure_marker"

jq --arg path "$work/absent/managed" '.measurement.managedPaths = [$path]' \
  "$work/valid-pressure.json" >"$pressure_marker"
"$SQLITE_BACKUP_CLI" clear-pressure fixture >"$work/clear-missing-path.out"
test ! -e "$pressure_marker" || fail "a provably missing managed path did not count as zero"
cp "$work/valid-pressure.json" "$pressure_marker"

# clear-pressure measures both configured limits and preserves the marker if
# either current value is unhealthy.
export TEST_AVAILABLE_KIB=99
export TEST_MANAGED_KIB=100
expect_failure "$work/clear-low-space.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-low-space.out" "filesystem available bytes 101376 below minimum 102400"
test -f "$pressure_marker" || fail "low-space refusal removed the marker"

export TEST_AVAILABLE_KIB=100
export TEST_MANAGED_KIB=101
expect_failure "$work/clear-over-budget.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-over-budget.out" "managed local bytes 103424 above maximum 102400"
test -f "$pressure_marker" || fail "over-budget refusal removed the marker"

export TEST_AVAILABLE_KIB=100
export TEST_MANAGED_KIB=100
export TEST_DF_FAIL=1
expect_failure "$work/clear-df-failure.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -f "$pressure_marker" || fail "filesystem measurement failure removed the marker"
unset TEST_DF_FAIL

export TEST_DU_FAIL=1
expect_failure "$work/clear-du-failure.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
test -f "$pressure_marker" || fail "managed-byte measurement failure removed the marker"
unset TEST_DU_FAIL

export TEST_AVAILABLE_KIB=1000000000000000000000000
expect_failure "$work/clear-oversized-df.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-oversized-df.out" "could not measure filesystem available bytes"
test -f "$pressure_marker" || fail "oversized df measurement removed the marker"

export TEST_AVAILABLE_KIB=100
export TEST_MANAGED_KIB=1000000000000000000000000
expect_failure "$work/clear-oversized-du.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-oversized-du.out" "could not measure managed local bytes"
test -f "$pressure_marker" || fail "oversized du measurement removed the marker"
export TEST_MANAGED_KIB=100

printf '{"schemaVersion":1}\n' >"$pressure_marker"
expect_failure "$work/clear-malformed.out" "$SQLITE_BACKUP_CLI" clear-pressure fixture
assert_contains "$work/clear-malformed.out" "pressure marker is invalid"
test "$(cat "$pressure_marker")" = '{"schemaVersion":1}' \
  || fail "invalid-marker refusal modified the marker"
cp "$work/valid-pressure.json" "$pressure_marker"

# Equality is healthy for both floor and ceiling. Clearing is state-only: it
# does not invoke launchctl, and status remains not-running until start.
: >"$LAUNCHCTL_LOG"
"$SQLITE_BACKUP_CLI" clear-pressure fixture >"$work/clear-healthy.out"
test ! -e "$pressure_marker" || fail "healthy clear left the pressure marker"
test ! -s "$LAUNCHCTL_LOG" || fail "clear-pressure started the pipeline"

"$SQLITE_BACKUP_CLI" status fixture >"$work/cleared-status.out"
assert_contains "$work/cleared-status.out" "replication-state: not-running"
assert_contains "$work/cleared-status.out" "halt-reason: none"

"$SQLITE_BACKUP_CLI" start fixture >"$work/post-clear-start.out"
test -f "$LAUNCHCTL_STATE" || fail "explicit post-clear start did not load the fixture agent"

printf 'sqlite-backup persistent emergency halt tests passed\n'
