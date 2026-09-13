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
const { digestValue } = require('./fixtures/schema');

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
  const orderLogPath = options.orderLogPath ?? null;
  if (orderLogPath !== null) {
    fs.writeFileSync(orderLogPath, '', { mode: 0o600 });
  }
  const failOnCall = options.failOnCall ?? null;
  const wrongTarget = options.wrongTarget ?? null;
  const executable = fixture.createExecutable(options.name ?? 'lease-root-adder', `
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const orderLogPath = ${JSON.stringify(orderLogPath)};
    const args = process.argv.slice(2);
    const calls = fs.readFileSync(logPath, 'utf8').split('\\n').filter(Boolean);
    fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
    if (orderLogPath !== null) {
      fs.appendFileSync(orderLogPath, JSON.stringify({ name: 'root-adder', args }) + '\\n');
    }
    if (
      args.length !== 5
      || args[0] !== '--add-root'
      || args[2] !== '--indirect'
      || args[3] !== '--realise'
    ) {
      process.stderr.write('invalid root invocation\\n');
      process.exit(64);
    }
    if (${JSON.stringify(failOnCall)} !== null && calls.length + 1 === ${JSON.stringify(failOnCall)}) {
      process.exit(1);
    }
    fs.mkdirSync(path.dirname(args[1]), { recursive: true });
    fs.symlinkSync(${JSON.stringify(wrongTarget)} ?? args[4], args[1]);
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

function createPrepareSeam(fixture, options = {}) {
  const name = options.name ?? 'lease-prepare-seam';
  const logPath = path.join(fixture.paths.logs, `${name}.jsonl`);
  const orderLogPath = options.orderLogPath ?? null;
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const failOnCall = options.failOnCall ?? null;
  const mode = options.mode ?? 'realize';
  const executable = fixture.createExecutable(name, `
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const orderLogPath = ${JSON.stringify(orderLogPath)};
    const args = process.argv.slice(2);
    const calls = fs.readFileSync(logPath, 'utf8').split('\\n').filter(Boolean);
    fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
    if (orderLogPath !== null) {
      fs.appendFileSync(orderLogPath, JSON.stringify({ name: ${JSON.stringify(name)}, args }) + '\\n');
    }
    if (${JSON.stringify(mode)} === 'realize') {
      if (args.length < 2 || args[0] !== '--realise') {
        process.stderr.write('invalid realize invocation\\n');
        process.exit(64);
      }
    } else if (
      args.length !== 4
      || args[0] !== '--add-root'
      || args[2] !== '--realise'
    ) {
      process.stderr.write('invalid prime invocation\\n');
      process.exit(64);
    }
    if (${JSON.stringify(failOnCall)} !== null && calls.length + 1 === ${JSON.stringify(failOnCall)}) {
      process.exit(1);
    }
    if (${JSON.stringify(mode)} === 'prime') {
      fs.mkdirSync(path.dirname(args[1]), { recursive: true });
      try {
        fs.unlinkSync(args[1]);
      } catch (error) {
        if (error.code !== 'ENOENT') {
          throw error;
        }
      }
      fs.symlinkSync(args[3], args[1]);
    }
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
  if (options.selectedInputRealizerExecutable !== undefined) {
    packageArguments.push(
      `selectedInputRealizerExecutable = ${nixString(options.selectedInputRealizerExecutable)};`,
    );
  }
  if (options.expectedOutputPrimerExecutable !== undefined) {
    packageArguments.push(
      `expectedOutputPrimerExecutable = ${nixString(options.expectedOutputPrimerExecutable)};`,
    );
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
  const { danglingExpectedOutput = false, ...requestOverrides } = overrides;
  const graph = getDerivationGraph('public-v1');
  const cache = getPublicCacheFixture('public');
  const stateDirectory = leaseStateDirectory(fixture);
  const nonce = overrides.nonce ?? 'fixture-lease-create-0001';
  const token = overrides.token
    ?? `srb1-${nonce}-${'a'.repeat(64)}`;
  const sourceGraphPaths = [
    ...graph.derivations.map(derivation => derivation.path),
    ...Object.keys(graph.references),
    ...Object.values(graph.references).flat(),
  ]
    .filter((storePath, index, values) => values.indexOf(storePath) === index)
    .sort();
  const storePathMap = existingStorePathMap(sourceGraphPaths);
  const danglingOutput = '/nix/store/99999999999999999999999999999999-dangling-top-output';
  const mapStorePath = storePath => storePath === graph.topOutput && danglingExpectedOutput
    ? danglingOutput
    : storePathMap.get(storePath) ?? storePath;
  const graphPaths = sourceGraphPaths.map(mapStorePath).sort();
  const outputPaths = graph.derivations
    .flatMap(derivation => derivation.outputs.map(output => output.path))
    .map(mapStorePath)
    .sort();
  const rootedPaths = graphPaths;
  const requestRoot = path.join(stateDirectory, nonce);
  const cacheClosure = cache.publicCacheCut.closure.map(mapStorePath).sort();
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
      referenceClosures: Object.fromEntries(
        Object.entries(graph.referenceClosures).map(([storePath, references]) => [
          mapStorePath(storePath),
          references.map(mapStorePath).sort(),
        ]),
      ),
      topOutput: mapStorePath(graph.topOutput),
    },
    rootedPaths,
    rootDestinations,
    selectedInputOutputs: [mapStorePath(graph.cacheRoot)],
    expectedOutputs: [mapStorePath(graph.topOutput)],
    publicCacheCuts: [{
      closure: cacheClosure,
      closureDigest: digestValue(cacheClosure),
      rootPath: mapStorePath(cache.publicCacheCut.rootPath),
    }],
  };
  const merged = {
    ...request,
    ...requestOverrides,
    graph: { ...request.graph, ...(requestOverrides.graph ?? {}) },
    ownership: { ...request.ownership, ...(requestOverrides.ownership ?? {}) },
    authorization: { ...request.authorization, ...(requestOverrides.authorization ?? {}) },
  };
  delete merged.rootDestinations;
  merged.rootDestinations = requestOverrides.rootDestinations ?? rootDestinations;
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

