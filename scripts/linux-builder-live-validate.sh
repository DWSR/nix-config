#!/usr/bin/env bash
# Task 7 live acceptance for the Linux Nix remote builder.
#
# The live path is confirmation-gated and read-only except for the explicit
# no-fallback check, which stops and restarts the linux-builder Lima instance.
# The offline modes are used by tests/linux-nix-remote-builder/live-validate.test.js
# and never contact Lima, the tailnet, or a secret store.
set -euo pipefail

builder_host="linux-builder.tuxedo-musical.ts.net"
builder_name="${LINUX_BUILDER_LIMA_NAME:-linux-builder}"
fabro_guest="${FABRO_GUEST_LIMA_NAME:-fabro}"
linux_system="aarch64-linux"
darwin_endpoint="ssh-ng://nix-builder@mac-builder.tuxedo-musical.ts.net"
darwin_system="aarch64-darwin"
linux_client_key="/run/secrets/linux-builder-client-key"
machines_file="/run/fabro-darwin-builders/machines"
lima_vmctl="${LIMA_VMCTL:-lima-vmctl}"
lima_home="${LIMA_HOME:-$HOME/.local/state/lima}"
default_results=".kiro/specs/create-a-linux-nix-remote-builder-instance/live-validation-7.md"

repo="$PWD"
pin=""
results=""
machine_record_arg=""
machine_record_profile="fabro"
pin_arg=""
client_system=""
no_fallback_host=""
confirm_live=false
builder_stopped=false
tmp_tailnet=""
tmp_machines=""
tmp_stdout=""
tmp_stderr=""

usage() {
  cat <<'USAGE'
Usage: linux-builder-live-validate [OPTIONS]

Task 7 live acceptance for the Linux Nix remote builder. Run on the personal
Mac after the design's "## Operator Provisioning" steps and both client
switches are complete.

Live mode (default; requires --confirm-live-state-changes and a TTY):
  --confirm-live-state-changes   Acknowledge that the no-fallback check stops
                                 and restarts the linux-builder Lima instance
  --repo PATH                    Repository checkout (default: current directory)
  --pin PATH                     Public host-key pin
                                 (default: certificates/linux-builder/ssh_host_ed25519_key.pub)
  --results PATH                 Evidence file
                                 (default: .kiro/specs/create-a-linux-nix-remote-builder-instance/live-validation-7.md)

Offline modes (no Lima, tailnet, or secret access):
  --check-machine-record FILE    Validate the rendered Darwin and Linux records
  --profile fabro|personal       Machine-record Darwin profile (default: fabro;
                                 use personal for the Mac's generated file)
  --check-host-key-pin FILE      Validate a single-line ssh-ed25519 pin
  --classify-unsupported-platform CLIENT_SYSTEM
                                 Read a build diagnostic on stdin; exit 0 only
                                 for a platform-mismatch rejection
  --classify-no-fallback BUILDER_HOST
                                 Read a build diagnostic on stdin; exit 0 only
                                 for a builder transport failure with local
                                 builds disabled
  --help                         Show this help

Live checks recorded: tailnet registration and tag, pinned host identity,
Fabro Linux build, personal Linux build, Darwin dispatch preservation,
unsupported platform rejection, and the no-fallback outage/recovery check.
The harness never reads a private key or a secret value.
USAGE
}

fail() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

usage_error() {
  printf 'ERROR: %s\n' "$1" >&2
  usage >&2
  exit 2
}

require_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    usage_error "$option requires a value"
  fi
}

cleanup() {
  local status
  status=$?
  trap - EXIT INT TERM HUP
  rm -f -- "$tmp_tailnet" "$tmp_machines" "$tmp_stdout" "$tmp_stderr" 2>/dev/null || true
  if [[ "$builder_stopped" == true ]]; then
    printf 'Restoring the %s Lima instance after the no-fallback check...\n' "$builder_name" >&2
    if ! try_restart_builder; then
      # shellcheck disable=SC2016 # the backticks are literal operator instructions
      printf 'MANUAL RECOVERY REQUIRED: start the builder with `launchctl kickstart gui/%s/dev.dwsr.lima-linux-builder` and confirm `lima-vmctl list %s` reports Running.\n' "$(id -u)" "$builder_name" >&2
      status=1
    fi
  fi
  exit "$status"
}

