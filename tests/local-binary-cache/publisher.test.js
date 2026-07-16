'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

const {
  buildScript,
  createScriptFixture,
  runScript,
} = require('./helpers');

const HASH_A = '0123456789abcdfghijklmnpqrsvwxyz';
const HASH_B = '11111111111111111111111111111111';
const HASH_C = '22222222222222222222222222222222';
const HASH_D = '33333333333333333333333333333333';
const CACHE_ENDPOINT = 'https://cache.example.test:8443';
const CACHE_NAME = 'darwin';
const TOKEN_VALUE = 'poisoned-runtime-token-value';

function createEnqueueFixture(t) {
  const fixture = createScriptFixture({
    executables: {
      nixStore: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        fs.appendFileSync(process.env.NIX_STORE_LOG, JSON.stringify(args) + '\\n');

        if (args.length !== 4 || args[0] !== '--add-root' || args[2] !== '--realise') {
          process.stderr.write('unexpected nix-store arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }

        const root = args[1];
        const output = args[3];
        if (process.env.NIX_STORE_FAIL_FOR === output) {
          process.stderr.write('stub root creation failed for ' + output + '\\n');
          process.exit(23);
        }
        if (!fs.existsSync(path.dirname(root))) {
          process.stderr.write('pending directory was not created before nix-store invocation\\n');
          process.exit(65);
        }

        const temporaryRoot = root + '.tmp.' + process.pid;
        fs.rmSync(temporaryRoot, { force: true });
        fs.symlinkSync(output, temporaryRoot);
        fs.renameSync(temporaryRoot, root);
      `,
    },
    statePaths: {
      log: 'state/nix-store.log',
      pending: 'state/pending',
      store: 'store',
    },
  });
  t.after(fixture.cleanup);

  const executable = buildScript('scripts/local-binary-cache-enqueue.nix', {
    nixStoreExecutable: fixture.executables.nixStore,
    pendingDirectory: fixture.statePaths.pending,
    storeDirectory: fixture.statePaths.store,
  });
  return { executable, fixture };
}

function enqueueEnvironment(fixture, outPaths, extra = {}) {
  return {
    NIX_STORE_LOG: fixture.statePaths.log,
    ...(outPaths === undefined ? {} : { OUT_PATHS: outPaths }),
    ...extra,
  };
}

function readInvocations(fixture) {
  if (!fs.existsSync(fixture.statePaths.log)) {
    return [];
  }
  return fs.readFileSync(fixture.statePaths.log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
}

function createPublisherFixture(t, options = {}) {
  const fixture = createScriptFixture({
    executables: {
      attic: `
        const fs = require('node:fs');
        const path = require('node:path');
        const args = process.argv.slice(2);
        const configPath = path.join(process.env.XDG_CONFIG_HOME, 'attic', 'config.toml');
        const config = fs.readFileSync(configPath, 'utf8');
        const target = args.at(-1);
        const prior = fs.existsSync(process.env.ATTIC_LOG)
          ? fs.readFileSync(process.env.ATTIC_LOG, 'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)
          : [];
        fs.appendFileSync(process.env.ATTIC_LOG, JSON.stringify({ args, config }) + '\\n');

        if (args.length !== 5 || args[0] !== 'push' || args[1] !== '-j' || args[2] !== '1') {
          process.stderr.write('unexpected attic arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }
        if (process.env.ATTIC_FAIL_FOR === target) {
          process.stderr.write('stub push failed for ' + target + '\\n');
          process.exit(23);
        }
        if (
          process.env.ATTIC_FAIL_ONCE_FOR === target
          && prior.filter(invocation => invocation.args.at(-1) === target).length === 0
        ) {
          process.stderr.write('stub push failed once for ' + target + '\\n');
          process.exit(24);
        }
        if (process.env.ATTIC_ALREADY_PRESENT_FOR === target) {
          process.stderr.write('already present: ' + target + '\\n');
        }
        if (process.env.ATTIC_HOLD_FOR === target) {
          fs.writeFileSync(process.env.ATTIC_READY_FILE, target);
          while (!fs.existsSync(process.env.ATTIC_RELEASE_FILE)) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
          }
        }
      `,
      shlock: `
        const fs = require('node:fs');
        const args = process.argv.slice(2);
        if (args.length !== 4 || args[0] !== '-p' || args[2] !== '-f') {
          process.stderr.write('unexpected shlock arguments: ' + JSON.stringify(args) + '\\n');
          process.exit(64);
        }

        const owner = Number(args[1]);
        const lock = args[3];
        while (true) {
          try {
            const descriptor = fs.openSync(lock, 'wx', 0o600);
            fs.writeFileSync(descriptor, String(owner) + '\\n');
            fs.closeSync(descriptor);
            process.exit(0);
          } catch (error) {
            if (error.code !== 'EEXIST') throw error;
          }

          const existingOwner = Number(fs.readFileSync(lock, 'utf8').trim());
          try {
            process.kill(existingOwner, 0);
            process.exit(1);
          } catch (error) {
            if (error.code !== 'ESRCH') throw error;
            fs.rmSync(lock, { force: true });
          }
        }
      `,
    },
    statePaths: {
      log: 'state/attic.log',
      pending: 'state/pending',
      publisher: 'state/publisher',
      ready: 'state/attic.ready',
      release: 'state/attic.release',
      store: 'store',
      token: 'secrets/push-token',
    },
  });
  t.after(fixture.cleanup);

  if (options.withToken !== false) {
    fs.writeFileSync(fixture.statePaths.token, TOKEN_VALUE, { mode: 0o400 });
  }

  const executable = buildScript('scripts/local-binary-cache-publish.nix', {
    atticExecutable: fixture.executables.attic,
    cacheName: CACHE_NAME,
    endpoint: CACHE_ENDPOINT,
    pendingDirectory: fixture.statePaths.pending,
    shlockExecutable: fixture.executables.shlock,
    stateDirectory: fixture.statePaths.publisher,
    storeDirectory: fixture.statePaths.store,
    tokenFile: fixture.statePaths.token,
  });
  return { executable, fixture };
}

function publisherEnvironment(fixture, extra = {}) {
  return {
    ATTIC_LOG: fixture.statePaths.log,
    ...extra,
  };
}

function createPendingRoot(fixture, hash, name, options = {}) {
  const output = path.join(fixture.statePaths.store, `${hash}-${name}`);
  const root = path.join(fixture.statePaths.pending, hash);
  fs.mkdirSync(fixture.statePaths.pending, { recursive: true });
  if (!options.broken) {
    fs.mkdirSync(output, { recursive: true });
  }
  fs.symlinkSync(output, root);
  return { output, root };
}

function readAtticInvocations(fixture) {
  return readInvocations(fixture);
}

function spawnPublisher(executable, fixture, env = {}) {
  const output = { stderr: '', stdout: '' };
  const child = childProcess.spawn(executable, [], {
    cwd: fixture.root,
    detached: true,
    env: {
      HOME: fixture.home,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: fixture.bin,
      TMPDIR: fixture.tmp,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const completed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ ...output, signal, status }));
  });
  return { child, completed };
}

async function waitForPath(filePath, child) {
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(filePath)) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`publisher exited before creating ${filePath}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(10);
  }
}

function holdingEnvironment(fixture, output) {
  return publisherEnvironment(fixture, {
    ATTIC_HOLD_FOR: output,
    ATTIC_READY_FILE: fixture.statePaths.ready,
    ATTIC_RELEASE_FILE: fixture.statePaths.release,
  });
}

test('script harness injects executable and state paths inside an isolated fixture', t => {
  const fixture = createScriptFixture({
    executables: {
      publisherProbe: `
        process.stdout.write(JSON.stringify({
          executable: process.argv[1],
          pending: process.env.LOCAL_BINARY_CACHE_PENDING,
          state: process.env.LOCAL_BINARY_CACHE_STATE,
        }));
      `,
    },
    statePaths: {
      pending: 'state/pending',
      state: 'state/publisher',
    },
  });
  t.after(fixture.cleanup);

  const result = runScript(fixture.executables.publisherProbe, [], {
    fixture,
    env: {
      LOCAL_BINARY_CACHE_PENDING: fixture.statePaths.pending,
      LOCAL_BINARY_CACHE_STATE: fixture.statePaths.state,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    executable: fixture.executables.publisherProbe,
    pending: fixture.statePaths.pending,
    state: fixture.statePaths.state,
  });

  for (const injectedPath of [
    ...Object.values(fixture.executables),
    ...Object.values(fixture.statePaths),
  ]) {
    assert.equal(path.isAbsolute(injectedPath), true);
    assert.equal(path.relative(fixture.root, injectedPath).startsWith('..'), false);
    assert.equal(injectedPath.startsWith('/nix/store/'), false);
  }
});

test('enqueue hook records every output under its deterministic store hash', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const first = `${fixture.statePaths.store}/${HASH_A}-first-output`;
  const second = `${fixture.statePaths.store}/${HASH_B}-second-output`;

  const result = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, `${first} ${second}`),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', first],
    ['--add-root', path.join(fixture.statePaths.pending, HASH_B), '--realise', second],
  ]);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_A)), first);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_B)), second);
});