function existingStorePathMap(storePaths) {
  const entries = fs.readdirSync('/nix/store')
    .filter(entry => /^[a-z0-9]{32}-[A-Za-z0-9._+-]+$/.test(entry))
    .sort();
  assert.ok(entries.length >= storePaths.length, 'fixture requires enough existing Nix store paths');
  return new Map(storePaths.map((storePath, index) => [
    storePath,
    path.join('/nix/store', entries[index]),
  ]));
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
        '--realise',
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

test('prepare realizes selected inputs before priming absent expected outputs', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const orderLogPath = path.join(fixture.paths.logs, 'lease-prepare-order.jsonl');
    const selectedRealizer = createPrepareSeam(fixture, {
      name: 'lease-selected-realizer',
      orderLogPath,
    });
    const outputPrimer = createPrepareSeam(fixture, {
      mode: 'prime',
      name: 'lease-output-primer',
      orderLogPath,
    });
    const lease = loadLease(fixture, {
      expectedOutputPrimerExecutable: outputPrimer.executable,
      rootAdderOptions: { orderLogPath },
      selectedInputRealizerExecutable: selectedRealizer.executable,
    });
    const request = makeRequest(fixture);
    const created = runLease(lease, fixture, request);
    assert.equal(created.status, 0, created.stderr);

    const root = requestRoot(request);
    for (const storePath of [...request.selectedInputOutputs, ...request.expectedOutputs]) {
      fs.unlinkSync(path.join(root, 'roots', path.basename(storePath)));
    }
    fs.writeFileSync(orderLogPath, '', { mode: 0o600 });

    const result = runLease(lease, fixture, { injected: 'input ignored' }, [
      'prepare',
      request.token,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.output, {
      decision: 'prepared',
      detail: null,
      expectedOutputs: request.expectedOutputs,
      graphDigest: request.graphDigest,
      leaseToken: request.token,
      nonce: request.nonce,
      operation: 'prepare',
      rootedPaths: request.rootedPaths,
      schemaVersion: 1,
      selectedInputOutputs: request.selectedInputOutputs,
    });
    assert.deepEqual(selectedRealizer.calls().map(call => call.args), [[
      '--realise',
      ...request.selectedInputOutputs,
    ]]);
    assert.deepEqual(lease.rootAdder.calls().at(-1).args, [
      '--add-root',
      path.join(root, 'roots', path.basename(request.selectedInputOutputs[0])),
      '--indirect',
      '--realise',
      request.selectedInputOutputs[0],
    ]);
    assert.deepEqual(outputPrimer.calls().map(call => call.args), [[
      '--add-root',
      path.join(root, 'roots', path.basename(request.expectedOutputs[0])),
      '--realise',
      request.expectedOutputs[0],
    ]]);
    assert.deepEqual(
      fs.readFileSync(orderLogPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line).name),
      ['lease-selected-realizer', 'root-adder', 'lease-output-primer'],
    );
    for (const storePath of [...request.selectedInputOutputs, ...request.expectedOutputs]) {
      const marker = path.join(root, 'roots', path.basename(storePath));
      assert.equal(fs.lstatSync(marker).isSymbolicLink(), true, marker);
      assert.equal(fs.readlinkSync(marker), storePath, marker);
    }
  } finally {
    fixture.cleanup();
  }
});

