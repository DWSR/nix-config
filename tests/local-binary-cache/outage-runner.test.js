'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const runner = path.join(
  repoRoot,
  'tests/local-binary-cache/outage-log-io.pl',
);

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-binary-cache-runner.'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, options = {}) {
  return childProcess.spawnSync('/usr/bin/perl', [runner, ...args], {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      LOCAL_BINARY_CACHE_RUNNER_TEST_MODE: '1',
      ...(options.env ?? {}),
    },
    input: options.input,
    stdio: [options.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 10_000,
  });
}

function runPublisher(expectation, capture, cwd, fragments, command, options = {}) {
  return run([
    'run',
    expectation,
    capture,
    cwd,
    String(fragments.length),
    ...fragments,
    '--',
    ...command,
  ], options);
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForPath(target, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(target) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(target), true, `timed out waiting for ${target}`);
}

function waitForExit(child, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('runner did not exit')), timeout);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

test('bounded runner accepts exact nonzero publisher evidence in an exclusive capture', t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'failure.capture');
  const expectedPath = '/nix/store/00000000000000000000000000000000-task-6.4';
  const command = [
    '/bin/sh',
    '-c',
    `printf '%s\n' 'failed to publish ${expectedPath}; retained for retry' >&2; exit 7`,
  ];
  const result = runPublisher(
    'nonzero',
    capture,
    directory,
    [`failed to publish ${expectedPath}`, 'retained for retry'],
    command,
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(capture, 'utf8'), `failed to publish ${expectedPath}; retained for retry\n`);
  assert.equal(fs.statSync(capture).mode & 0o777, 0o600);

  const replay = runPublisher('nonzero', capture, directory, ['retained for retry'], command);
  assert.notEqual(replay.status, 0);
});

test('bounded runner accepts exact zero publisher evidence', t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'success.capture');
  const result = runPublisher(
    'zero',
    capture,
    directory,
    ['published exact output from pending root exact-root'],
    ['/bin/sh', '-c', "printf '%s\n' 'published exact output from pending root exact-root'"],
  );

  assert.equal(result.status, 0, result.stderr);
});

test('bounded runner gives the publisher only explicit root launchd defaults', t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'environment.capture');
  const poison = 'task-6.4-ambient-poison';
  const expected = [
    'HOME=/var/root',
    'LOGNAME=root',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
    'SHELL=/bin/sh',
    'USER=root',
  ];
  const result = runPublisher(
    'zero',
    capture,
    directory,
    expected,
    ['/usr/bin/env'],
    {
      env: {
        ALL_PROXY: poison,
        ATTIC_CA_CERT: poison,
        HOME: poison,
        HTTPS_PROXY: poison,
        HTTP_PROXY: poison,
        LOGNAME: poison,
        NIX_CONFIG: poison,
        NO_PROXY: poison,
        PATH: poison,
        SHELL: poison,
        USER: poison,
        XDG_CONFIG_HOME: poison,
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const actual = fs.readFileSync(capture, 'utf8').trim().split('\n').sort();
  assert.deepEqual(actual, expected.sort());
  assert.doesNotMatch(fs.readFileSync(capture, 'utf8'), new RegExp(poison));
});

test('bounded runner reproduces launchd cwd, umask, and null stdin', t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'launch-context.capture');
  const physicalDirectory = fs.realpathSync(directory);
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const result = runPublisher(
    'zero',
    capture,
    directory,
    [`cwd=${physicalDirectory}`, 'umask=0022', 'stdin=eof'],
    [
      '/bin/sh',
      '-c',
      'if IFS= read -r value; then input=$value; else input=eof; fi; '
        + 'printf "cwd=%s\\numask=%s\\nstdin=%s\\n" "$(/bin/pwd -P)" "$(umask)" "$input"',
    ],
    { input: 'ambient-stdin-poison\n' },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(fs.readFileSync(capture, 'utf8'), /ambient-stdin-poison/);
});