test('enqueue hook coalesces repeated outputs onto one atomic root', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const output = `${fixture.statePaths.store}/${HASH_A}-duplicate-output`;

  const first = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, `${output} ${output}`),
  });
  const second = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, output),
  });

  assert.equal(first.status, 0, first.stderr);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', output],
    ['--add-root', path.join(fixture.statePaths.pending, HASH_A), '--realise', output],
  ]);
  assert.deepEqual(fs.readdirSync(fixture.statePaths.pending), [HASH_A]);
  assert.equal(fs.readlinkSync(path.join(fixture.statePaths.pending, HASH_A)), output);
});

test('enqueue hook rejects invalid output lists before recording any root', async t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const valid = `${fixture.statePaths.store}/${HASH_A}-valid-output`;
  const invalidCases = {
    'missing OUT_PATHS': undefined,
    'empty OUT_PATHS': '',
    'relative output': `${HASH_A}-relative`,
    'path outside the store': `${fixture.root}/${HASH_A}-outside`,
    'store directory itself': fixture.statePaths.store,
    'short store hash': `${fixture.statePaths.store}/abc-short`,
    'invalid store hash alphabet': `${fixture.statePaths.store}/${'e'.repeat(32)}-bad-alphabet`,
    'missing store name': `${fixture.statePaths.store}/${HASH_A}-`,
    'hidden store name': `${fixture.statePaths.store}/${HASH_A}-.hidden`,
    'nested path': `${fixture.statePaths.store}/${HASH_A}-name/child`,
    'dot component': `${fixture.statePaths.store}/./${HASH_A}-name`,
    'parent component': `${fixture.statePaths.store}/../store/${HASH_A}-name`,
    'empty component': `${fixture.statePaths.store}//${HASH_A}-name`,
    'case-variant store alias': `${fixture.statePaths.store.toUpperCase()}/${HASH_A}-name`,
    'newline-separated output': `${valid}\n${fixture.statePaths.store}/${HASH_B}-second`,
    'valid output followed by invalid output': `${valid} not-a-store-path`,
  };

  for (const [name, outPaths] of Object.entries(invalidCases)) {
    await t.test(name, () => {
      const result = runScript(executable, [], {
        fixture,
        env: enqueueEnvironment(fixture, outPaths),
      });

      assert.notEqual(result.status, 0, `unexpected success for ${name}`);
      assert.match(result.stderr, /OUT_PATHS|invalid output/);
      assert.equal(fs.existsSync(fixture.statePaths.pending), false, `queue state created for ${name}`);
      assert.deepEqual(readInvocations(fixture), [], `nix-store invoked for ${name}`);
    });
  }
});