validate_ed25519_base64() {
  local value="$1"
  local label="$2"
  local decoded_size
  local decoded_type
  if [[ ! "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
    printf 'ERROR: %s is not base64: %s\n' "$label" "$value" >&2
    return 1
  fi
  if ! decoded_size="$(printf '%s' "$value" | base64 -d 2>/dev/null | wc -c | tr -d '[:space:]')"; then
    printf 'ERROR: %s is not decodable base64\n' "$label" >&2
    return 1
  fi
  if ! decoded_type="$(printf '%s' "$value" | base64 -d 2>/dev/null | od -An -tx1 -N19 | tr -d '[:space:]')"; then
    printf 'ERROR: %s is not decodable base64\n' "$label" >&2
    return 1
  fi
  if [[ "$decoded_size" != 51 || "$decoded_type" != "0000000b7373682d6564323535313900000020" ]]; then
    printf 'ERROR: %s is not a valid Ed25519 public key blob\n' "$label" >&2
    return 1
  fi
}

validate_pin() {
  local pin_path="$1"
  local line_count
  local key_type
  local key_data
  if [[ ! -f "$pin_path" || ! -r "$pin_path" || ! -s "$pin_path" ]]; then
    printf 'ERROR: host-key pin is missing, unreadable, or empty: %s\n' "$pin_path" >&2
    return 1
  fi
  line_count="$(awk 'NF { count++ } END { print count + 0 }' "$pin_path")"
  if [[ "$line_count" != 1 ]]; then
    printf 'ERROR: host-key pin must contain exactly one non-empty line: %s\n' "$pin_path" >&2
    return 1
  fi
  key_type="$(awk 'NF { print $1; exit }' "$pin_path")"
  key_data="$(awk 'NF { print $2; exit }' "$pin_path")"
  if [[ "$key_type" != "ssh-ed25519" ]]; then
    printf 'ERROR: host-key pin must be an ssh-ed25519 public key: %s\n' "$pin_path" >&2
    return 1
  fi
  validate_ed25519_base64 "$key_data" "host-key pin" || return 1
  printf 'host-key pin: %s SHA256:%s\n' "$key_type" "$(pin_fingerprint "$pin_path")"
}

pin_fingerprint() {
  local pin_path="$1"
  local key_data
  key_data="$(awk 'NF { print $2; exit }' "$pin_path")"
  printf '%s' "$key_data" | base64 -d | sha256sum | awk '{ print $1 }'
}

validate_host_key_field() {
  local value="$1"
  local label="$2"
  local decoded
  local first_line
  local key_type
  local key_data
  if [[ ! "$value" =~ ^[A-Za-z0-9+/]+={0,2}$ ]]; then
    printf 'ERROR: %s is not base64: %s\n' "$label" "$value" >&2
    return 1
  fi
  if ! decoded="$(printf '%s' "$value" | base64 -d 2>/dev/null)"; then
    printf 'ERROR: %s is not decodable base64\n' "$label" >&2
    return 1
  fi
  first_line="$(printf '%s\n' "$decoded" | awk 'NF { print; exit }')"
  key_type="$(printf '%s\n' "$first_line" | awk '{ print $1 }')"
  key_data="$(printf '%s\n' "$first_line" | awk '{ print $2 }')"
  if [[ "$key_type" != "ssh-ed25519" ]]; then
    printf 'ERROR: %s does not decode to an ssh-ed25519 public key\n' "$label" >&2
    return 1
  fi
  validate_ed25519_base64 "$key_data" "$label key data" || return 1
}

validate_machines_file() {
  local file="$1"
  local expected_profile="${2:-fabro}"
  local expected_darwin_key
  local expected_darwin_jobs
  local expected_darwin_speed
  local line_count
  local darwin_line
  local linux_line
  local -a darwin_fields
  local -a linux_fields
  case "$expected_profile" in
    fabro)
      expected_darwin_key="/run/secrets/build-client-key"
      expected_darwin_jobs="4"
      expected_darwin_speed="2"
      ;;
    personal)
      expected_darwin_key="/run/secrets/mac-builder-ssh-private-key"
      expected_darwin_jobs="8"
      expected_darwin_speed="1"
      ;;
    *)
      printf 'ERROR: unknown machine-record profile: %s\n' "$expected_profile" >&2
      return 1
      ;;
  esac
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    printf 'ERROR: machines file is missing or unreadable: %s\n' "$file" >&2
    return 1
  fi
  line_count="$(awk 'NF { count++ } END { print count + 0 }' "$file")"
  if [[ "$line_count" != 2 ]]; then
    printf 'ERROR: machines file must contain exactly two non-empty records (Darwin then Linux); found %s: %s\n' "$line_count" "$file" >&2
    return 1
  fi
  darwin_line="$(awk 'NF { print; exit }' "$file")"
  linux_line="$(awk 'NF { if (++count == 2) { print; exit } }' "$file")"
  read -r -a darwin_fields <<<"$darwin_line"
  read -r -a linux_fields <<<"$linux_line"
  if [[ "${#darwin_fields[@]}" -ne 8 ]]; then
    printf 'ERROR: Darwin machine record must have eight fields: %s\n' "$darwin_line" >&2
    return 1
  fi
  if [[ "${#linux_fields[@]}" -ne 8 ]]; then
    printf 'ERROR: Linux machine record must have eight fields: %s\n' "$linux_line" >&2
    return 1
  fi
  if [[ "${darwin_fields[0]}" != "$darwin_endpoint" || "${darwin_fields[1]}" != "$darwin_system" ]]; then
    printf 'ERROR: the Darwin machine record changed its endpoint or system: %s\n' "$darwin_line" >&2
    return 1
  fi
  if [[ "${darwin_fields[2]}" != "$expected_darwin_key" || "${darwin_fields[3]}" != "$expected_darwin_jobs" || "${darwin_fields[4]}" != "$expected_darwin_speed" || "${darwin_fields[5]}" != "-" || "${darwin_fields[6]}" != "-" ]]; then
    printf 'ERROR: the %s Darwin machine record changed its client key, job count, or speed factor: %s\n' "$expected_profile" "$darwin_line" >&2
    return 1
  fi
  if [[ "${linux_fields[0]}" != "ssh-ng://builder@$builder_host" ]]; then
    printf 'ERROR: the Linux machine record must target ssh-ng://builder@%s: %s\n' "$builder_host" "$linux_line" >&2
    return 1
  fi
  if [[ "${linux_fields[1]}" != "$linux_system" ]]; then
    printf 'ERROR: the Linux machine record must advertise only %s: %s\n' "$linux_system" "$linux_line" >&2
    return 1
  fi
  if [[ "${linux_fields[2]}" != "$linux_client_key" ]]; then
    printf 'ERROR: the Linux machine record must use the runtime client-key path %s: %s\n' "$linux_client_key" "$linux_line" >&2
    return 1
  fi
  if [[ "${linux_fields[3]}" != "4" || "${linux_fields[4]}" != "1" || "${linux_fields[5]}" != "-" || "${linux_fields[6]}" != "-" ]]; then
    printf 'ERROR: the Linux machine record must use max-jobs 4 and speed factor 1: %s\n' "$linux_line" >&2
    return 1
  fi
  validate_host_key_field "${linux_fields[7]}" "Linux machine-record host key" || return 1
  validate_host_key_field "${darwin_fields[7]}" "Darwin machine-record host key" || return 1
  printf 'machine records (%s profile): Darwin %s %s; Linux ssh-ng://builder@%s %s max-jobs=%s speed-factor=%s\n' \
    "$expected_profile" "$darwin_endpoint" "$darwin_system" "$builder_host" "$linux_system" \
    "${linux_fields[3]}" "${linux_fields[4]}"
}

