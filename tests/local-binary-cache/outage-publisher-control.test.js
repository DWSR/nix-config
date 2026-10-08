'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const scriptDirectory = path.join(repoRoot, 'tests/local-binary-cache');
const control = path.join(scriptDirectory, 'outage-publisher-control.sh');

function findPublisherExecutable() {
  const configured = process.env.PUBLISHER_VALIDATOR_EXECUTABLE;
  const candidates = configured === undefined
    ? fs.readdirSync('/nix/store')
      .filter(entry => /^[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+_?=-][A-Za-z0-9+._?=-]*$/.test(entry))
      .sort()
      .map(entry => path.join('/nix/store', entry, 'bin/local-binary-cache-publish'))
    : [configured];

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()
        && fs.realpathSync(candidate) === candidate) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        throw error;
      }
    }
  }
  throw new Error('no canonical local-binary-cache-publish executable is available');
}

const expectedPublisher = findPublisherExecutable();

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-control.'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const plist = path.join(directory, 'publisher.plist');
  fs.writeFileSync(plist, 'fixture\n');
  return { directory, plist };
}

function runControl(body, options = {}) {
  return childProcess.spawnSync('/bin/bash', ['-c', `
publisher_label=org.nixos.local-binary-cache-publisher
script_directory="$SCRIPT_DIRECTORY"
source "$CONTROL"
publisher_plist="$PUBLISHER_PLIST"
${body}
`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTROL: control,
      EXPECTED_PUBLISHER: expectedPublisher,
      SCRIPT_DIRECTORY: scriptDirectory,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
}

const contractFixture = String.raw`
expected_publisher="$EXPECTED_PUBLISHER"
publisher_plist_read() {
  case "$1" in
    Label)
      [[ "$INVALID_FIELD" == label ]] && printf '%s\n' wrong-label \
        || printf '%s\n' "$publisher_label"
      ;;
    UserName)
      [[ "$INVALID_FIELD" == user ]] && printf '%s\n' nobody || printf '%s\n' root
      ;;
    WorkingDirectory)
      [[ "$INVALID_FIELD" == working-directory ]] && printf '%s\n' /tmp \
        || printf '%s\n' "$publisher_state_directory"
      ;;
    ProgramArguments:0)
      [[ "$INVALID_FIELD" == executable ]] && printf '%s\n' /bin/sh \
        || printf '%s\n' "$expected_publisher"
      ;;
    *) return 1 ;;
  esac
}
publisher_plist_has_key() {
  [[ "$INVALID_FIELD:$1" == arguments:ProgramArguments:1 \
    || "$INVALID_FIELD:$1" == program:Program \
    || "$INVALID_FIELD:$1" == environment:EnvironmentVariables ]]
}
`;

test('publisher contract accepts only the exact plist with no declared environment', t => {
  const { plist } = fixture(t);
  const valid = runControl(`
${contractFixture}
load_publisher_contract
printf 'label=%s user=%s workdir=%s executable=%s\n' \
  "$publisher_plist_label" "$publisher_user" \
  "$publisher_working_directory" "$publisher_executable"
`, { env: { INVALID_FIELD: '', PUBLISHER_PLIST: plist } });

  assert.equal(valid.status, 0, valid.stderr);
  assert.match(valid.stdout, /label=org\.nixos\.local-binary-cache-publisher user=root/);
  assert.match(valid.stdout, /workdir=\/var\/db\/local-binary-cache\/publisher/);
  assert.match(valid.stdout, new RegExp(`executable=${expectedPublisher.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  for (const invalidField of [
    'label',
    'user',
    'working-directory',
    'executable',
    'arguments',
    'program',
    'environment',
  ]) {
    const invalid = runControl(`
${contractFixture}
load_publisher_contract
`, { env: { INVALID_FIELD: invalidField, PUBLISHER_PLIST: plist } });
    assert.notEqual(invalid.status, 0, `accepted invalid ${invalidField} contract`);
  }
});

test('production publisher validator accepts only a canonical Nix store executable', t => {
  const { directory, plist } = fixture(t);
  const mutableBin = path.join(directory, 'bin');
  const mutableExecutable = path.join(mutableBin, 'local-binary-cache-publish');
  fs.mkdirSync(mutableBin);
  fs.writeFileSync(mutableExecutable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const storeItem = expectedPublisher.match(/^\/nix\/store\/[^/]+/)?.[0];
  assert.notEqual(storeItem, undefined);
  const valid = runControl('publisher_executable_is_valid "$CANDIDATE"', {
    env: { CANDIDATE: expectedPublisher, PUBLISHER_PLIST: plist },
  });
  assert.equal(valid.status, 0, valid.stderr);

  const relativeExecutable = expectedPublisher.slice(storeItem.length + 1);
  const invalidCandidates = {
    'dot alias': `${storeItem}/./${relativeExecutable}`,
    'dot-dot alias': `${storeItem}/bin/../bin/local-binary-cache-publish`,
    'extra store-item components': `${storeItem}/../../../nix/store/${path.basename(storeItem)}/${relativeExecutable}`,
    'physical escape': `${storeItem}/../../../${mutableExecutable.replace(/^\/+/, '')}`,
  };
  for (const [description, candidate] of Object.entries(invalidCandidates)) {
    const result = runControl('publisher_executable_is_valid "$CANDIDATE"', {
      env: { CANDIDATE: candidate, PUBLISHER_PLIST: plist },
    });
    assert.notEqual(result.status, 0, `accepted ${description}: ${candidate}`);
  }
});

test('production publisher validator independently enforces Nix store item grammar', t => {
  const { directory, plist } = fixture(t);
  const physicalDirectory = fs.realpathSync(directory);
  const storeRoot = path.join(physicalDirectory, 'nix/store');
  const invalidStoreItem = path.join(
    storeRoot,
    `${'0'.repeat(31)}e-publisher-fixture`,
  );
  const executable = path.join(invalidStoreItem, 'bin/local-binary-cache-publish');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  assert.equal(fs.statSync(executable).isFile(), true);
  fs.accessSync(executable, fs.constants.X_OK);
  assert.equal(fs.realpathSync(executable), executable);

  function validate(controlPath) {
    return runControl('publisher_executable_is_valid "$CANDIDATE" "$STORE_ROOT"', {
      env: {
        CANDIDATE: executable,
        CONTROL: controlPath,
        PUBLISHER_PLIST: plist,
        STORE_ROOT: storeRoot,
      },
    });
  }

  const rejected = validate(control);
  assert.notEqual(rejected.status, 0, 'accepted canonical executable with invalid store hash alphabet');

  const controlLines = fs.readFileSync(control, 'utf8').split('\n');
  const guardStart = controlLines.findIndex(line => line.includes('[[ "$store_relative" =~ ^[0-9'));
  const guardEnd = controlLines.findIndex(
    (line, index) => index > guardStart && line.trim() === '|| return 1',
  );
  assert.ok(guardStart >= 0 && guardEnd > guardStart, 'publisher grammar guard was not found');
  controlLines.splice(
    guardStart,
    guardEnd - guardStart + 1,
    '  [[ -f "$executable" && -x "$executable" ]] || return 1',
  );
  const mutant = path.join(directory, 'outage-publisher-control-without-grammar.sh');
  fs.writeFileSync(mutant, controlLines.join('\n'));
  const acceptedByMutant = validate(mutant);
  assert.equal(
    acceptedByMutant.status,
    0,
    `non-grammar validation rejected the canonical fixture: ${acceptedByMutant.stderr}`,
  );
});

test('production publisher validator enforces physical file state on a store-shaped fixture', t => {
  const { directory, plist } = fixture(t);
  const physicalDirectory = fs.realpathSync(directory);
  const storeRoot = path.join(physicalDirectory, 'nix/store');
  const storeItem = path.join(
    storeRoot,
    '00000000000000000000000000000000-publisher-fixture',
  );
  const bin = path.join(storeItem, 'bin');
  const executable = path.join(bin, 'local-binary-cache-publish');
  const mutableTarget = path.join(physicalDirectory, 'mutable-publisher');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  function validate() {
    return runControl('publisher_executable_is_valid "$CANDIDATE" "$STORE_ROOT"', {
      env: {
        CANDIDATE: executable,
        PUBLISHER_PLIST: plist,
        STORE_ROOT: storeRoot,
      },
    });
  }

  assert.equal(validate().status, 0, 'rejected valid store-shaped executable');

  fs.chmodSync(executable, 0o644);
  assert.notEqual(validate().status, 0, 'accepted non-executable regular file');
  fs.rmSync(executable);
  fs.mkdirSync(executable);
  assert.notEqual(validate().status, 0, 'accepted directory in place of regular executable');
  fs.rmSync(executable, { recursive: true });

  fs.writeFileSync(mutableTarget, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.symlinkSync(mutableTarget, executable);
  assert.notEqual(validate().status, 0, 'accepted symlink to mutable executable target');
  fs.rmSync(mutableTarget);
  assert.notEqual(validate().status, 0, 'accepted broken mutable executable target');
});

test('publisher mutation fails at non-interactive privilege preflight', t => {
  const { directory, plist } = fixture(t);
  const sudoCalls = path.join(directory, 'sudo.calls');
  const mutations = path.join(directory, 'mutations');
  const result = runControl(`
sudo() {
  printf '%s\n' "$*" >> "$SUDO_CALLS"
  [[ "$*" == '-n -v' ]] || return 98
  return 77
}
launchctl() {
  [[ "$1" == print ]] && return 0
  printf '%s\n' "$*" >> "$MUTATIONS"
}
status=0
stop_publisher || status=$?
printf 'status=%d stopped=%d\n' "$status" "$publisher_stopped"
`, {
    env: {
      MUTATIONS: mutations,
      PUBLISHER_PLIST: plist,
      SUDO_CALLS: sudoCalls,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=77 stopped=0/);
  assert.equal(fs.readFileSync(sudoCalls, 'utf8'), '-n -v\n');
  assert.equal(fs.existsSync(mutations), false);
});

test('publisher stop prints fixed recovery guidance before bootout and does not restore on exit', t => {
  const { directory, plist } = fixture(t);
  const events = path.join(directory, 'events');
  const result = runControl(`
set -e
loaded=1
launchctl() {
  [[ "$1" == print ]] || return 99
  (( loaded == 1 ))
}
printf() {
  if [[ "$1" == 'Manual recovery if interrupted: %s\\n' ]]; then
    builtin printf 'guidance:%s\\n' "$2" >> "$EVENTS"
  fi
  builtin printf "$@"
}
sudo() {
  [[ "$1" == -n ]] || return 98
  shift
  if [[ "$1" == -v ]]; then
    return 0
  fi
  [[ "$*" == "launchctl bootout system $publisher_plist" ]] || return 97
  printf 'bootout\\n' >> "$EVENTS"
  loaded=0
}
stop_publisher
printf 'loaded=%d stopped=%d\\n' "$loaded" "$publisher_stopped"
`, { env: { EVENTS: events, PUBLISHER_PLIST: plist } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded=0 stopped=1/);
  assert.match(
    result.stderr,
    /Manual recovery if interrupted: .*\/06-personal-endpoint-outage\.sh --recover/,
  );
  assert.equal(
    fs.readFileSync(events, 'utf8'),
    `guidance:${path.join(scriptDirectory, '06-personal-endpoint-outage.sh')} --recover\nbootout\n`,
  );
});

test('publisher recovery bootstraps only its fixed plist and is idempotent', t => {
  const { directory, plist } = fixture(t);
  const sudoCalls = path.join(directory, 'sudo.calls');
  const result = runControl(`
set -e
loaded=0
print_calls=0
launchctl() {
  [[ "$1" == print && "$2" == "system/$publisher_label" ]] || return 99
  (( print_calls += 1 ))
  (( loaded == 1 ))
}
sudo() {
  printf '%s\\n' "$*" >> "$SUDO_CALLS"
  [[ "$1" == -n ]] || return 98
  shift
  if [[ "$1" == -v ]]; then
    return 0
  fi
  [[ "$*" == "launchctl bootstrap system $publisher_plist" ]] || return 97
  loaded=1
}
recover_publisher
recover_publisher
printf 'loaded=%d stopped=%d print-calls=%d\\n' \
  "$loaded" "$publisher_stopped" "$print_calls"
`, { env: { PUBLISHER_PLIST: plist, SUDO_CALLS: sudoCalls } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded=1 stopped=0 print-calls=3/);
  assert.equal(
    fs.readFileSync(sudoCalls, 'utf8'),
    `-n -v\n-n launchctl bootstrap system ${plist}\n`,
  );
});

test('publisher recovery fails when bootstrap does not produce a loaded job', t => {
  const { plist } = fixture(t);
  const result = runControl(`
loaded=0
launchctl() {
  [[ "$1" == print ]] || return 99
  return 1
}
sudo() {
  [[ "$1" == -n ]] || return 98
  return 0
}
status=0
recover_publisher || status=$?
printf 'status=%d stopped=%d\\n' "$status" "$publisher_stopped"
`, { env: { PUBLISHER_PLIST: plist } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /status=[1-9][0-9]* stopped=0/);
});

test('publisher recovery mode accepts only literal --recover with no service-selected data', () => {
  assert.match(
    fs.readFileSync(path.join(scriptDirectory, '06-personal-endpoint-outage.sh'), 'utf8'),
    /\[\[ \$# -eq 1 && "\$1" == --recover \]\]/,
  );
  assert.match(
    fs.readFileSync(path.join(scriptDirectory, '06-personal-endpoint-outage.sh'), 'utf8'),
    /caddy_recovery_command=.*06-personal-endpoint-outage\.sh --recover/,
  );
  assert.doesNotMatch(
    fs.readFileSync(path.join(scriptDirectory, '06-personal-endpoint-outage.sh'), 'utf8'),
    /--recover[ =](?:\$|"\$)|--recover-(?:label|plist|service)/,
  );
});

test('publisher control rejects every later sudo prompt path', t => {
  const { directory, plist } = fixture(t);
  const sudoCalls = path.join(directory, 'sudo.calls');
  const result = runControl(`
set -e
loaded=1
launchctl() {
  [[ "$1" == print ]] || return 99
  (( loaded == 1 ))
}
sudo() {
  printf '%s\n' "$*" >> "$SUDO_CALLS"
  [[ "$1" == -n ]] || return 98
  shift
  if [[ "$1" == -v ]]; then
    return 0
  fi
  if [[ "$1 $2" == 'launchctl bootout' ]]; then
    loaded=0
    return 0
  fi
  if [[ "$1 $2" == 'launchctl bootstrap' ]]; then
    loaded=1
    return 0
  fi
  [[ "$1" == /usr/bin/perl ]]
}
publisher_working_directory="$publisher_state_directory"
publisher_executable=/nix/store/00000000000000000000000000000000-publisher/bin/local-binary-cache-publish
acquire_noninteractive_privilege
stop_publisher
run_bounded_publisher zero "$publisher_state_directory/evidence" 1 evidence
finish_publisher_control
printf 'loaded=%d stopped=%d\n' "$loaded" "$publisher_stopped"
`, { env: { PUBLISHER_PLIST: plist, SUDO_CALLS: sudoCalls } });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /loaded=1 stopped=0/);
  const calls = fs.readFileSync(sudoCalls, 'utf8').trim().split('\n');
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.match(call, /^-n(?: |$)/, `interactive sudo call: ${call}`);
  }
  assert.equal(calls[0], '-n -v');
  assert.match(calls[1], /^-n launchctl bootout system /);
  assert.match(calls[2], /^-n \/usr\/bin\/perl .*\/outage-log-io\.pl run /);
  assert.match(calls[3], /^-n launchctl bootstrap system /);
});