test('enqueue hook reports a path-specific root creation failure', t => {
  const { executable, fixture } = createEnqueueFixture(t);
  const output = `${fixture.statePaths.store}/${HASH_A}-failing-output`;
  const root = path.join(fixture.statePaths.pending, HASH_A);

  const result = runScript(executable, [], {
    fixture,
    env: enqueueEnvironment(fixture, output, { NIX_STORE_FAIL_FOR: output }),
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, new RegExp(output.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.stderr, new RegExp(root.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.deepEqual(readInvocations(fixture), [
    ['--add-root', root, '--realise', output],
  ]);
  assert.equal(fs.existsSync(root), false);
});

test('publisher pushes valid roots in lexical order and removes each successful root', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const second = createPendingRoot(fixture, HASH_B, 'second-output');
  const first = createPendingRoot(fixture, HASH_A, 'first-output');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args), [
    ['push', '-j', '1', `local:${CACHE_NAME}`, first.output],
    ['push', '-j', '1', `local:${CACHE_NAME}`, second.output],
  ]);
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.existsSync(second.root), false);

  const invocations = readAtticInvocations(fixture);
  assert.equal(invocations[0].config, [
    '[servers.local]',
    `endpoint = "${CACHE_ENDPOINT}"`,
    `token-file = "${fixture.statePaths.token}"`,
    '',
  ].join('\n'));
  assert.equal([
    result.stdout,
    result.stderr,
    JSON.stringify(invocations),
    fs.readFileSync(executable, 'utf8'),
  ].join('\n').includes(TOKEN_VALUE), false);
});