classify_unsupported_platform() {
  local expected_client_system="$1"
  local diagnostic
  local lowered
  diagnostic="$(cat)"
  lowered="$(printf '%s' "$diagnostic" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lowered" != *"x86_64-linux"* ]]; then
    printf 'ERROR: diagnostic does not name the rejected x86_64-linux platform\n' >&2
    return 1
  fi
  if [[ "$lowered" != *"$expected_client_system"* ]]; then
    printf 'ERROR: diagnostic does not name the client system %s\n' "$expected_client_system" >&2
    return 1
  fi
  if [[ "$lowered" != *"platform mismatch"* && "$lowered" != *"required system"* && "$lowered" != *"required to build"* && "$lowered" != *"i am a"* && "$lowered" != *"current system"* ]]; then
    printf 'ERROR: diagnostic is not a platform-mismatch rejection\n' >&2
    return 1
  fi
  printf 'unsupported-platform rejection: x86_64-linux rejected on %s\n' "$expected_client_system"
}

classify_no_fallback() {
  local expected_builder_host="$1"
  local diagnostic
  local lowered
  diagnostic="$(cat)"
  lowered="$(printf '%s' "$diagnostic" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lowered" != *"$expected_builder_host"* && "$lowered" != *"linux-builder"* ]]; then
    printf 'ERROR: diagnostic does not name the Linux builder endpoint %s\n' "$expected_builder_host" >&2
    return 1
  fi
  if [[ "$lowered" != *"failed to start ssh connection"* && "$lowered" != *"cannot build on"* && "$lowered" != *"connection refused"* && "$lowered" != *"could not resolve hostname"* && "$lowered" != *"connection timed out"* && "$lowered" != *"remote build"* && "$lowered" != *"failed to find a machine for remote build"* ]]; then
    printf 'ERROR: diagnostic is not a builder transport or remote-build failure\n' >&2
    return 1
  fi
  if [[ "$lowered" != *"max-jobs = 0"* && "$lowered" != *"local builds are disabled"* ]]; then
    printf 'ERROR: diagnostic does not prove local builds were disabled\n' >&2
    return 1
  fi
  printf 'no-local-fallback rejection: %s was unavailable and local builds stayed disabled\n' "$expected_builder_host"
}