test('prepare skips an already-valid expected output root and ignores caller-selected paths', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const selectedRealizer = createPrepareSeam(fixture, { name: 'lease-selected-realizer' });
    const outputPrimer = createPrepareSeam(fixture, {
      mode: 'prime',
      name: 'lease-output-primer',
    });
    const lease = loadLease(fixture, {
      expectedOutputPrimerExecutable: outputPrimer.executable,
      selectedInputRealizerExecutable: selectedRealizer.executable,
    });
    const request = makeRequest(fixture);
    const created = runLease(lease, fixture, request);
    assert.equal(created.status, 0, created.stderr);

    const result = runLease(
      lease,
      fixture,
      {
        selectedInputOutputs: ['/nix/store/99999999999999999999999999999999-injected'],
      },
      ['prepare', request.token],
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'prepared');
    assert.deepEqual(selectedRealizer.calls().map(call => call.args), [[
      '--realise',
      ...request.selectedInputOutputs,
    ]]);
    assert.deepEqual(outputPrimer.calls(), []);
    assert.equal(fs.readlinkSync(
      path.join(requestRoot(request), 'roots', path.basename(request.expectedOutputs[0])),
    ), request.expectedOutputs[0]);
    assert.doesNotMatch(result.stdout, /99999999999999999999999999999999-injected/);
  } finally {
    fixture.cleanup();
  }
});

test('prepare re-primes a dangling expected output root before returning a valid marker', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const outputPrimer = createPrepareSeam(fixture, {
      mode: 'prime',
      name: 'lease-output-primer-dangling',
    });
    const lease = loadLease(fixture, {
      expectedOutputPrimerExecutable: outputPrimer.executable,
    });
    const request = makeRequest(fixture, { danglingExpectedOutput: true });
    const created = runLease(lease, fixture, request);
    assert.equal(created.status, 0, created.stderr);

    const marker = path.join(
      requestRoot(request),
      'roots',
      path.basename(request.expectedOutputs[0]),
    );
    assert.equal(fs.existsSync(marker), false);

    const result = runLease(lease, fixture, { caller: 'ignored' }, [
      'prepare',
      request.token,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'prepared');
    assert.deepEqual(outputPrimer.calls().map(call => call.args), [[
      '--add-root',
      marker,
      '--realise',
      request.expectedOutputs[0],
    ]]);
    assert.equal(fs.lstatSync(marker).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(marker), request.expectedOutputs[0]);
  } finally {
    fixture.cleanup();
  }
});

