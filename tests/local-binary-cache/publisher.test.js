'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  createScriptFixture,
  runScript,
} = require('./helpers');

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