lima_sudo() {
  local instance="$1"
  shift
  LIMA_HOME="$lima_home" "$lima_vmctl" shell "$instance" sudo -n "$@"
}

lima_sudo_timeout() {
  local seconds="$1"
  local instance="$2"
  shift 2
  timeout "$seconds" env LIMA_HOME="$lima_home" "$lima_vmctl" shell "$instance" sudo -n "$@"
}

append_evidence() {
  printf '%s\n' "$1" >>"$results"
}

init_results() {
  mkdir -p -- "$(dirname -- "$results")"
  if [[ ! -f "$results" ]]; then
    printf '# Task 7 Live Validation\n\n' >"$results"
  fi
}

unique_name() {
  printf '%s-%s-%s' "$1" "$(date +%s)" "$$"
}

build_expression() {
  local system="$1"
  local name="$2"
  # shellcheck disable=SC2016 # $out is a Nix derivation variable, not a shell one
  printf 'derivation { name = "%s"; system = "%s"; builder = "/bin/sh"; args = [ "-c" "echo %s > $out" ]; }' \
    "$name" "$system" "$system"
}

assert_store_path() {
  local output="$1"
  local label="$2"
  if [[ ! "$output" =~ ^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$ ]]; then
    printf 'ERROR: %s did not return exactly one Nix store path: %s\n' "$label" "$output" >&2
    return 1
  fi
}

assert_no_output_path() {
  local file="$1"
  local label="$2"
  if grep -E '^/nix/store/[a-z0-9]{32}-[A-Za-z0-9+._?=-]+$' "$file" | grep -Evq '\.drv$'; then
    printf 'ERROR: %s printed an output path instead of failing without a local build\n' "$label" >&2
    return 1
  fi
}

check_tailnet() {
  local dns_name
  tmp_tailnet="$(mktemp)"
  if ! lima_sudo "$builder_name" tailscale status --json >"$tmp_tailnet"; then
    fail "could not read Tailscale status from $builder_name"
  fi
  if ! jq -e '.BackendState == "Running"' "$tmp_tailnet" >/dev/null; then
    fail "the $builder_name Tailscale backend is not Running"
  fi
  if ! jq -e '.Self.DNSName | startswith("linux-builder.")' "$tmp_tailnet" >/dev/null; then
    fail "the $builder_name Tailscale identity is not the stable linux-builder MagicDNS name"
  fi
  if ! jq -e '.Self.Tags // [] | index("tag:linux-nix-remote-builder") != null' "$tmp_tailnet" >/dev/null; then
    fail "the $builder_name Tailscale identity does not carry tag:linux-nix-remote-builder"
  fi
  dns_name="$(jq -r '.Self.DNSName' "$tmp_tailnet")"
  append_evidence "- Builder tailnet: Running as $dns_name with tag:linux-nix-remote-builder"
  rm -f -- "$tmp_tailnet"
  tmp_tailnet=""
}

