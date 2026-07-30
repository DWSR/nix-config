'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const directory = path.join(repoRoot, 'tests/local-binary-cache');
const scripts = [
  '05-shopify-outage-preflight.sh',
  '06-personal-endpoint-outage.sh',
  '07-shopify-outage-producer.sh',
  '08-shopify-outage-recovery.sh',
];
const atticClientExecutable = process.env.ATTIC_CLIENT_EXECUTABLE;
const atticClientSource = process.env.ATTIC_CLIENT_SOURCE;

function source(name) {
  return fs.readFileSync(path.join(directory, name), 'utf8');
}

function assertOrdered(text, markers) {
  let previous = -1;
  for (const marker of markers) {
    const current = text.indexOf(marker, previous + 1);
    assert.notEqual(current, -1, `missing ordered marker: ${marker}`);
    assert.ok(current > previous, `marker is out of order: ${marker}`);
    previous = current;
  }
}

function shellEscapeMechanisms(text) {
  const patterns = [
    /(?<![&<>|])&(?![&>])/,
    /(?:^|[;|()\n])\s*(?:(?:command|exec)\s+)?(?:coproc|disown|nohup|setsid)\b/m,
    /(?:<|>)\(/,
    /\bset\s+(?:-m|-o\s+monitor)\b/,
  ];
  return patterns.filter(pattern => pattern.test(text));
}

function rustProcessCreationApis(text) {
  const patterns = [
    /\b(?:std|tokio)::process\b/,
    /\bprocess::Command\b/,
    /\bCommand::new\s*\(/,
    /\b(?:libc|nix::unistd)::(?:daemon|fork|posix_spawn|posix_spawnp|setpgid|setsid|vfork)\b/,
    /\b(?:daemon|fork|posix_spawn|posix_spawnp|setpgid|setsid|vfork)\s*\(/,
  ];
  return patterns.filter(pattern => pattern.test(text));
}

function productionRustSources(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'tests') {
        files.push(...productionRustSources(entryPath));
      }
    } else if (entry.isFile() && entry.name.endsWith('.rs')) {
      files.push(entryPath);
    }
  }
  return files;
}

test('outage phases retain exact numbering and remove cursor architecture', () => {
  for (const script of scripts) {
    const scriptPath = path.join(directory, script);
    assert.ok(fs.statSync(scriptPath).mode & 0o111, `${script} must be executable`);
  }
  assert.match(source(scripts[0]), /06-personal-endpoint-outage\.sh/);
  assert.match(source(scripts[1]), /07-shopify-outage-producer\.sh/);
  assert.match(source(scripts[2]), /08-shopify-outage-recovery\.sh/);
  assert.equal(fs.existsSync(path.join(directory, 'outage-log-cursor.sh')), false);
});

