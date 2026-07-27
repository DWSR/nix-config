#!/usr/bin/env bash

set -euo pipefail

expected_host="ShopifyLaptop"
role="shopify"
label="org.nixos.local-binary-cache-publisher"
plist="/Library/LaunchDaemons/$label.plist"
pending_directory="/var/db/local-binary-cache/publisher/pending"
publisher_log="/var/log/local-binary-cache/publisher/stderr.log"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_directory/../.." && pwd -P)"
next_script="$script_directory/04-personal-consumer.sh"

fail() {
  printf '03-shopify-producer: %s\n' "$1" >&2
  exit 1
}

publisher_loaded() {
  launchctl print "system/$label" >/dev/null 2>&1
}

restore_publisher() {
  if ! publisher_loaded; then
    sudo launchctl bootstrap system "$plist"
  fi
}

cleanup() {
  restore_publisher
}

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
[[ $# -eq 0 ]] || fail "usage: $0"

cd "$repo_root"
sudo -v
/run/current-system/sw/bin/local-binary-cache-status

hook="$(nix config show post-build-hook)"
[[ -x "$hook" ]] || fail "effective post-build hook is unavailable: $hook"
[[ "$(nix config show require-sigs)" == true ]] \
  || fail "Nix signature verification is not required"
case " $(nix config show substituters) " in
  *" $endpoint "*) ;;
  *) fail "local cache substituter is not effective" ;;
esac

publisher_loaded || fail "publisher launchd job is not loaded"
sudo test -d "$pending_directory" \
  || fail "pending directory is unavailable: $pending_directory"

trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
sudo launchctl bootout system "$plist"

nonce="$role-$(/usr/bin/uuidgen | /usr/bin/tr '[:upper:]' '[:lower:]')"
expression="let
  flake = builtins.getFlake \"path:$repo_root\";
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
in pkgs.runCommand \"local-binary-cache-smoke-$nonce\" {}
  \"printf %s $nonce > \$out\""

output="$(nix build --no-link --print-out-paths --impure --expr "$expression")"
store_name="${output#/nix/store/}"
root_id="${store_name%%-*}"
[[ "$output" == /nix/store/* && "$root_id" =~ ^[0-9abcdfghijklmnpqrsvwxyz]{32}$ ]] \
  || fail "build returned an invalid store path: $output"

pending_root="$pending_directory/$root_id"
sudo test -L "$pending_root" \
  || fail "build did not create pending root: $pending_root"
[[ "$(sudo readlink "$pending_root")" == "$output" ]] \
  || fail "pending root does not target $output"
printf 'pending-root=%s target=%s\n' "$pending_root" "$output"

restore_publisher
trap - EXIT HUP INT TERM

attempt=0
while sudo test -L "$pending_root" && (( attempt < 90 )); do
  sleep 2
  (( attempt += 1 ))
done
if sudo test -L "$pending_root"; then
  sudo /usr/bin/tail -n 50 "$publisher_log" >&2
  fail "publisher did not remove $pending_root within 180 seconds"
fi

sudo /usr/bin/grep -F \
  "published $output from pending root $pending_root" \
  "$publisher_log"
/usr/bin/curl --disable --fail --silent --show-error \
  --cacert "$repo_root/certificates/local-binary-cache/ca.pem" \
  "$endpoint/$root_id.narinfo" >/dev/null

# The first scan can remove the dangling auto GC root while still considering
# its target live. Retry the same exact-path deletion after that stale root is
# gone; any other live root still makes the second attempt fail closed.
if ! sudo nix-store --delete "$output"; then
  sudo nix-store --delete "$output"
fi
[[ ! -e "$output" ]] || fail "producer output remains in the local store: $output"

printf 'OUT=%s\nNONCE=%s\n' "$output" "$nonce"
printf 'Next on Brandons-MacBook-Pro: %s %s %s\n' "$next_script" "$output" "$nonce"