test('bounded runner rejects wrong exit semantics and missing evidence', t => {
  const directory = fixture(t);
  const wrongExit = runPublisher(
    'nonzero',
    path.join(directory, 'wrong-exit.capture'),
    directory,
    ['retained for retry'],
    ['/bin/sh', '-c', "printf '%s\n' 'retained for retry'; exit 0"],
  );
  const missing = runPublisher(
    'zero',
    path.join(directory, 'missing.capture'),
    directory,
    ['published expected path'],
    ['/bin/sh', '-c', "printf '%s\n' 'different output'"],
  );

  assert.notEqual(wrongExit.status, 0);
  assert.notEqual(missing.status, 0);
});

test('bounded runner removes process-group descendants after success and failure', async t => {
  const directory = fixture(t);
  const cases = [
    { expectation: 'zero', exit: 0, evidence: 'publisher completed' },
    { expectation: 'nonzero', exit: 7, evidence: 'publisher retained root' },
  ];

  for (const testCase of cases) {
    const marker = path.join(directory, `${testCase.expectation}-child-survived`);
    const capture = path.join(directory, `${testCase.expectation}.capture`);
    const command = [
      '/bin/sh',
      '-c',
      `trap '' HUP TERM; (sleep 1; touch "$1") & printf '%s\\n' "$2"; exit "$3"`,
      'publisher-descendant',
      marker,
      testCase.evidence,
      String(testCase.exit),
    ];
    const result = runPublisher(
      testCase.expectation,
      capture,
      directory,
      [testCase.evidence],
      command,
    );

    assert.equal(result.status, 0, result.stderr);
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(fs.existsSync(marker), false, `${testCase.expectation} left a descendant`);
  }
});

test('bounded runner enforces the byte cap for UTF-8 output', t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'utf8.capture');
  const result = runPublisher(
    'zero',
    capture,
    directory,
    ['never reached'],
    ['/usr/bin/perl', '-CS', '-e', 'print "😀" x 20000; sleep 10'],
  );

  assert.equal(result.status, 125, result.stderr);
  assert.ok(fs.statSync(capture).size <= 65536);
});

test('bounded runner times out and kills the complete process group', async t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'timeout.capture');
  const marker = path.join(directory, 'timeout-child-survived');
  const result = runPublisher(
    'zero',
    capture,
    directory,
    ['never reached'],
    [
      '/bin/sh',
      '-c',
      '(sleep 1; touch "$1") & sleep 10',
      'publisher-timeout',
      marker,
    ],
    { env: { LOCAL_BINARY_CACHE_RUNNER_TEST_TIMEOUT: '0.2' } },
  );

  assert.equal(result.status, 124, result.stderr);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(marker), false);
});

test('bounded runner kills the complete process group on overflow', async t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'overflow.capture');
  const marker = path.join(directory, 'overflow-child-survived');
  const result = runPublisher(
    'zero',
    capture,
    directory,
    ['never reached'],
    [
      '/bin/sh',
      '-c',
      '(sleep 1; touch "$1") & exec /usr/bin/yes x',
      'publisher-overflow',
      marker,
    ],
  );

  assert.equal(result.status, 125, result.stderr);
  assert.ok(fs.statSync(capture).size <= 65536);
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(fs.existsSync(marker), false);
});