test('each phase validates its exact host and literal positional handoff', () => {
  const preflight = source(scripts[0]);
  const personal = source(scripts[1]);
  const producer = source(scripts[2]);
  const recovery = source(scripts[3]);

  assert.match(preflight, /expected_host="ShopifyLaptop"/);
  assert.match(preflight, /\[\[ \$# -eq 0 \]\]/);
  assert.match(personal, /expected_host="Brandons-MacBook-Pro"/);
  assert.match(personal, /\[\[ \$# -eq 1 && "\$1" == --recover \]\]/);
  assert.match(personal, /\[\[ \$# -eq 1 \]\]/);
  assert.match(producer, /expected_host="ShopifyLaptop"/);
  assert.match(producer, /\[\[ \$# -eq 1 && "\$1" == --recover \]\]/);
  assert.match(producer, /\[\[ \$# -eq 2 \]\]/);
  assert.match(recovery, /expected_host="ShopifyLaptop"/);
  assert.match(recovery, /\[\[ \$# -eq 4 \]\]/);
  assert.match(producer, /RUN_TICKET=%s/);
  assert.match(recovery, /run ticket path does not match handoff/);
});

test('personal phase restores Caddy and emits the exact recovery-ready handoff', () => {
  const text = source(scripts[1]);
  const normalPath = text.slice(text.indexOf('Manual recovery if interrupted: %s\\n'));
  assertOrdered(normalPath, [
    'Manual recovery if interrupted: %s\\n',
    'launchctl bootout system "$caddy_plist"',
    'endpoint-outage-curl-exit=',
    'restore_challenge="shopify-restore-$(/usr/bin/uuidgen',
    'Do not enter RESTORE until phase 08 reports that it is waiting.',
    'consume_restore_command "$restore_input"',
    'recover_endpoint',
    'configured-live-key-match=true',
    'RECOVERY_READY %s %s',
  ]);
  assert.equal((text.match(/launchctl bootout/g) ?? []).length, 1);
  assert.doesNotMatch(text, /bootout[^\n]*attic/);
});

test('phase 07 proves synchronous failure under paused publisher then restores it', () => {
  const text = source(scripts[2]);
  assertOrdered(text, [
    'pending queue is not empty before outage build',
    'nix build --no-link --print-out-paths',
    'build did not create pending root',
    'stop_publisher',
    'run_bounded_publisher',
    'bounded publisher failure did not retain pending root',
    'ticket-create',
    'finish_publisher_control',
    'Start on ShopifyLaptop before RESTORE:',
    'Only after phase 08 reports waiting',
  ]);
  assert.match(text, /nonzero "\$failure_capture" 2 "\$failure_prefix" "retained for retry"/);
  assert.doesNotMatch(text, /publisher_log|cursor|tail -n/);
});

test('phase 08 consumes ticket and waits before endpoint recovery and synchronous success', () => {
  const text = source(scripts[3]);
  assertOrdered(text, [
    'expected pending root is absent',
    'ticket-consume',
    'stop_publisher',
    'phase-08-waiting',
    'RECOVERY_READY %s %s',
    'consume_recovery_ready "$recovery_ready_input"',
    'configured-live-key-match=true',
    'run_bounded_publisher zero',
    'bounded publisher success did not remove pending root',
    '$endpoint/$root_id.narinfo',
    'finish_publisher_control',
  ]);
  assert.doesNotMatch(text, /publisher_log|cursor|tail -n/);
});

test('runner and publisher-control contracts are bounded, exact, and secret-free', () => {
  const runner = source('outage-log-io.pl');
  const control = source('outage-publisher-control.sh');
  const combined = scripts.map(source).join('\n') + runner + control;

  assert.match(runner, /MAX_OUTPUT_BYTES = 64 \* 1024/);
  assert.match(runner, /PRODUCTION_TIMEOUT_SECONDS = 180/);
  assert.match(runner, /setpgid\(0, 0\)/);
  assert.match(runner, /signal_process\('TERM', -\$pid\)/);
  assert.match(runner, /signal_process\('KILL', -\$pid\)/);
  assert.match(runner, /O_CREAT \| O_EXCL \| O_NONBLOCK \| O_NOFOLLOW/);
  assert.match(runner, /\$state\[4\] == 0/);
  assert.match(runner, /runner must execute as root/);
  assert.match(runner, /ticket_consume/);

  assert.match(control, /Print :UserName/);
  assert.match(control, /Print :Label/);
  assert.match(control, /Print :WorkingDirectory/);
  assert.match(control, /Print :ProgramArguments:0/);
  assert.match(control, /Print :ProgramArguments:1/);
  assert.match(control, /Print :Program/);
  assert.match(control, /publisher_user" == root/);
  assert.match(control, /\/bin\/realpath "\$executable"/);
  assert.match(control, /-- "\$publisher_executable"/);
  assert.match(control, /07-shopify-outage-producer\.sh --recover/);
  assert.doesNotMatch(control, /\btrap\b[^\n]*(?:EXIT|HUP|INT|TERM)/);

  assert.doesNotMatch(combined, /atticadm\b|token(?:-file)?\b|\/run\/secrets/);
  assert.doesNotMatch(combined, /nix-collect-garbage|nix\s+(?:store\s+)?gc\b/);
  assert.doesNotMatch(combined, /nix-store\s+--delete/);
});

test('deployed publisher contract excludes process-group escape mechanisms', () => {
  assert.ok(atticClientExecutable, 'canonical check must expose ATTIC_CLIENT_EXECUTABLE');
  assert.ok(atticClientSource, 'canonical check must expose ATTIC_CLIENT_SOURCE');
  assert.equal(fs.realpathSync(atticClientExecutable), atticClientExecutable);
  assert.equal(fs.realpathSync(atticClientSource), atticClientSource);

  const publisherSource = fs.readFileSync(
    path.join(repoRoot, 'scripts/local-binary-cache-publish.nix'),
    'utf8',
  );
  assert.deepEqual(shellEscapeMechanisms(publisherSource), []);
  for (const mutation of [
    'attic push &\n',
    'coproc attic push\n',
    'nohup attic push\n',
    'setsid attic push\n',
    'cat <(attic push)\n',
    'set -o monitor\n',
  ]) {
    assert.notEqual(shellEscapeMechanisms(mutation).length, 0, `missed shell mutation: ${mutation}`);
  }

  const rustSources = [
    ...productionRustSources(path.join(atticClientSource, 'client/src')),
    ...productionRustSources(path.join(atticClientSource, 'attic/src')),
  ];
  assert.ok(rustSources.length > 0, 'pinned Attic production source is empty');
  const directProcessApis = rustSources.flatMap(file => {
    const matches = rustProcessCreationApis(fs.readFileSync(file, 'utf8'));
    return matches.map(pattern => `${file}: ${pattern}`);
  });
  assert.deepEqual(directProcessApis, []);
  for (const mutation of [
    'use std::process::Command;',
    'tokio::process::Command::new("sh");',
    'unsafe { libc::setsid() };',
    'nix::unistd::fork();',
    'posix_spawn();',
  ]) {
    assert.notEqual(rustProcessCreationApis(mutation).length, 0, `missed Rust mutation: ${mutation}`);
  }

  const nm = childProcess.spawnSync('/usr/bin/nm', ['-u', atticClientExecutable], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  assert.equal(nm.status, 0, nm.stderr);
  const importedSymbols = new Set(nm.stdout.trim().split('\n').map(line => line.trim()));
  const forbiddenSymbols = [
    '_daemon',
    '_fork',
    '_posix_spawn',
    '_posix_spawnp',
    '_setpgid',
    '_setsid',
    '_vfork',
  ];
  assert.deepEqual(forbiddenSymbols.filter(symbol => importedSymbols.has(symbol)), []);
});

test('outage phases preflight privilege and reject every later sudo prompt', () => {
  const [preflight, personal, producer, recovery] = scripts.map(source);
  const promptCapableSudo = /(?:^[ \t]*|\$\(|(?:if|then|while|until|!|&&|\|\|)[ \t]+)sudo[ \t]+(?!-n(?:[ \t]|$))/m;

  for (const [index, text] of scripts.map(source).entries()) {
    assert.doesNotMatch(text, promptCapableSudo, `${scripts[index]} contains prompt-capable sudo`);
  }
  assertOrdered(preflight, ['sudo -n -v', 'sudo -n test -d']);
  assertOrdered(personal, ['sudo -n -v', 'sudo -n launchctl bootout']);
  assertOrdered(producer, ['acquire_noninteractive_privilege', 'load_publisher_contract']);
  assertOrdered(recovery, ['acquire_noninteractive_privilege', 'load_publisher_contract']);
});

test('outage Bash never owns launchd restoration from EXIT or signal traps', () => {
  const serviceLifecycleSources = [
    source('06-personal-endpoint-outage.sh'),
    source('07-shopify-outage-producer.sh'),
    source('08-shopify-outage-recovery.sh'),
    source('outage-publisher-control.sh'),
  ];

  for (const text of serviceLifecycleSources) {
    assert.doesNotMatch(text, /\btrap\b[^\n]*(?:EXIT|HUP|INT|TERM)/);
  }
});

test('runner starts its deadline and retains signal masking before group readiness', () => {
  const runner = source('outage-log-io.pl');
  const started = runner.indexOf('my $started = clock_gettime(CLOCK_MONOTONIC);');
  const forked = runner.indexOf('$pid = fork();');
  const processState = runner.indexOf('$publisher_process = {');
  const groupReady = runner.indexOf('$publisher_process->{group_ready} = 1;', processState);
  const parentUnmask = runner.indexOf(
    'defined(sigprocmask(SIG_SETMASK, $previous_signals))',
    groupReady,
  );

  assert.ok(started !== -1 && started < forked, 'publisher deadline starts after fork');
  assert.ok(groupReady !== -1 && groupReady < parentUnmask, 'parent signals unmask before group readiness');
});

test('runner can discover the publisher group before handshake readiness is recorded', () => {
  const runner = source('outage-log-io.pl');
  const groupProbeStart = runner.indexOf('sub publisher_group_alive {');
  const groupProbeEnd = runner.indexOf('\n}\n\nsub signal_process {', groupProbeStart);
  const groupProbe = runner.slice(groupProbeStart, groupProbeEnd);

  assert.notEqual(groupProbeStart, -1);
  assert.notEqual(groupProbeEnd, -1);
  assert.match(groupProbe, /kill\(0, -\$process->\{pid\}\)/);
  assert.doesNotMatch(groupProbe, /group_ready/);
});

test('runner timeout and cleanup deadlines use a monotonic clock', () => {
  const runner = source('outage-log-io.pl');

  assert.match(runner, /CLOCK_MONOTONIC/);
  assert.match(runner, /clock_gettime\(CLOCK_MONOTONIC\)/);
  assert.doesNotMatch(runner, /\btime\(\)/);
});