check_host_key() {
  local guest_pub
  local pin_type
  local pin_data
  local guest_type
  local guest_data
  local fingerprint
  if ! validate_pin "$pin" >/dev/null; then
    fail "the pinned builder host key is unavailable at $pin; provision it from the guest (design's Operator Provisioning) before live validation"
  fi
  if ! guest_pub="$(lima_sudo "$builder_name" cat /var/lib/ssh/ssh_host_ed25519_key.pub)"; then
    fail "could not read the persistent host public key from $builder_name"
  fi
  pin_type="$(awk 'NF { print $1; exit }' "$pin")"
  pin_data="$(awk 'NF { print $2; exit }' "$pin")"
  guest_type="$(printf '%s\n' "$guest_pub" | awk 'NF { print $1; exit }')"
  guest_data="$(printf '%s\n' "$guest_pub" | awk 'NF { print $2; exit }')"
  if [[ "$pin_type" != "$guest_type" || "$pin_data" != "$guest_data" ]]; then
    fail "the pinned host key at $pin does not match $builder_name:/var/lib/ssh/ssh_host_ed25519_key.pub"
  fi
  fingerprint="$(pin_fingerprint "$pin")"
  append_evidence "- Host-key pin: SHA256:$fingerprint matches $builder_name:/var/lib/ssh/ssh_host_ed25519_key.pub"
}

check_machines() {
  local mode
  tmp_machines="$(mktemp)"
  if ! lima_sudo "$fabro_guest" cat "$machines_file" >"$tmp_machines"; then
    fail "could not read $fabro_guest:$machines_file"
  fi
  if ! mode="$(lima_sudo "$fabro_guest" stat -c '%a %U %G' "$machines_file")"; then
    fail "could not stat $fabro_guest:$machines_file"
  fi
  if [[ "$mode" != "600 root root" ]]; then
    fail "$fabro_guest:$machines_file must be mode 0600 root root; found: $mode"
  fi
  if ! validate_machines_file "$tmp_machines" fabro >/dev/null; then
    fail "$fabro_guest:$machines_file does not contain the expected Darwin and Linux records"
  fi
  append_evidence "- Fabro machines file: mode 0600 root root; Darwin and Linux records validated"
  rm -f -- "$tmp_machines"
  tmp_machines=""
}

assert_builder_output() {
  local output="$1"
  local expected="$2"
  local actual
  if ! lima_sudo "$builder_name" test -e "$output"; then
    fail "the returned output $output is absent from $builder_name's store"
  fi
  if ! actual="$(lima_sudo "$builder_name" cat "$output")"; then
    fail "could not read the returned output $output on $builder_name"
  fi
  if [[ "$actual" != "$expected" ]]; then
    fail "the returned output $output contains '$actual' instead of '$expected'"
  fi
}

run_linux_build() {
  local client="$1"
  local name="$2"
  local expression
  local output
  expression="$(build_expression "$linux_system" "$name")"
  case "$client" in
    fabro)
      if ! output="$(lima_sudo "$fabro_guest" nix build --no-link --print-out-paths --impure --option substitute false --expr "$expression")"; then
        fail "the Fabro aarch64-linux build failed; expected it to dispatch to $builder_host"
      fi
      ;;
    personal)
      if ! output="$(nix build --no-link --print-out-paths --impure --option substitute false --expr "$expression")"; then
        fail "the personal Mac aarch64-linux build failed; expected it to dispatch to $builder_host"
      fi
      ;;
    *)
      fail "unknown client: $client"
      ;;
  esac
  assert_store_path "$output" "$client Linux build" || exit 1
  assert_builder_output "$output" "$linux_system"
  append_evidence "- $client Linux build: PASS; $output returned from $builder_host"
}

run_darwin_build() {
  local expression
  local output
  expression="$(build_expression "$darwin_system" "$(unique_name "linux-builder-acceptance-darwin")")"
  if ! output="$(lima_sudo "$fabro_guest" nix build --no-link --print-out-paths --impure --option substitute false --expr "$expression")"; then
    fail "the Fabro aarch64-darwin build failed; the existing Darwin route is broken"
  fi
  assert_store_path "$output" "Fabro Darwin build" || exit 1
  append_evidence "- Darwin preservation: PASS; $output returned through $darwin_endpoint"
}

