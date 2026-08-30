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
