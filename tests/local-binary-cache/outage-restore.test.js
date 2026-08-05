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
const producerSource = fs.readFileSync(
  path.join(scriptDirectory, '07-shopify-outage-producer.sh'),
  'utf8',
);
const recoverySource = fs.readFileSync(
  path.join(scriptDirectory, '08-shopify-outage-recovery.sh'),
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

function extractBlock(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);

  assert.notEqual(start, -1, `missing Bash block start: ${startMarker}`);
  assert.notEqual(end, -1, `missing Bash block end: ${endMarker}`);
  return source.slice(start, end).trim();
}

function mutateSource(source, pattern, replacement, description) {
  const mutant = source.replace(pattern, replacement);
  assert.notEqual(mutant, source, `mutation target is missing: ${description}`);
  return mutant;
}

function assertMutationRejected(assertion, description) {
  assert.throws(
    assertion,
    { code: 'ERR_ASSERTION' },
    `behavioral test accepted mutation: ${description}`,
  );
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

function phase07StatusGate() {
  return extractBlock(producerSource, 'status_exit=0', '\nendpoint_status=0');
}

function runPhase07StatusGate(gate, statusExit, statusOutput) {
  return runBash(`
set -euo pipefail
status_command=status_probe
status_probe() {
  printf '%s\n' "$STATUS_OUTPUT"
  return "$STATUS_EXIT"
}
fail() {
  printf 'fixture: %s\n' "$1" >&2
  exit 1
}
${gate}
`, {
    env: {
      STATUS_EXIT: String(statusExit),
      STATUS_OUTPUT: statusOutput,
    },
  });
}

function assertPhase07StatusGate(gate) {
  const outage = runPhase07StatusGate(gate, 7, 'status=not-ready');
  assert.equal(outage.status, 0, outage.stderr);
  assert.equal(outage.stdout, 'status=not-ready\n');

  const zeroExit = runPhase07StatusGate(gate, 0, 'status=not-ready');
  assert.notEqual(zeroExit.status, 0, 'zero-exit readiness command bypassed outage failure gate');

  const wrongSentinel = runPhase07StatusGate(gate, 7, 'status=unhealthy');
  assert.notEqual(wrongSentinel.status, 0, 'legacy outage sentinel bypassed readiness vocabulary gate');
}

function phase08StatusChecker() {
  return extractBlock(recoverySource, 'require_status_line() {', '\n\n# shellcheck');
}

function phase08StatusGates() {
  return extractBlock(
    recoverySource,
    'require_status_line "$ready_status" "tls-health=healthy"',
    '\nsuccess_capture=',
  );
}

function runPhase08StatusGates(checker, gates, readinessOutput) {
  return runBash(`
set -euo pipefail
fail() {
  printf 'fixture: %s\n' "$1" >&2
  exit 1
}
${checker}
ready_status="$READINESS_OUTPUT"
${gates}
`, { env: { READINESS_OUTPUT: readinessOutput } });
}

function assertPhase08StatusGates(checker, gates) {
  const fields = [
    ['TLS health', 'tls-health=healthy', 'tls-health=unhealthy'],
    ['cache health', 'cache-health=healthy', 'cache-health=unhealthy'],
    ['cache key match', 'configured-live-key-match=true', 'configured-live-key-match=false'],
    ['ready status', 'status=ready', 'status=not-ready'],
  ];
  const healthy = ['mode=ready', ...fields.map(([, line]) => line)];
  const accepted = runPhase08StatusGates(checker, gates, healthy.join('\n'));
  assert.equal(accepted.status, 0, accepted.stderr);

  for (const [name, line, wrong] of fields) {
    const missing = runPhase08StatusGates(
      checker,
      gates,
      healthy.filter(candidate => candidate !== line).join('\n'),
    );
    assert.notEqual(missing.status, 0, `missing ${name} bypassed recovery gate`);

    const mutated = runPhase08StatusGates(
      checker,
      gates,
      healthy.map(candidate => candidate === line ? wrong : candidate).join('\n'),
    );
    assert.notEqual(mutated.status, 0, `wrong ${name} bypassed recovery gate`);
  }
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
    mode=ready \
    tls-health=healthy \
    cache-health=healthy \
    configured-live-key-match=true \
    status=ready
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
  assert.equal((result.stdout.match(/status=ready/g) ?? []).length, 2);
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
  printf 'mode=ready\nstatus=ready\n'
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

test('phase 07 behavior requires nonzero readiness-only outage status', () => {
  const gate = phase07StatusGate();
  const bypassedFailureBranch = mutateSource(
    gate,
    '(( status_exit != 0 )) || fail "status unexpectedly reports a healthy cache during outage"',
    ':',
    'phase 07 nonzero status branch',
  );
  const legacySentinel = mutateSource(
    gate,
    '"status=not-ready"',
    '"status=unhealthy"',
    'phase 07 readiness sentinel',
  );

  assertPhase07StatusGate(gate);
  assertMutationRejected(
    () => assertPhase07StatusGate(bypassedFailureBranch),
    'phase 07 nonzero status branch',
  );
  assertMutationRejected(
    () => assertPhase07StatusGate(legacySentinel),
    'phase 07 readiness sentinel',
  );
});

test('phase 08 behavior requires every healthy readiness field', () => {
  const checker = phase08StatusChecker();
  const gates = phase08StatusGates();
  const unconditionalChecker = mutateSource(
    checker,
    /  \/usr\/bin\/grep -Fqx -- "\$expected" <<< "\$output" \\\n+    \|\| fail "status output is missing after recovery: \$expected"/,
    '  return 0',
    'phase 08 status checker',
  );

  assertPhase08StatusGates(checker, gates);
  assertMutationRejected(
    () => assertPhase08StatusGates(unconditionalChecker, gates),
    'phase 08 unconditional status checker',
  );

  for (const gate of [
    'require_status_line "$ready_status" "tls-health=healthy"',
    'require_status_line "$ready_status" "cache-health=healthy"',
    'require_status_line "$ready_status" "configured-live-key-match=true"',
    'require_status_line "$ready_status" "status=ready"',
  ]) {
    const disabledGate = mutateSource(gates, gate, ':', `disabled ${gate}`);
    assertMutationRejected(
      () => assertPhase08StatusGates(checker, disabledGate),
      `disabled ${gate}`,
    );
  }
});

test('outage phases use only the installed readiness status vocabulary', () => {
  assert.match(
    preflightSource,
    /grep -Fqx -- "status=ready" <<< "\$output"/,
  );
  assert.match(
    personalSource,
    /require_status_line "\$output" "status=ready" \|\| return/,
  );
  assert.match(
    producerSource,
    /grep -Fqx -- "status=not-ready" <<< "\$outage_status_output"/,
  );
  assert.match(
    recoverySource,
    /require_status_line "\$ready_status" "status=ready"/,
  );

  const combined = [
    preflightSource,
    personalSource,
    producerSource,
    recoverySource,
  ].join('\n');
  assert.doesNotMatch(combined, /status=(?:healthy|unhealthy)/);
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