run_unsupported() {
  local client="$1"
  local expected_client_system="$2"
  local expression
  local status=0
  local name
  name="$(unique_name "linux-builder-unsupported-$client")"
  expression="$(build_expression "x86_64-linux" "$name")"
  tmp_stdout="$(mktemp)"
  tmp_stderr="$(mktemp)"
  if [[ "$client" == fabro ]]; then
    lima_sudo "$fabro_guest" nix build --no-link --impure --option substitute false --expr "$expression" >"$tmp_stdout" 2>"$tmp_stderr" || status=$?
  elif [[ "$client" == personal ]]; then
    nix build --no-link --impure --option substitute false --expr "$expression" >"$tmp_stdout" 2>"$tmp_stderr" || status=$?
  else
    fail "unknown client: $client"
  fi
  if [[ "$status" -eq 0 ]]; then
    fail "the $client x86_64-linux build unexpectedly succeeded"
  fi
  if ! assert_no_output_path "$tmp_stdout" "$client unsupported-platform build"; then
    exit 1
  fi
  if ! classify_unsupported_platform "$expected_client_system" <"$tmp_stderr" >/dev/null; then
    fail "the $client x86_64-linux failure was not a platform-mismatch rejection"
  fi
  append_evidence "- Unsupported platform ($client): PASS; x86_64-linux rejected on $expected_client_system"
  rm -f -- "$tmp_stdout" "$tmp_stderr"
  tmp_stdout=""
  tmp_stderr=""
}

try_restart_builder() {
  local label
  local elapsed=0
  label="gui/$(id -u)/dev.dwsr.lima-linux-builder"
  if ! launchctl kickstart "$label"; then
    printf 'ERROR: could not kickstart %s\n' "$label" >&2
    return 1
  fi
  while ((elapsed < 180)); do
    if timeout 15 "$lima_vmctl" shell "$builder_name" true >/dev/null 2>&1; then
      return 0
    fi
    sleep 5
    elapsed=$((elapsed + 5))
  done
  printf 'ERROR: %s did not return to a usable state within 180 seconds\n' "$builder_name" >&2
  return 1
}

run_no_fallback() {
  local name
  local expression
  local out_path
  local status=0
  name="$(unique_name "linux-builder-outage")"
  expression="$(build_expression "$linux_system" "$name")"
  if ! out_path="$(lima_sudo "$fabro_guest" nix eval --raw --impure --expr "$expression")"; then
    fail "could not evaluate the outage probe derivation on $fabro_guest"
  fi
  assert_store_path "$out_path" "outage probe" || exit 1
  if lima_sudo "$fabro_guest" test -e "$out_path"; then
    fail "the outage probe output $out_path already exists on $fabro_guest; use a fresh derivation name"
  fi
  builder_stopped=true
  if ! "$lima_vmctl" stop "$builder_name"; then
    fail "could not stop the $builder_name Lima instance for the no-fallback check"
  fi
  local stopped=0
  local elapsed=0
  while ((elapsed < 60)); do
    if ! timeout 10 "$lima_vmctl" shell "$builder_name" true >/dev/null 2>&1; then
      stopped=1
      break
    fi
    sleep 2
    elapsed=$((elapsed + 2))
  done
  if [[ "$stopped" -ne 1 ]]; then
    fail "the $builder_name instance was still reachable 60 seconds after a clean stop"
  fi
  tmp_stdout="$(mktemp)"
  tmp_stderr="$(mktemp)"
  if lima_sudo_timeout 300 "$fabro_guest" nix build --no-link --impure --option substitute false --expr "$expression" >"$tmp_stdout" 2>"$tmp_stderr"; then
    status=0
  else
    status=$?
  fi
  if [[ "$status" -eq 0 ]]; then
    fail "the Fabro aarch64-linux build succeeded while $builder_name was stopped"
  fi
  if ! assert_no_output_path "$tmp_stdout" "Fabro no-fallback build"; then
    exit 1
  fi
  if ! classify_no_fallback "$builder_host" <"$tmp_stderr" >/dev/null; then
    fail "the Fabro outage build did not fail on the Linux builder transport with local builds disabled"
  fi
  if lima_sudo "$fabro_guest" test -e "$out_path"; then
    fail "Fabro produced $out_path locally while max-jobs = 0"
  fi
  append_evidence "- No-fallback outage: PASS; $out_path stayed absent on Fabro and the build failed naming $builder_host"
  rm -f -- "$tmp_stdout" "$tmp_stderr"
  tmp_stdout=""
  tmp_stderr=""
  if ! try_restart_builder; then
    fail "the $builder_name instance did not return to Running after the outage check"
  fi
  builder_stopped=false
  append_evidence "- Builder recovery: PASS; $builder_name returned to Running"
  run_linux_build fabro "$(unique_name "linux-builder-recovery")"
}