test('prepare rejects forged or corrupt persisted state before invoking realization seams', () => {
  const cases = [
    {
      name: 'invalid token grammar',
      mutate: () => {},
      token: () => 'not-a-lease-token',
    },
    {
      name: 'forged token',
      mutate: () => {},
      token: request => `srb1-${request.nonce}-${'b'.repeat(64)}`,
    },
    {
      name: 'unlisted manifest path',
      mutate: request => {
        request.selectedInputOutputs = [
          '/nix/store/99999999999999999999999999999999-unlisted',
        ];
      },
    },
    {
      name: 'graph digest mismatch',
      mutate: request => {
        request.graph.digest = `sha256:${'b'.repeat(64)}`;
      },
    },
    {
      name: 'root destination outside request root',
      mutate: request => {
        request.rootDestinations[0].destination = path.join(
          path.dirname(request.requestParent),
          'outside-root',
          path.basename(request.rootDestinations[0].destination),
        );
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createRemoteBuilderFixture();
    try {
      const selectedRealizer = createPrepareSeam(fixture, { name: 'lease-selected-realizer' });
      const outputPrimer = createPrepareSeam(fixture, {
        mode: 'prime',
        name: 'lease-output-primer',
      });
      const lease = loadLease(fixture, {
        expectedOutputPrimerExecutable: outputPrimer.executable,
        selectedInputRealizerExecutable: selectedRealizer.executable,
      });
      const request = makeRequest(fixture);
      const created = runLease(lease, fixture, request);
      assert.equal(created.status, 0, `${testCase.name}: ${created.stderr}`);
      const manifestPath = path.join(requestRoot(request), 'manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      testCase.mutate(manifest);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
      const token = testCase.token?.(request) ?? request.token;

      const result = runLease(lease, fixture, { caller: 'ignored' }, ['prepare', token]);
      const serialized = JSON.stringify(result.output);

      assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}`);
      assert.equal(result.output.operation, 'prepare', testCase.name);
      assert.equal(result.output.decision, 'ineligible', testCase.name);
      assert.equal(result.output.nonce, null, testCase.name);
      assert.equal(result.output.leaseToken, null, testCase.name);
      assert.doesNotMatch(serialized, /fixture-lease-create-0001|\/nix\/store|outside-root/);
      assert.ok(result.stdout.length <= 1024, testCase.name);
      assert.equal(selectedRealizer.calls().length, 0, testCase.name);
      assert.equal(outputPrimer.calls().length, 0, testCase.name);
    } finally {
      fixture.cleanup();
    }
  }

  const missingFixture = createRemoteBuilderFixture();
  try {
    const selectedRealizer = createPrepareSeam(missingFixture, {
      name: 'lease-selected-realizer-missing',
    });
    const outputPrimer = createPrepareSeam(missingFixture, {
      mode: 'prime',
      name: 'lease-output-primer-missing',
    });
    const lease = loadLease(missingFixture, {
      expectedOutputPrimerExecutable: outputPrimer.executable,
      selectedInputRealizerExecutable: selectedRealizer.executable,
    });
    const request = makeRequest(missingFixture);
    const result = runLease(lease, missingFixture, { forged: true }, [
      'prepare',
      request.token,
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.operation, 'prepare');
    assert.equal(result.output.decision, 'ineligible');
    assert.doesNotMatch(JSON.stringify(result.output), /fixture-lease-create-0001|\/nix\/store/);
    assert.ok(result.stdout.length <= 1024);
    assert.equal(selectedRealizer.calls().length, 0);
    assert.equal(outputPrimer.calls().length, 0);
  } finally {
    missingFixture.cleanup();
  }
});

test('prepare rejects a poisoned root or roots directory before any mutation', () => {
  for (const poison of ['target', 'directory']) {
    const fixture = createRemoteBuilderFixture();
    try {
      const selectedRealizer = createPrepareSeam(fixture, { name: `lease-selected-${poison}` });
      const outputPrimer = createPrepareSeam(fixture, {
        mode: 'prime',
        name: `lease-primer-${poison}`,
      });
      const lease = loadLease(fixture, {
        expectedOutputPrimerExecutable: outputPrimer.executable,
        selectedInputRealizerExecutable: selectedRealizer.executable,
      });
      const request = makeRequest(fixture);
      const created = runLease(lease, fixture, request);
      assert.equal(created.status, 0, `${poison}: ${created.stderr}`);
      const rootsDirectory = path.join(requestRoot(request), 'roots');
      if (poison === 'target') {
        const marker = path.join(rootsDirectory, path.basename(request.expectedOutputs[0]));
        fs.unlinkSync(marker);
        fs.symlinkSync(
          '/nix/store/99999999999999999999999999999999-poisoned',
          marker,
        );
      } else {
        fs.rmSync(rootsDirectory, { recursive: true });
        const outsideRoots = path.join(fixture.paths.data, `outside-roots-${poison}`);
        fs.mkdirSync(outsideRoots, { mode: 0o700 });
        fs.symlinkSync(outsideRoots, rootsDirectory);
      }

      const result = runLease(lease, fixture, { caller: 'ignored' }, [
        'prepare',
        request.token,
      ]);

      assert.equal(result.status, 0, `${poison}: ${result.stderr}`);
      assert.equal(result.output.operation, 'prepare', poison);
      assert.equal(result.output.decision, 'ineligible', poison);
      assert.doesNotMatch(JSON.stringify(result.output), /fixture-lease-create-0001|\/nix\/store/);
      assert.ok(result.stdout.length <= 1024, poison);
      assert.equal(selectedRealizer.calls().length, 0, poison);
      assert.equal(outputPrimer.calls().length, 0, poison);
    } finally {
      fixture.cleanup();
    }
  }
});

test('prepare removes roots created before a later realization or priming failure', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const selectedRealizer = createPrepareSeam(fixture, { name: 'lease-selected-realizer' });
    const outputPrimer = createPrepareSeam(fixture, {
      failOnCall: 1,
      mode: 'prime',
      name: 'lease-output-primer-fails',
    });
    const lease = loadLease(fixture, {
      expectedOutputPrimerExecutable: outputPrimer.executable,
      selectedInputRealizerExecutable: selectedRealizer.executable,
    });
    const request = makeRequest(fixture);
    const created = runLease(lease, fixture, request);
    assert.equal(created.status, 0, created.stderr);
    const root = requestRoot(request);
    const selectedMarker = path.join(root, 'roots', path.basename(request.selectedInputOutputs[0]));
    const expectedMarker = path.join(root, 'roots', path.basename(request.expectedOutputs[0]));
    fs.unlinkSync(selectedMarker);
    fs.unlinkSync(expectedMarker);

    const result = runLease(lease, fixture, { caller: 'ignored' }, [
      'prepare',
      request.token,
    ]);

    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.output.operation, 'prepare');
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'top output priming failed');
    assert.doesNotMatch(JSON.stringify(result.output), /fixture-lease-create-0001|\/nix\/store/);
    assert.equal(fs.existsSync(selectedMarker), false);
    assert.equal(fs.existsSync(expectedMarker), false);
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), true);
    assert.equal(modeOf(root), 0o700);
    assert.equal(selectedRealizer.calls().length, 1);
    assert.equal(outputPrimer.calls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('prepare requires an opaque lease token', () => {
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
