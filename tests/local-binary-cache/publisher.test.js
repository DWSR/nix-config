'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildScript,
  createScriptFixture,
  runScript,
} = require('./helpers');

const HASH_A = '0123456789abcdfghijklmnpqrsvwxyz';
const HASH_B = '11111111111111111111111111111111';

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