confirm_step() {
  local prompt="$1"
  local answer
  if ! read -r -p "$prompt [y/N] " answer </dev/tty; then
    return 1
  fi
  case "$answer" in
    y|Y|yes|YES) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  while (($# > 0)); do
    case "$1" in
      --help|-h)
        usage
        exit 0
        ;;
      --check-machine-record)
        require_value "$1" "${2:-}"
        machine_record_arg="$2"
        shift 2
        ;;
      --profile)
        require_value "$1" "${2:-}"
        machine_record_profile="$2"
        shift 2
        ;;
      --check-host-key-pin)
        require_value "$1" "${2:-}"
        pin_arg="$2"
        shift 2
        ;;
      --classify-unsupported-platform)
        require_value "$1" "${2:-}"
        client_system="$2"
        shift 2
        ;;
      --classify-no-fallback)
        require_value "$1" "${2:-}"
        no_fallback_host="$2"
        shift 2
        ;;
      --repo)
        require_value "$1" "${2:-}"
        repo="$2"
        shift 2
        ;;
      --pin)
        require_value "$1" "${2:-}"
        pin="$2"
        shift 2
        ;;
      --results)
        require_value "$1" "${2:-}"
        results="$2"
        shift 2
        ;;
      --confirm-live-state-changes)
        confirm_live=true
        shift
        ;;
      *)
        usage_error "unknown argument: $1"
        ;;
    esac
  done

  if [[ -n "$machine_record_arg" ]]; then
    if validate_machines_file "$machine_record_arg" "$machine_record_profile"; then exit 0; else exit 1; fi
  fi
  if [[ -n "$pin_arg" ]]; then
    if validate_pin "$pin_arg"; then exit 0; else exit 1; fi
  fi
  if [[ -n "$client_system" ]]; then
    if classify_unsupported_platform "$client_system"; then exit 0; else exit 1; fi
  fi
  if [[ -n "$no_fallback_host" ]]; then
    if classify_no_fallback "$no_fallback_host"; then exit 0; else exit 1; fi
  fi

  if [[ "$confirm_live" != true ]]; then
    fail 'live validation changes live state; pass --confirm-live-state-changes'
  fi
  if [[ ! -t 0 || ! -t 1 ]]; then
    fail 'live validation requires an interactive TTY (run it from a terminal on the personal Mac)'
  fi
  if [[ "$(uname -s)" != "Darwin" ]]; then
    fail 'live validation must run on the personal Mac, the host that manages the Lima instances'
  fi
  if ! command -v "$lima_vmctl" >/dev/null 2>&1; then
    fail 'lima-vmctl is unavailable; use the personal host Home Manager environment that manages the Lima instances'
  fi
  if [[ ! -d "$repo" ]]; then
    fail "repository checkout does not exist: $repo"
  fi
  repo="$(cd "$repo" && pwd)"
  if [[ ! -f "$repo/flake.nix" || ! -f "$repo/flake.lock" ]]; then
    fail "not a locked flake: $repo"
  fi
  cd "$repo"
  if [[ -z "$pin" ]]; then
    pin="$repo/certificates/linux-builder/ssh_host_ed25519_key.pub"
  fi
  if [[ -z "$results" ]]; then
    results="$repo/$default_results"
  fi
  init_results
  trap cleanup EXIT INT TERM HUP

  printf 'Task 7 live validation for %s\n' "$builder_host"
  printf 'Evidence file: %s\n' "$results"
  check_tailnet
  check_host_key
  check_machines
  run_linux_build fabro "$(unique_name 'linux-builder-acceptance-fabro')"
  run_linux_build personal "$(unique_name 'linux-builder-acceptance-personal')"
  run_darwin_build
  run_unsupported fabro aarch64-linux
  run_unsupported personal aarch64-darwin
  if ! confirm_step "Stop and restart the $builder_name instance for the no-fallback check?"; then
    fail 'operator declined the no-fallback live-state change'
  fi
  run_no_fallback
  printf 'Task 7 live validation evidence recorded at %s\n' "$results"
}

main "$@"