test('publisher removes a root when Attic confirms it is already present', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'already-present');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture, { ATTIC_ALREADY_PRESENT_FOR: pending.output }),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /already present/);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher stops at a failed root, retains the remaining queue, and retries next run', t => {
  const { executable, fixture } = createPublisherFixture(t);
  const first = createPendingRoot(fixture, HASH_A, 'first-success');
  const failed = createPendingRoot(fixture, HASH_B, 'retry-output');
  const later = createPendingRoot(fixture, HASH_C, 'later-output');
  const env = publisherEnvironment(fixture, { ATTIC_FAIL_ONCE_FOR: failed.output });

  const failedRun = runScript(executable, [], { fixture, env });

  assert.notEqual(failedRun.status, 0);
  assert.ok(failedRun.stderr.includes(failed.output));
  assert.ok(failedRun.stderr.includes(failed.root));
  assert.equal(fs.existsSync(first.root), false);
  assert.equal(fs.lstatSync(failed.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(later.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    first.output,
    failed.output,
  ]);

  const retryRun = runScript(executable, [], { fixture, env });

  assert.equal(retryRun.status, 0, retryRun.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    first.output,
    failed.output,
    failed.output,
    later.output,
  ]);
  assert.equal(fs.existsSync(failed.root), false);
  assert.equal(fs.existsSync(later.root), false);
});

test('publisher logs and retains invalid or broken entries while processing later valid roots', t => {
  const { executable, fixture } = createPublisherFixture(t);
  fs.mkdirSync(fixture.statePaths.pending, { recursive: true });
  const invalid = path.join(fixture.statePaths.pending, HASH_A);
  fs.writeFileSync(invalid, 'not a symlink');
  const broken = createPendingRoot(fixture, HASH_B, 'broken-output', { broken: true });
  const valid = createPendingRoot(fixture, HASH_C, 'valid-output');
  const mismatched = createPendingRoot(fixture, HASH_D, 'wrong-hash');
  fs.rmSync(mismatched.root);
  fs.symlinkSync(valid.output, mismatched.root);

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stderr.includes(invalid));
  assert.ok(result.stderr.includes(broken.root));
  assert.ok(result.stderr.includes(mismatched.root));
  assert.equal(fs.existsSync(invalid), true);
  assert.equal(fs.lstatSync(broken.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(mismatched.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [valid.output]);
  assert.equal(fs.existsSync(valid.root), false);
});

test('publisher exits successfully without work while a live publisher holds the lock', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'locked-output');
  const holder = spawnPublisher(executable, fixture, holdingEnvironment(fixture, pending.output));
  t.after(() => {
    if (holder.child.exitCode === null && holder.child.signalCode === null) {
      process.kill(-holder.child.pid, 'SIGKILL');
    }
  });
  await waitForPath(fixture.statePaths.ready, holder.child);

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [pending.output]);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);

  fs.writeFileSync(fixture.statePaths.release, 'release');
  const holderResult = await holder.completed;
  assert.equal(holderResult.status, 0, holderResult.stderr);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher recovers a stale lock and retries after an unclean death', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const pending = createPendingRoot(fixture, HASH_A, 'stale-retry');
  const killed = spawnPublisher(executable, fixture, holdingEnvironment(fixture, pending.output));
  await waitForPath(fixture.statePaths.ready, killed.child);

  process.kill(-killed.child.pid, 'SIGKILL');
  const killedResult = await killed.completed;
  assert.equal(killedResult.signal, 'SIGKILL');
  assert.equal(fs.existsSync(path.join(fixture.statePaths.publisher, 'publish.lock')), true);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);

  const retry = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    pending.output,
    pending.output,
  ]);
  assert.equal(fs.existsSync(pending.root), false);
});

test('publisher terminates nonzero without unlinking or later work after SIGTERM', async t => {
  const { executable, fixture } = createPublisherFixture(t);
  const interrupted = createPendingRoot(fixture, HASH_A, 'interrupted-output');
  const later = createPendingRoot(fixture, HASH_B, 'later-output');
  const running = spawnPublisher(executable, fixture, holdingEnvironment(fixture, interrupted.output));
  t.after(() => {
    if (running.child.exitCode === null && running.child.signalCode === null) {
      process.kill(-running.child.pid, 'SIGKILL');
    }
  });
  await waitForPath(fixture.statePaths.ready, running.child);

  running.child.kill('SIGTERM');
  fs.writeFileSync(fixture.statePaths.release, 'release');
  const result = await running.completed;

  assert.notEqual(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(fixture.statePaths.publisher, 'publish.lock')), false);
  assert.equal(fs.lstatSync(interrupted.root).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(later.root).isSymbolicLink(), true);
  assert.deepEqual(readAtticInvocations(fixture).map(invocation => invocation.args.at(-1)), [
    interrupted.output,
  ]);
});

test('publisher reports a missing runtime token path without mutating the queue', t => {
  const { executable, fixture } = createPublisherFixture(t, { withToken: false });
  const pending = createPendingRoot(fixture, HASH_A, 'missing-token');

  const result = runScript(executable, [], {
    fixture,
    env: publisherEnvironment(fixture),
  });

  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(fixture.statePaths.token));
  assert.deepEqual(readAtticInvocations(fixture), []);
  assert.equal(fs.lstatSync(pending.root).isSymbolicLink(), true);
});
