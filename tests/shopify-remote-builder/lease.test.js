'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEnvironment,
  nixEvalJson,
  repoRoot,
  runExecutable,
} = require('./helpers');
const {
  getDerivationGraph,
  getPublicCacheFixture,
} = require('./fixtures');

const LEASE_PATH = path.join(repoRoot, 'scripts/shopify-remote-builder-lease.nix');
const STORE_PATH_RE = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9._+-]+$/;

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-lease-read-only', `
    const childProcess = require('node:child_process');
    const result = childProcess.spawnSync('nix', [process.argv[2], '--read-only', ...process.argv.slice(3)], {
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    process.exit(result.status ?? 1);
  `);
}

function leaseStateDirectory(fixture) {
  const stateDirectory = path.join(fixture.paths.state, 'shopify-remote-builder', 'requests');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  return fs.realpathSync(stateDirectory);
}

function createRootAdder(fixture, options = {}) {
  const logPath = path.join(fixture.paths.logs, options.name ?? 'lease-root-adder.jsonl');
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const failOnCall = options.failOnCall ?? null;
  const wrongTarget = options.wrongTarget ?? null;
  const executable = fixture.createExecutable(options.name ?? 'lease-root-adder', `
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const args = process.argv.slice(2);
    const calls = fs.readFileSync(logPath, 'utf8').split('\\n').filter(Boolean);
    fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
    if (args.length !== 4 || args[0] !== '--add-root' || args[2] !== '--indirect') {
      process.stderr.write('invalid root invocation\\n');
      process.exit(64);
    }
    if (${JSON.stringify(failOnCall)} !== null && calls.length + 1 === ${JSON.stringify(failOnCall)}) {
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(args[1]), { recursive: true });
    fs.symlinkSync(${JSON.stringify(wrongTarget)} ?? args[3], args[1]);
  `);
  return {
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    executable,
    logPath,
  };
}

function loadLease(fixture, options = {}) {
  const stateDirectory = options.stateDirectory ?? leaseStateDirectory(fixture);
  const rootAdder = options.rootAdder ?? createRootAdder(fixture, options.rootAdderOptions);
  const ownerUid = options.ownerUid ?? process.getuid();
  const packageArguments = [
    `ownerUid = ${Number(ownerUid)};`,
    `rootAdderExecutable = ${nixString(rootAdder.executable)};`,
    `stateDirectory = ${nixString(stateDirectory)};`,
  ];
  for (const [name, value] of Object.entries(options.numericOptions ?? {})) {
    packageArguments.push(`${name} = ${Number(value)};`);
  }
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ${nixString(LEASE_PATH)} {
        ${packageArguments.join('\n        ')}
      }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-lease');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return { executable, rootAdder, stateDirectory };
}

function buildLeasePackage(fixture) {
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in pkgs.callPackage ${nixString(LEASE_PATH)} { }
  `;
  const environment = nixEnvironment({ fixture });
  delete environment.NIX_CACHE_DIR;
  delete environment.NIX_LOG_DIR;
  delete environment.NIX_STATE_DIR;
  environment.NIX_REMOTE = 'daemon';
  return childProcess.spawnSync(
    'nix',
    ['build', '--impure', '--no-link', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: environment,
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

function makeRequest(fixture, overrides = {}) {
  const graph = getDerivationGraph('public-v1');
  const cache = getPublicCacheFixture('public');
  const stateDirectory = leaseStateDirectory(fixture);
  const nonce = overrides.nonce ?? 'fixture-lease-create-0001';
  const token = overrides.token
    ?? `srb1-${nonce}-${'a'.repeat(64)}`;
  const graphPaths = [
    ...graph.derivations.map(derivation => derivation.path),
    ...Object.keys(graph.references),
    ...Object.values(graph.references).flat(),
  ]
    .filter((storePath, index, values) => values.indexOf(storePath) === index)
    .sort();
  const outputPaths = graph.derivations
    .flatMap(derivation => derivation.outputs.map(output => output.path))
    .sort();
  const rootedPaths = graphPaths;
  const requestRoot = path.join(stateDirectory, nonce);
  const rootDestinations = rootedPaths.map(storePath => ({
    destination: path.join(requestRoot, 'roots', path.basename(storePath)),
    storePath,
  }));
  const request = {
    schemaVersion: 1,
    operation: 'create',
    nonce,
    token,
    requestParent: stateDirectory,
    ownership: {
      uid: process.getuid(),
    },
    authorization: {
      channel: 'local-pipe',
      operation: 'create',
      uid: process.getuid(),
    },
    graphDigest: graph.graphIdentity.graphDigest,
    graph: {
      digest: graph.graphIdentity.graphDigest,
      outputPaths,
      paths: graphPaths,
      referenceClosures: graph.referenceClosures,
      topOutput: graph.topOutput,
    },
    rootedPaths,
    rootDestinations,
    selectedInputOutputs: [graph.cacheRoot],
    expectedOutputs: [graph.topOutput],
    publicCacheCuts: [{
      closure: cache.publicCacheCut.closure,
      closureDigest: cache.publicCacheCut.closureDigest,
      rootPath: cache.publicCacheCut.rootPath,
    }],
  };
  const merged = {
    ...request,
    ...overrides,
    graph: { ...request.graph, ...(overrides.graph ?? {}) },
    ownership: { ...request.ownership, ...(overrides.ownership ?? {}) },
    authorization: { ...request.authorization, ...(overrides.authorization ?? {}) },
  };
  delete merged.rootDestinations;
  merged.rootDestinations = overrides.rootDestinations ?? rootDestinations;
  return merged;
}

function runLease(lease, fixture, request, args = ['create']) {
  const result = runExecutable(lease.executable, args, {
    fixture,
    input: `${JSON.stringify(request)}\n`,
  });
  const output = result.stdout.trim() === '' ? null : JSON.parse(result.stdout);
  return { ...result, output };
}

function requestRoot(request) {
  return path.join(request.requestParent, request.nonce);
}

function modeOf(filePath) {
  return fs.statSync(filePath).mode & 0o777;
}

function assertNoLeaseState(lease, request) {
  assert.equal(fs.existsSync(requestRoot(request)), false);
  assert.equal(fs.lstatSync(lease.stateDirectory).isSymbolicLink(), false);
  assert.equal(fs.readdirSync(lease.stateDirectory).length, 0);
}

test('lease production derivation passes writeShellApplication checks', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const result = buildLeasePackage(fixture);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test('create roots exactly the validated graph paths and persists mode-0700 state', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const lease = loadLease(fixture);
    const request = makeRequest(fixture);
    const result = runLease(lease, fixture, request);
    const root = requestRoot(request);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.output, {
      decision: 'created',
      detail: null,
      expectedOutputs: request.expectedOutputs,
      graphDigest: request.graphDigest,
      leaseToken: request.token,
      nonce: request.nonce,
      operation: 'create',
      publicCacheCuts: request.publicCacheCuts.map(cut => ({
        closureDigest: cut.closureDigest,
        rootPath: cut.rootPath,
      })),
      rootedPaths: request.rootedPaths,
      schemaVersion: 1,
      selectedInputOutputs: request.selectedInputOutputs,
    });
    assert.equal(result.output.requestParent, undefined);
    assert.equal(result.stdout.trim().split('\n').length, 1);
    assert.equal(modeOf(root), 0o700);
    assert.equal(modeOf(path.join(root, 'roots')), 0o700);
    assert.equal(modeOf(path.join(root, 'manifest.json')), 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')), request);

    const expectedCalls = request.rootedPaths.map(storePath => ({
      args: [
        '--add-root',
        path.join(root, 'roots', path.basename(storePath)),
        '--indirect',
        storePath,
      ],
    }));
    assert.deepEqual(
      lease.rootAdder.calls().map(call => ({ args: call.args })),
      expectedCalls,
    );
    for (const rootEntry of request.rootDestinations) {
      const marker = rootEntry.destination;
      assert.equal(fs.lstatSync(marker).isSymbolicLink(), true, marker);
      assert.equal(fs.readlinkSync(marker), rootEntry.storePath, marker);
    }
    assert.equal(fs.existsSync(path.join(root, 'active.lock')), false);
    assert.equal(fs.existsSync(path.join(root, 'heartbeat.json')), false);
  } finally {
    fixture.cleanup();
  }
});

test('create rejects invalid manifests before creating state or invoking root operations', () => {
  const cases = [
    {
      name: 'forged token nonce',
      mutate: request => {
        request.token = `srb1-other-nonce-${'b'.repeat(64)}`;
      },
    },
    {
      name: 'wrong canonical parent',
      mutate: request => {
        request.requestParent = path.join(path.dirname(request.requestParent), 'wrong-parent');
      },
    },
    {
      name: 'graph digest mismatch',
      mutate: request => {
        request.graph.digest = `sha256:${'b'.repeat(64)}`;
      },
    },
    {
      name: 'unauthorized ownership',
      mutate: request => {
        request.ownership.uid += 1;
      },
    },
    {
      name: 'wrong authorization channel',
      mutate: request => {
        request.authorization.channel = 'remote-ssh';
      },
    },
    {
      name: 'unlisted selected path',
      mutate: request => {
        request.selectedInputOutputs = ['/nix/store/99999999999999999999999999999999-not-graph'];
      },
    },
    {
      name: 'selected input output omitted from rooted paths',
      mutate: request => {
        const omittedPath = request.selectedInputOutputs[0];
        request.rootedPaths = request.rootedPaths.filter(storePath => storePath !== omittedPath);
        request.rootDestinations = request.rootedPaths.map(storePath => ({
          destination: path.join(requestRoot(request), 'roots', path.basename(storePath)),
          storePath,
        }));
        request.publicCacheCuts = [];
      },
    },
    {
      name: 'expected output omitted from rooted paths',
      mutate: request => {
        const omittedPath = request.expectedOutputs[0];
        request.rootedPaths = request.rootedPaths.filter(storePath => storePath !== omittedPath);
        request.rootDestinations = request.rootedPaths.map(storePath => ({
          destination: path.join(requestRoot(request), 'roots', path.basename(storePath)),
          storePath,
        }));
      },
    },
    {
      name: 'unlisted rooted path',
      mutate: request => {
        const storePath = '/nix/store/99999999999999999999999999999999-not-graph';
        request.rootedPaths = [...request.rootedPaths, storePath].sort();
        request.rootDestinations = [...request.rootDestinations, {
          destination: path.join(requestRoot(request), 'roots', path.basename(storePath)),
          storePath,
        }].sort((left, right) => left.storePath.localeCompare(right.storePath));
      },
    },
    {
      name: 'malformed store path',
      mutate: request => {
        request.selectedInputOutputs = ['/nix/store/../escape'];
      },
    },
    {
      name: 'duplicate path list',
      mutate: request => {
        request.selectedInputOutputs = [request.selectedInputOutputs[0], request.selectedInputOutputs[0]];
      },
    },
    {
      name: 'unsorted path list',
      mutate: request => {
        request.rootedPaths = [request.rootedPaths[1], request.rootedPaths[0], ...request.rootedPaths.slice(2)];
      },
    },
    {
      name: 'cache cut closure mismatch',
      mutate: request => {
        request.publicCacheCuts[0].closure = request.publicCacheCuts[0].closure.slice(0, -1);
      },
    },
    {
      name: 'root destination escape',
      mutate: request => {
        request.rootDestinations[0].destination = path.join(
          path.dirname(request.requestParent),
          'outside-root',
        );
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createRemoteBuilderFixture();
    try {
      const lease = loadLease(fixture);
      const request = makeRequest(fixture);
      testCase.mutate(request);
      const before = fs.readdirSync(lease.stateDirectory);
      const result = runLease(lease, fixture, request);
      const serialized = JSON.stringify(result.output);

      assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', testCase.name);
      assert.equal(result.output.detail, 'lease request rejected', testCase.name);
      assert.equal(result.output.nonce, null, testCase.name);
      assert.equal(result.output.leaseToken, null, testCase.name);
      assert.doesNotMatch(serialized, /fixture-lease-create-0001/);
      assert.doesNotMatch(serialized, /outside-root|wrong-parent/);
      assert.equal(result.stdout.trim().split('\n').length, 1, testCase.name);
      assert.ok(result.stdout.length <= 1024, testCase.name);
      assert.deepEqual(fs.readdirSync(lease.stateDirectory), before, testCase.name);
      assertNoLeaseState(lease, request);
      assert.equal(lease.rootAdder.calls().length, 0, testCase.name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('create validates root symlink targets and removes partial roots on root failure', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const lease = loadLease(fixture, {
      rootAdderOptions: {
        failOnCall: 2,
        name: 'lease-root-adder-fails',
      },
    });
    const request = makeRequest(fixture);
    const result = runLease(lease, fixture, request);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'root operation failed');
    assert.equal(result.output.detail, 'lease roots could not be created');
    assert.doesNotMatch(JSON.stringify(result.output), /fixture-lease-create-0001|\/nix\/store/);
    assertNoLeaseState(lease, request);
    assert.equal(lease.rootAdder.calls().length, 2);
  } finally {
    fixture.cleanup();
  }

  const poisonedFixture = createRemoteBuilderFixture();
  try {
    const lease = loadLease(poisonedFixture, {
      rootAdderOptions: {
        name: 'lease-root-adder-poisoned',
        wrongTarget: '/nix/store/99999999999999999999999999999999-poisoned',
      },
    });
    const request = makeRequest(poisonedFixture);
    const result = runLease(lease, poisonedFixture, request);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'root operation failed');
    assertNoLeaseState(lease, request);
    assert.equal(lease.rootAdder.calls().length, 1);
  } finally {
    poisonedFixture.cleanup();
  }
});

test('create fails closed when the request nonce already has lease state', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const lease = loadLease(fixture);
    const request = makeRequest(fixture);
    const first = runLease(lease, fixture, request);
    const callsAfterFirst = lease.rootAdder.calls().length;
    const second = runLease(lease, fixture, request);

    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(second.output.decision, 'ineligible');
    assert.equal(second.output.reason, 'lease state exists');
    assert.equal(lease.rootAdder.calls().length, callsAfterFirst);
  } finally {
    fixture.cleanup();
  }
});

test('lease command exposes only the provisional create operation', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const lease = loadLease(fixture);
    const request = makeRequest(fixture);
    const result = runLease(lease, fixture, request, ['prepare']);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'ineligible');
    assert.equal(result.output.reason, 'unsupported operation');
    assert.equal(result.output.detail, 'lease operation is not available');
    assertNoLeaseState(lease, request);
    assert.equal(lease.rootAdder.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('lease requests reject non-store root values before any filesystem mutation', () => {
  assert.equal(STORE_PATH_RE.test('/nix/store/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-valid'), true);
  assert.equal(STORE_PATH_RE.test('/nix/store/../escape'), false);
});
