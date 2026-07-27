#!/usr/bin/env bash

set -euo pipefail

expected_host="ShopifyLaptop"
endpoint="https://Brandons-MacBook-Pro.local:8443/darwin"
script_directory="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
next_script="$script_directory/03-shopify-producer.sh"

fail() {
  printf '02-shopify-consumer: %s\n' "$1" >&2
  exit 1
}

cleanup() {
  rm -f "$trace"
}

[[ "$(/usr/sbin/scutil --get LocalHostName)" == "$expected_host" ]] \
  || fail "must run on $expected_host"
[[ $# -eq 2 ]] || fail "usage: $0 OUT NONCE"

output="$1"
nonce="$2"
[[ "$output" =~ ^/nix/store/[0-9abcdfghijklmnpqrsvwxyz]{32}- ]] \
  || fail "invalid producer store path: $output"
[[ "$nonce" == personal-* ]] || fail "expected a personal producer nonce"
[[ ! -e "$output" ]] || fail "consumer already has $output"

/run/current-system/sw/bin/local-binary-cache-status
[[ "$(nix config show require-sigs)" == true ]] \
  || fail "Nix signature verification is not required"
case " $(nix config show substituters) " in
  *" $endpoint "*) ;;
  *) fail "local cache substituter is not effective" ;;
esac

trace="$(mktemp "${TMPDIR:-/tmp}/local-binary-cache-consumer.XXXXXX")"
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

nix-store -v --realise "$output" 2>&1 | /usr/bin/tee "$trace"
/usr/bin/grep -F "copying path '$output' from '$endpoint'" "$trace" \
  || fail "realisation did not report the local cache as its source"
if /usr/bin/grep -F "will be built" "$trace" >/dev/null; then
  fail "consumer attempted to build the producer output"
fi
[[ "$(/bin/cat "$output")" == "$nonce" ]] \
  || fail "substituted output content does not match the producer nonce"

rm -f "$trace"
trap - EXIT HUP INT TERM
printf 'verified-substitution=%s source=%s\n' "$output" "$endpoint"
printf 'Next on ShopifyLaptop: %s\n' "$next_script"
