'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const scriptDirectory = path.join(repoRoot, 'tests/local-binary-cache');
const preflightSource = fs.readFileSync(
  path.join(scriptDirectory, '05-shopify-outage-preflight.sh'),
  'utf8',
);
const personalSource = fs.readFileSync(
  path.join(scriptDirectory, '06-personal-endpoint-outage.sh'),
  'utf8',
);
const controlSource = fs.readFileSync(
  path.join(scriptDirectory, 'outage-publisher-control.sh'),
  'utf8',
);

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf(`\n\n${nextName}() {`, start);

  assert.notEqual(start, -1, `missing Bash function ${name}`);
  assert.notEqual(end, -1, `missing Bash function following ${name}: ${nextName}`);
  return source.slice(start, end);
}

function runBash(body, options = {}) {
  const result = childProcess.spawnSync('/bin/bash', ['-c', body], {
    encoding: 'utf8',
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

function caddyRecoverySeam() {
  return [
    extractFunction(personalSource, 'job_loaded', 'probe_endpoint'),
    extractFunction(personalSource, 'require_status_line', 'endpoint_health'),
    extractFunction(personalSource, 'endpoint_health', 'wait_for_endpoint_health'),
    extractFunction(personalSource, 'wait_for_endpoint_health', 'recover_endpoint'),
    extractFunction(personalSource, 'recover_endpoint', 'consume_restore_command'),
  ].join('\n\n');
}

function caddyHarness(body, options = {}) {
  return runBash(`
set -u -o pipefail
caddy_label=org.nixos.local-binary-cache-caddy
attic_label=org.nixos.local-binary-cache-attic
caddy_plist=/Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist
status_command=status_probe
loaded=1
healthy=1
launchctl() {
  [[ "$1" == print ]] || return 99
  case "$2" in
    system/$caddy_label) (( loaded == 1 )) ;;
    system/$attic_label) return 0 ;;
    *) return 98 ;;
  esac
}
status_probe() {
  (( healthy == 1 )) || return 1
  printf '%s\n' \
    tls-health=healthy \
    cache-health=healthy \
    configured-live-key-match=true \
    status=healthy
}
sudo() {
  printf '%s\n' "$*" >> "$SUDO_CALLS"
  [[ "$1" == -n ]] || return 97
  shift
  if [[ "$1" == -v ]]; then
    return 0
  fi
  [[ "$*" == "launchctl bootstrap system $caddy_plist" ]] || return 96
  loaded=1
}
fail() {
  printf 'fixture: %s\n' "$1" >&2
  return 1
}
${caddyRecoverySeam()}
${body}
`, options);
}

test('Caddy recovery is idempotent when the fixed job is already healthy', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-recovery-loaded.'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sudoCalls = path.join(directory, 'sudo.calls');
  const result = caddyHarness(`
recover_endpoint
recover_endpoint
printf 'loaded=%d\n' "$loaded"
`, { env: { SUDO_CALLS: sudoCalls } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded=1/);
  assert.equal(fs.existsSync(sudoCalls), false, 'loaded recovery must not bootstrap');
  assert.equal((result.stdout.match(/status=healthy/g) ?? []).length, 2);
});

test('Caddy recovery bootstraps only its fixed plist and then confirms health', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-recovery-stopped.'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sudoCalls = path.join(directory, 'sudo.calls');
  const result = caddyHarness(`
loaded=0
recover_endpoint
recover_endpoint
printf 'loaded=%d\n' "$loaded"
`, { env: { SUDO_CALLS: sudoCalls } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded=1/);
  assert.equal(
    fs.readFileSync(sudoCalls, 'utf8'),
    '-n -v\n-n launchctl bootstrap system /Library/LaunchDaemons/org.nixos.local-binary-cache-caddy.plist\n',
  );
});

test('Caddy health confirmation rejects loaded but unhealthy service state', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caddy-recovery-unhealthy.'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const result = caddyHarness(`
healthy=0
status=0
endpoint_health >/dev/null 2>&1 || status=$?
printf 'status=%d\n' "$status"
`, { env: { SUDO_CALLS: path.join(directory, 'sudo.calls') } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=[1-9][0-9]*/);
});

test('full outage preflight blocks retries until endpoint health and publisher load are restored', () => {
  const seam = extractFunction(preflightSource, 'check_required_services', 'verify_consumer_config');
  const result = runBash(`
set -u
publisher_label=org.nixos.local-binary-cache-publisher
status_command=status_probe
healthy=0
loaded=0
status_probe() {
  (( healthy == 1 )) || return 1
  printf 'status=healthy\n'
}
launchctl() {
  [[ "$1" == print && "$2" == "system/$publisher_label" ]] || return 99
  (( loaded == 1 ))
}
${seam}
unhealthy=0
check_required_services >/dev/null 2>&1 || unhealthy=$?
healthy=1
unloaded=0
check_required_services >/dev/null 2>&1 || unloaded=$?
loaded=1
restored=0
check_required_services >/dev/null 2>&1 || restored=$?
printf 'unhealthy=%d unloaded=%d restored=%d\n' "$unhealthy" "$unloaded" "$restored"
`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /unhealthy=[1-9][0-9]* unloaded=[1-9][0-9]* restored=0/);
});

test('personal outage prints fixed recovery guidance before mutation and restores only explicitly', () => {
  const guidance = 'Manual recovery if interrupted: %s\\n';
  const guidanceIndex = personalSource.indexOf(guidance);
  const bootoutIndex = personalSource.indexOf('sudo -n launchctl bootout system "$caddy_plist"');
  const recoveryIndex = personalSource.indexOf('recover_endpoint', bootoutIndex);

  assert.notEqual(guidanceIndex, -1, 'missing fixed Caddy recovery guidance');
  assert.ok(guidanceIndex < bootoutIndex, 'Caddy recovery guidance follows bootout');
  assert.ok(bootoutIndex < recoveryIndex, 'normal Caddy recovery is not explicit after bootout');
  assert.match(
    personalSource,
    /caddy_recovery_command="\$script_directory\/06-personal-endpoint-outage\.sh --recover"/,
  );
  assert.match(personalSource, /\[\[ \$# -eq 1 && "\$1" == --recover \]\]/);
  assert.doesNotMatch(personalSource, /\btrap\b[^\n]*(?:EXIT|HUP|INT|TERM)/);
  assert.doesNotMatch(controlSource, /\btrap\b[^\n]*(?:EXIT|HUP|INT|TERM)/);
});