test('bounded runner kills the complete process group when capture writes fail', async t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'write-failure.capture');
  const pidDirectory = path.join(directory, 'write-failure-pids');
  const marker = path.join(directory, 'write-failure-child-survived');
  fs.mkdirSync(pidDirectory);
  const command = [
    '/bin/sh',
    '-c',
    `mkdir "$1/$$"; trap '' HUP TERM; (sleep 1; mkdir "$2") & printf 'trigger\n'; sleep 10`,
    'publisher-write-failure',
    pidDirectory,
    marker,
  ];
  const args = [
    runner,
    'run',
    'zero',
    capture,
    directory,
    '1',
    'never reached',
    '--',
    ...command,
  ];
  const result = childProcess.spawnSync(
    '/bin/bash',
    ['-c', "trap '' XFSZ; ulimit -f 0; exec \"$@\"", 'capture-limit', '/usr/bin/perl', ...args],
    {
      cwd: directory,
      encoding: 'utf8',
      env: { ...process.env, LOCAL_BINARY_CACHE_RUNNER_TEST_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5_000,
    },
  );

  const pidEntries = fs.readdirSync(pidDirectory);
  assert.equal(pidEntries.length, 1, `expected one publisher PID, got ${pidEntries.join(',')}`);
  const publisherPid = Number.parseInt(pidEntries[0], 10);
  assert.equal(Number.isSafeInteger(publisherPid), true);
  await new Promise(resolve => setTimeout(resolve, 1200));
  const groupAlive = processGroupExists(publisherPid);
  const orphanSurvived = fs.existsSync(marker);

  try {
    assert.equal(result.status, 68, result.stderr);
    assert.equal(groupAlive, false, `capture write failure left process group ${publisherPid} alive`);
    assert.equal(orphanSurvived, false, 'capture write failure left a descendant alive');
  } finally {
    if (processGroupExists(publisherPid)) {
      process.kill(-publisherPid, 'SIGKILL');
    }
  }
});

