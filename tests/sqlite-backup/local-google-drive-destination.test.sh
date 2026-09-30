#!/usr/bin/env bash
set -euo pipefail

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  exit 1
}

work="$TMPDIR/sqlite-backup-local-google-drive"
rm -rf -- "$work"
mkdir -p "$work/cache" "$work/home" "$work/source-data"
touch "$work/source-data/payload" "$work/rclone.conf"

export HOME="$work/home"
export RCLONE_CONFIG="$work/rclone.conf"
export RESTIC_PASSWORD=fixture-password
export RESTIC_FROM_PASSWORD=fixture-password
export XDG_CACHE_HOME="$work/cache"

local_root="$(jq -r '.localGoogleDriveRoot' "$SQLITE_BACKUP_LOCAL_RENDER")"
local_manifest_path="$(jq -r '.manifestPath' "$SQLITE_BACKUP_LOCAL_RENDER")"
jq -e '
  (.agentNames | length) == 4
  and (.agentNames | index("sqlite-backup-guard-fixture") != null)
' "$SQLITE_BACKUP_LOCAL_RENDER" >/dev/null
jq -e --arg root "$local_root" '
  .rcloneConfigDestinations == {}
  and .rcloneDestinations[":local"].type == "local"
  and (.databases | length) == 1
  and .databases[0].name == "fixture"
  and .databases[0].remote == ":local"
  and .databases[0].remotePath == $root
  and (.databases[0].pressureGuard.managedPaths | index($root + "/fixture") != null)
' "$local_manifest_path" >/dev/null

actual_target="$("$SQLITE_BACKUP_LOCAL_CLI" __destination-target fixture)"
expected_target=":local:$local_root/fixture"
[ "$actual_target" = "$expected_target" ] \
  || fail "local destination target mismatch: $actual_target"

source_repo="$work/source-repo"
drive_root="$work/Google Drive/My Drive/sqlite-backup"
remote_repo="rclone::local:$drive_root/fixture"

restic -r "$source_repo" init >"$work/source-init.out"
restic -r "$source_repo" backup "$work/source-data" >"$work/source-backup.out"
restic init \
  --copy-chunker-params \
  --from-repo "$source_repo" \
  --repo "$remote_repo" \
  >"$work/destination-init.out"
restic copy \
  --from-repo "$source_repo" \
  --repo "$remote_repo" \
  >"$work/copy.out"

snapshots="$(restic -r "$remote_repo" snapshots --json)"
jq -e 'length == 1' <<<"$snapshots" >/dev/null
test -d "$drive_root/fixture" \
  || fail "synthetic local backend did not create the Drive-folder repository"

printf 'sqlite-backup local Google Drive destination test passed\n'