test('bounded runner kills and reaps its process group on HUP, INT, and TERM', async t => {
  const directory = fixture(t);
  const signals = [
    ['SIGHUP', 129],
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ];

  for (const [signal, expectedCode] of signals) {
    const capture = path.join(directory, `${signal}.capture`);
    const pidFile = path.join(directory, `${signal}.pid`);
    const started = path.join(directory, `${signal}.started`);
    const marker = path.join(directory, `${signal}-child-survived`);
    const args = [
      runner,
      'run',
      'zero',
      capture,
      directory,
      '1',
      'never reached',
      '--',
      '/bin/sh',
      '-c',
      `trap '' HUP TERM; printf '%s\\n' "$$" > "$1"; touch "$2"; `
        + '(sleep 1; touch "$3") & sleep 10',
      'publisher-signal',
      pidFile,
      started,
      marker,
    ];
    const child = childProcess.spawn('/usr/bin/perl', args, {
      cwd: directory,
      env: { ...process.env, LOCAL_BINARY_CACHE_RUNNER_TEST_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    const exit = waitForExit(child);
    let publisherPid;

    try {
      await waitForPath(started);
      publisherPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
      assert.equal(Number.isSafeInteger(publisherPid), true);
      assert.equal(child.kill(signal), true);
      const result = await exit;
      assert.equal(result.signal, null, `${signal}: ${stderr}`);
      assert.equal(result.code, expectedCode, `${signal}: ${stderr}`);
      assert.equal(processGroupExists(publisherPid), false, `${signal} left its process group`);
      await new Promise(resolve => setTimeout(resolve, 1100));
      assert.equal(fs.existsSync(marker), false, `${signal} left a descendant`);
    } finally {
      if (publisherPid !== undefined && processGroupExists(publisherPid)) {
        process.kill(-publisherPid, 'SIGKILL');
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  }
});

test('bounded runner preserves the first status during overlapping cleanup signals', async t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'overlapping-signals.capture');
  const pidFile = path.join(directory, 'overlapping-signals.pid');
  const started = path.join(directory, 'overlapping-signals.started');
  const marker = path.join(directory, 'overlapping-signals-child-survived');
  const args = [
    runner,
    'run',
    'zero',
    capture,
    directory,
    '1',
    'never reached',
    '--',
    '/bin/sh',
    '-c',
    `trap '' HUP TERM; printf '%s\n' "$$" > "$1"; touch "$2"; `
      + '(sleep 1; touch "$3") & sleep 10',
    'publisher-overlapping-signals',
    pidFile,
    started,
    marker,
  ];
  const child = childProcess.spawn('/usr/bin/perl', args, {
    cwd: directory,
    env: {
      ...process.env,
      LOCAL_BINARY_CACHE_RUNNER_TEST_CLEANUP_DELAY: '1',
      LOCAL_BINARY_CACHE_RUNNER_TEST_MODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const exit = waitForExit(child);
  let publisherPid;

  try {
    await waitForPath(started);
    publisherPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10);
    assert.equal(child.kill('SIGTERM'), true);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(child.kill('SIGINT'), true);
    const result = await exit;
    assert.equal(result.signal, null, stderr);
    assert.equal(result.code, 143, stderr);
    assert.equal(processGroupExists(publisherPid), false, 'overlapping signals left process group alive');
    await new Promise(resolve => setTimeout(resolve, 1100));
    assert.equal(fs.existsSync(marker), false, 'overlapping signals left descendant alive');
  } finally {
    if (publisherPid !== undefined && processGroupExists(publisherPid)) {
      process.kill(-publisherPid, 'SIGKILL');
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
});

test('capture path special files fail closed without blocking', t => {
  const directory = fixture(t);
  const target = path.join(directory, 'target');
  fs.writeFileSync(target, 'target');

  const symlink = path.join(directory, 'capture.symlink');
  fs.symlinkSync(target, symlink);
  const fifo = path.join(directory, 'capture.fifo');
  childProcess.execFileSync('/usr/bin/mkfifo', [fifo]);
  const dir = path.join(directory, 'capture.directory');
  fs.mkdirSync(dir);

  for (const capture of [symlink, fifo, dir, '/dev/null']) {
    const result = runPublisher(
      'zero',
      capture,
      directory,
      ['unused'],
      ['/bin/sh', '-c', 'exit 0'],
      { timeout: 1_000 },
    );
    assert.equal(result.error, undefined, `capture blocked: ${capture}`);
    assert.notEqual(result.status, 0, `capture was accepted: ${capture}`);
  }
});

test('capture path replacement during invocation fails closed', async t => {
  const directory = fixture(t);
  const capture = path.join(directory, 'replacement.capture');
  const moved = `${capture}.moved`;
  const started = path.join(directory, 'publisher-started');
  const args = [
    runner,
    'run',
    'zero',
    capture,
    directory,
    '1',
    'publisher completed',
    '--',
    '/bin/sh',
    '-c',
    'touch "$1"; sleep 0.5; printf "%s\\n" "publisher completed"',
    'replacement-publisher',
    started,
  ];
  const child = childProcess.spawn('/usr/bin/perl', args, {
    cwd: directory,
    env: { ...process.env, LOCAL_BINARY_CACHE_RUNNER_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });

  const deadline = Date.now() + 2_000;
  while (!fs.existsSync(started) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(started), true, 'publisher did not start');
  fs.renameSync(capture, moved);
  fs.writeFileSync(capture, 'replacement evidence\n', { mode: 0o600 });

  const code = await new Promise(resolve => child.once('close', resolve));
  assert.notEqual(code, 0, stderr);
  assert.match(stderr, /capture path was replaced/);
});

test('run ticket is atomically consumed once', t => {
  const directory = fixture(t);
  const ticket = path.join(directory, 'run.ticket');
  const consumed = `${ticket}.consumed`;
  const payload = 'run-id\noutput\nchallenge\npublisher\nworking-directory';

  assert.equal(run(['ticket-create', ticket, payload]).status, 0);
  assert.equal(run(['ticket-consume', ticket, consumed, payload]).status, 0);
  assert.equal(fs.existsSync(ticket), false);
  assert.equal(fs.readFileSync(consumed, 'utf8'), payload);
  assert.notEqual(run(['ticket-consume', ticket, `${consumed}.again`, payload]).status, 0);
});

test('cursor helper architecture is removed', () => {
  assert.equal(
    fs.existsSync(path.join(repoRoot, 'tests/local-binary-cache/outage-log-cursor.sh')),
    false,
  );
});
