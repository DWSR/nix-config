'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
  runExecutable,
} = require('./helpers');
const {
  getDerivationGraph,
  getPublicCacheFixture,
} = require('./fixtures');
const { digestValue } = require('./fixtures/schema');

const MATERIALIZER_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-cache-materializer.nix',
);
const LEASE_PATH = path.join(repoRoot, 'scripts/shopify-remote-builder-lease.nix');
const PUBLIC_ENDPOINT = 'https://cache.nixos.org';
const PUBLIC_TRUSTED_KEY = 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=';
const PROXY_ENDPOINT = 'socks5h://127.0.0.1:1080';

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function readOnlyNixExecutable(fixture, name) {
  return fixture.createExecutable(name, `
    const childProcess = require('node:child_process');
    const result = childProcess.spawnSync('nix', [process.argv[2], '--read-only', ...process.argv.slice(3)], {
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 1);
  `);
}

function leaseStateDirectory(fixture) {
  const stateDirectory = path.join(fixture.paths.state, 'shopify-remote-builder', 'requests');
  fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateDirectory, 0o700);
  return fs.realpathSync(stateDirectory);
}

function createRootAdder(fixture, name = 'materializer-root-adder') {
  const logPath = path.join(fixture.paths.logs, `${name}.jsonl`);
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const executable = fixture.createExecutable(name, `
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const args = process.argv.slice(2);
    fs.appendFileSync(logPath, JSON.stringify({ args }) + '\\n');
    if (args.length !== 5 || args[0] !== '--add-root' || args[2] !== '--indirect' || args[3] !== '--realise') {
      process.exit(64);
    }
    fs.mkdirSync(path.dirname(args[1]), { recursive: true });
    try { fs.unlinkSync(args[1]); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.symlinkSync(args[4], args[1]);
  `);
  return {
    calls() {
      return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    executable,
  };
}

function loadLease(fixture, options = {}) {
  const stateDirectory = options.stateDirectory ?? leaseStateDirectory(fixture);
  const rootAdder = options.rootAdder ?? createRootAdder(fixture);
  const packageArguments = [
    `ownerUid = ${process.getuid()};`,
    `rootAdderExecutable = ${nixString(rootAdder.executable)};`,
    `stateDirectory = ${nixString(stateDirectory)};`,
  ];
  if (options.nowExecutable !== undefined) {
    packageArguments.push(`nowExecutable = ${nixString(options.nowExecutable)};`);
  }
  for (const [name, value] of Object.entries(options.numericOptions ?? {})) {
    packageArguments.push(`${name} = ${Number(value)};`);
  }
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in (pkgs.callPackage ${nixString(LEASE_PATH)} {
      ${packageArguments.join('\n      ')}
    }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-lease');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture, 'materializer-lease-read-only'),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return { executable, rootAdder, stateDirectory };
}

function makeLeaseRequest(fixture, cacheFixture, options = {}) {
  const graph = options.graph ?? cacheFixture.graph ?? getDerivationGraph('public-v1');
  const stateDirectory = leaseStateDirectory(fixture);
  const nonce = options.nonce ?? 'fixture-materializer-0001';
  const token = options.token ?? `srb1-${nonce}-${'a'.repeat(64)}`;
  const graphPaths = [
    ...graph.derivations.map(derivation => derivation.path),
    ...Object.keys(graph.references),
    ...Object.values(graph.references).flat(),
  ].filter((storePath, index, values) => values.indexOf(storePath) === index).sort();
  const outputPaths = graph.derivations
    .flatMap(derivation => derivation.outputs.map(output => output.path))
    .sort();
  const requestRoot = path.join(stateDirectory, nonce);
  const rootedPaths = graphPaths;
  const cacheCuts = options.cacheCuts ?? [cacheFixture];
  const publicCacheCuts = cacheCuts.map((cut, index) => {
    const closure = [
      ...cut.referenceClosure,
      ...(options.includeTopOutputInCacheCut && index === 0 ? [graph.topOutput] : []),
    ].sort();
    return makeAttestation(cut, {
      closure,
      closureDigest: digestValue(closure),
    });
  }).sort((left, right) => left.rootPath.localeCompare(right.rootPath));
  const referenceClosures = {
    ...graph.referenceClosures,
    ...Object.fromEntries(publicCacheCuts.map(cut => [cut.rootPath, cut.closure])),
  };
  return {
    schemaVersion: 1,
    operation: 'create',
    nonce,
    token,
    requestParent: stateDirectory,
    ownership: { uid: process.getuid() },
    authorization: { channel: 'local-pipe', operation: 'create', uid: process.getuid() },
    graphDigest: graph.graphIdentity.graphDigest,
    graph: {
      digest: graph.graphIdentity.graphDigest,
      outputPaths,
      paths: graphPaths,
      referenceClosures,
      topOutput: graph.topOutput,
    },
    rootedPaths,
    rootDestinations: rootedPaths.map(storePath => ({
      destination: path.join(requestRoot, 'roots', path.basename(storePath)),
      storePath,
    })),
    selectedInputOutputs: [graph.cacheRoot],
    expectedOutputs: [graph.topOutput],
    publicCacheCuts,
  };
}

function runJson(executable, fixture, args, input, options = {}) {
  const result = runExecutable(executable, args, {
    fixture,
    input: `${JSON.stringify(input)}\n`,
    env: {
      AWS_ACCESS_KEY_ID: 'fixture-materializer-secret',
      HTTPS_PROXY: 'fixture-poisoned-proxy',
      NIX_CONFIG: 'experimental-features = poisoned-feature',
      NIX_USER_CONF_FILES: path.join(fixture.root, 'poisoned.conf'),
      POST_BUILD_HOOK: 'fixture-poisoned-hook',
      SSH_AUTH_SOCK: 'fixture-poisoned-agent',
      ...options.env,
    },
    timeout: options.timeout ?? 120_000,
  });
  return {
    ...result,
    output: result.stdout.trim() === '' ? null : JSON.parse(result.stdout),
  };
}

function spawnJson(executable, fixture, args, input, options = {}) {
  const request = Array.isArray(input)
    ? { publicCacheCuts: input }
    : (input.publicCacheCuts === undefined ? { publicCacheCuts: [input] } : input);
  const child = childProcess.spawn(executable, args, {
    cwd: fixture.root,
    env: fixture.environment({
      AWS_ACCESS_KEY_ID: 'fixture-materializer-secret',
      HTTPS_PROXY: 'fixture-poisoned-proxy',
      NIX_CONFIG: 'experimental-features = poisoned-feature',
      NIX_USER_CONF_FILES: path.join(fixture.root, 'poisoned.conf'),
      POST_BUILD_HOOK: 'fixture-poisoned-hook',
      ...options.env,
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const closed = new Promise(resolve => {
    child.once('close', (status, signal) => resolve({
      status,
      signal,
      stderr,
      stdout,
      output: stdout.trim() === '' ? null : JSON.parse(stdout),
    }));
  });
  fixture.registerCleanup(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  });
  child.stdin.end(`${JSON.stringify(request)}\n`);
  return { child, closed };
}

function spawnLeaseKeepalive(setupResult) {
  const child = childProcess.spawn(
    setupResult.lease.executable,
    ['keepalive', setupResult.request.token],
    {
      cwd: setupResult.fixture.root,
      env: setupResult.fixture.environment(),
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
  });
  child.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const closed = new Promise(resolve => {
    child.once('close', (status, signal) => resolve({ status, signal, stderr, stdout }));
  });
  setupResult.fixture.registerCleanup(() => {
    if (child.exitCode === null && !child.killed) {
      child.kill('SIGKILL');
    }
  });
  return { child, closed, stderr: () => stderr, stdout: () => stdout };
}

async function waitForCondition(condition, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for materializer or lease state transition');
}

async function waitForLeaseJson(keeper, timeout = 5000) {
  await waitForCondition(() => keeper.stdout().split('\n').some(line => line.trim() !== ''), timeout);
  const line = keeper.stdout().split('\n').find(value => value.trim() !== '');
  return JSON.parse(line);
}

function makeAttestation(cacheFixture, overrides = {}) {
  return {
    rootPath: cacheFixture.rootPath,
    closure: [...cacheFixture.referenceClosure],
    closureDigest: cacheFixture.closureDigest,
    endpoint: cacheFixture.endpoint,
    signingKeyId: cacheFixture.trustedKeyId,
    narinfos: cacheFixture.narinfos.map(entry => ({
      storePath: entry.storePath,
      narHash: entry.narHash,
      narSize: entry.narSize,
      references: [...entry.references],
      signatures: [...entry.signatures],
    })),
    ...overrides,
  };
}

function createSpecialCharacterCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const originalRoot = cacheFixture.rootPath;
  const specialRoot = originalRoot.replace(
    '-shopify-remote-dependency',
    '-shopify?remote=cache',
  );
  const remapPath = storePath => storePath === originalRoot ? specialRoot : storePath;
  const remapReferences = references => Object.fromEntries(
    Object.entries(references).map(([storePath, childPaths]) => [
      remapPath(storePath),
      childPaths.map(remapPath).sort(),
    ]),
  );

  cacheFixture.rootPath = specialRoot;
  cacheFixture.referenceClosure = cacheFixture.referenceClosure.map(remapPath).sort();
  cacheFixture.closureDigest = digestValue(cacheFixture.referenceClosure);
  cacheFixture.graph = {
    ...cacheFixture.graph,
    cacheRoot: specialRoot,
    references: remapReferences(cacheFixture.graph.references),
    referenceClosures: remapReferences(cacheFixture.graph.referenceClosures),
  };
  cacheFixture.narinfos = cacheFixture.narinfos.map(entry => ({
    ...entry,
    storePath: remapPath(entry.storePath),
    references: entry.references.map(remapPath).sort(),
  }));
  cacheFixture.narContent = cacheFixture.narContent.map(entry => ({
    ...entry,
    storePath: remapPath(entry.storePath),
  }));
  cacheFixture.publicCacheCut = {
    ...cacheFixture.publicCacheCut,
    rootPath: specialRoot,
    closure: [...cacheFixture.referenceClosure],
    closureDigest: cacheFixture.closureDigest,
  };
  return cacheFixture;
}

function createDisjointCacheFixtures() {
  const first = getPublicCacheFixture('public');
  const secondRoot = '/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-shopify-remote-disjoint';
  const secondSource = '/nix/store/99999999999999999999999999999999-shopify-remote-disjoint-source';
  const firstRootNarinfo = first.narinfos.find(entry => entry.storePath === first.rootPath);
  const firstSourceNarinfo = first.narinfos.find(
    entry => entry.storePath === first.graph.references[first.rootPath][0],
  );
  const firstRootContent = first.narContent.find(entry => entry.storePath === first.rootPath);
  const firstSourceContent = first.narContent.find(
    entry => entry.storePath === first.graph.references[first.rootPath][0],
  );
  const secondReferences = {
    [secondRoot]: [secondSource],
    [secondSource]: [],
  };
  const secondClosure = [secondRoot, secondSource].sort();
  const aggregate = {
    ...first,
    graph: {
      ...first.graph,
      references: {
        ...first.graph.references,
        ...secondReferences,
      },
      referenceClosures: {
        ...first.graph.referenceClosures,
        [secondRoot]: secondClosure,
        [secondSource]: [secondSource],
      },
    },
    narinfos: [
      ...first.narinfos,
      {
        ...firstRootNarinfo,
        storePath: secondRoot,
        references: [secondSource],
        signatures: [`${first.trustedKeyId}:fixture-signature-disjoint-root-v1`],
      },
      {
        ...firstSourceNarinfo,
        storePath: secondSource,
        references: [],
        signatures: [`${first.trustedKeyId}:fixture-signature-disjoint-source-v1`],
      },
    ].sort((left, right) => left.storePath.localeCompare(right.storePath)),
    narContent: [
      ...first.narContent,
      { ...firstRootContent, storePath: secondRoot },
      { ...firstSourceContent, storePath: secondSource },
    ].sort((left, right) => left.storePath.localeCompare(right.storePath)),
  };
  const second = {
    ...aggregate,
    rootPath: secondRoot,
    referenceClosure: secondClosure,
    closureDigest: digestValue(secondClosure),
    narinfos: aggregate.narinfos.filter(entry => secondClosure.includes(entry.storePath)),
    narContent: aggregate.narContent.filter(content => secondClosure.includes(content.storePath)),
  };
  return { aggregate, cuts: [first, second] };
}

function remapLeaseCacheRoot(setupResult, specialCacheFixture) {
  const manifestPath = path.join(requestRoot(setupResult.request), 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const originalRoot = setupResult.request.selectedInputOutputs[0];
  const specialRoot = specialCacheFixture.rootPath;
  const remapPath = storePath => storePath === originalRoot ? specialRoot : storePath;
  const remapPaths = paths => paths.map(remapPath).sort();

  manifest.graph.paths = remapPaths(manifest.graph.paths);
  manifest.graph.outputPaths = remapPaths(manifest.graph.outputPaths);
  manifest.graph.referenceClosures = Object.fromEntries(
    Object.entries(manifest.graph.referenceClosures).map(([storePath, references]) => [
      remapPath(storePath),
      remapPaths(references),
    ]),
  );
  manifest.rootedPaths = remapPaths(manifest.rootedPaths);
  manifest.rootDestinations = manifest.rootDestinations
    .map(root => {
      const storePath = remapPath(root.storePath);
      return {
        destination: path.join(
          requestRoot(setupResult.request),
          'roots',
          path.basename(storePath),
        ),
        storePath,
      };
    })
    .sort((left, right) => left.storePath.localeCompare(right.storePath));
  manifest.selectedInputOutputs = remapPaths(manifest.selectedInputOutputs);
  manifest.expectedOutputs = remapPaths(manifest.expectedOutputs);
  manifest.publicCacheCuts = manifest.publicCacheCuts.map(cut => {
    const closure = remapPaths(cut.closure);
    return {
      ...cut,
      rootPath: remapPath(cut.rootPath),
      closure,
      closureDigest: digestValue(closure),
      narinfos: cut.narinfos.map(entry => ({
        ...entry,
        storePath: remapPath(entry.storePath),
        references: remapPaths(entry.references),
      })).sort((left, right) => left.storePath.localeCompare(right.storePath)),
    };
  });
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  fs.rmSync(
    path.join(requestRoot(setupResult.request), 'roots', path.basename(originalRoot)),
    { force: true },
  );
}

function createNativeAdapter(fixture, cacheFixture, targetStoreDirectory, options = {}) {
  const adapterName = options.name ?? 'materializer-native';
  const blockOnCopyPath = options.blockOnCopyPath
    ?? (options.blockOnFirstCopy ? cacheFixture.referenceClosure[0] : null);
  const blockReadyPath = options.blockReadyPath
    ?? (blockOnCopyPath === null
      ? null
      : path.join(fixture.paths.control, `${adapterName}.copy-ready`));
  const blockContinuePath = options.blockContinuePath
    ?? (blockOnCopyPath === null
      ? null
      : path.join(fixture.paths.control, `${adapterName}.copy-continue`));
  const logPath = path.join(fixture.paths.logs, `${adapterName}.jsonl`);
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const contentByPath = Object.fromEntries(cacheFixture.narContent.map(content => [
    content.storePath,
    Buffer.from(content.data, 'base64').toString('base64'),
  ]));
  const metadataByPath = Object.fromEntries(cacheFixture.narinfos.map(entry => [entry.storePath, {
    narHash: entry.narHash,
    narSize: entry.narSize,
    references: entry.references,
    signatures: entry.signatures,
  }]));
  const executable = fixture.createExecutable(adapterName, `
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const targetStoreDirectory = ${JSON.stringify(targetStoreDirectory)};
    const contentByPath = ${JSON.stringify(contentByPath)};
    const metadataByPath = ${JSON.stringify(metadataByPath)};
    const options = ${JSON.stringify({
      contentAddressOnly: options.contentAddressOnly ?? false,
      copyFailurePath: options.copyFailurePath ?? null,
      copyFailureStatus: options.copyFailureStatus ?? 1,
      copyFailureLeavesPath: options.copyFailureLeavesPath ?? false,
      failVerify: options.failVerify ?? false,
      failVerifyStatus: options.failVerifyStatus ?? 1,
      pathInfoOverrides: options.pathInfoOverrides ?? {},
      requireDependencyCompleteCopy: options.requireDependencyCompleteCopy ?? true,
      recursiveExtraPath: options.recursiveExtraPath ?? null,
      wrongEndpoint: options.wrongEndpoint ?? null,
      blockOnCopyPath,
      blockReadyPath,
      blockContinuePath,
    })};
    const args = process.argv.slice(2);
    const call = { args, env: process.env };
    fs.appendFileSync(logPath, JSON.stringify(call) + '\\n');
    const encodedStorePaths = args.filter(arg => arg.startsWith('/nix/store/'));
    const candidates = encodedStorePaths.map(decodeURIComponent);
    const candidate = candidates.at(-1) ?? '';
    const targetPath = path.join(targetStoreDirectory, path.basename(candidate));
    const record = metadataByPath[candidate];
    const override = options.pathInfoOverrides[candidate] ?? {};

    function dependencyFirst(paths) {
      const requested = new Set(paths);
      const visited = new Set();
      const ordered = [];
      const visit = storePath => {
        if (visited.has(storePath)) return;
        visited.add(storePath);
        for (const reference of metadataByPath[storePath]?.references ?? []) {
          if (requested.has(reference)) visit(reference);
        }
        ordered.push(storePath);
      };
      for (const storePath of paths) visit(storePath);
      return ordered;
    }

    if (args[0] === 'copy') {
      const from = args[args.indexOf('--from') + 1];
      if (options.wrongEndpoint !== null && from !== options.wrongEndpoint) process.exit(78);
      if (candidates.length === 0 || candidates.some(storePath => metadataByPath[storePath] === undefined)) {
        process.exit(79);
      }
      if (options.requireDependencyCompleteCopy) {
        for (const storePath of candidates) {
          for (const reference of metadataByPath[storePath].references) {
            if (!candidates.includes(reference)
              && !fs.existsSync(path.join(targetStoreDirectory, path.basename(reference)))) {
              process.exit(76);
            }
          }
        }
      }
      if (options.blockOnCopyPath !== null && candidates.includes(options.blockOnCopyPath)) {
        fs.writeFileSync(options.blockReadyPath, 'ready\\n', { mode: 0o600 });
        const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(options.blockContinuePath)) {
          Atomics.wait(waitBuffer, 0, 0, 10);
        }
      }
      for (const storePath of dependencyFirst(candidates)) {
        if (options.copyFailurePath === storePath) {
          if (options.copyFailureLeavesPath) {
            fs.mkdirSync(targetStoreDirectory, { recursive: true });
            fs.writeFileSync(
              path.join(targetStoreDirectory, path.basename(storePath)),
              Buffer.from('partial native transfer\\n'),
              { mode: 0o600 },
            );
          }
          process.exit(options.copyFailureStatus);
        }
        if (contentByPath[storePath] === undefined) process.exit(79);
        fs.mkdirSync(targetStoreDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(targetStoreDirectory, path.basename(storePath)),
          Buffer.from(contentByPath[storePath], 'base64'),
          { mode: 0o600 },
        );
      }
      if (options.recursiveExtraPath !== null && !args.includes('--no-recursive')) {
        fs.writeFileSync(
          path.join(targetStoreDirectory, path.basename(options.recursiveExtraPath)),
          Buffer.from('untracked recursive transfer\\n'),
          { mode: 0o600 },
        );
      }
      process.exit(0);
    }

    if (args[0] === 'path-info') {
      if (!fs.existsSync(targetPath) || record === undefined) process.exit(1);
      if (options.contentAddressOnly) {
        process.stdout.write(JSON.stringify({ [candidate]: { ca: 'fixed:r:sha256-content-only' } }));
        process.exit(0);
      }
      const metadata = { ...record, ...override };
      process.stdout.write(JSON.stringify({ [candidate]: metadata }));
      process.exit(0);
    }

    if (args[0] === 'store' && args[1] === 'verify') {
      if (options.failVerify) process.exit(options.failVerifyStatus);
      if (!fs.existsSync(targetPath) || record === undefined) process.exit(4);
      const bytes = fs.readFileSync(targetPath);
      const hash = 'sha256-' + crypto.createHash('sha256').update(bytes).digest('base64');
      process.exit(hash === record.narHash && bytes.length === record.narSize ? 0 : 1);
    }

    if (args[0] === 'store' && args[1] === 'delete') {
      try { fs.unlinkSync(targetPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      process.exit(0);
    }
    process.exit(64);
  `);
  return {
    calls() {
      return fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    },
    executable,
    copyContinuePath: blockContinuePath,
    copyReadyPath: blockReadyPath,
  };
}

function loadMaterializer(fixture, lease, native, targetStoreDirectory, options = {}) {
  const packageArguments = [
    `ownerUid = ${process.getuid()};`,
    `stateDirectory = ${nixString(lease.stateDirectory)};`,
    `rootAdderExecutable = ${nixString(lease.rootAdder.executable)};`,
    `leaseManagerExecutable = ${nixString(lease.executable)};`,
    `nativeCacheMaterializerExecutable = ${nixString(native.executable)};`,
    `targetStoreDirectory = ${nixString(targetStoreDirectory)};`,
    `targetStoreUri = ${nixString(options.targetStoreUri ?? 'local?root=/nix')};`,
    `policyProxyPort = ${Number(options.policyProxyPort ?? 1080)};`,
    `idleTtlSeconds = ${Number(options.idleTtlSeconds ?? 3600)};`,
  ];
  if (options.nowExecutable !== undefined) {
    packageArguments.push(`nowExecutable = ${nixString(options.nowExecutable)};`);
  }
  const configurations = options.approvedCacheConfigurations ?? [{
    endpoint: PUBLIC_ENDPOINT,
    trustedKeys: [PUBLIC_TRUSTED_KEY],
  }];
  packageArguments.push(`approvedCacheConfigurations = ${nixValue(configurations)};`);
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in (pkgs.callPackage ${nixString(MATERIALIZER_PATH)} {
      ${packageArguments.join('\n      ')}
    }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-cache-materializer');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture, 'materializer-read-only'),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function nixValue(value) {
  if (typeof value === 'string') return nixString(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[ ${value.map(nixValue).join(' ')} ]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, entry]) => `${nixString(key)} = ${nixValue(entry)};`).join(' ')} }`;
  }
  throw new TypeError(`unsupported Nix fixture value: ${value}`);
}

function requestRoot(request) {
  return path.join(request.requestParent, request.nonce);
}

function runLeaseCreate(lease, fixture, request) {
  return runJson(lease.executable, fixture, ['create'], request);
}

function setup(name = 'public', options = {}) {
  const fixture = createRemoteBuilderFixture();
  const cacheFixture = options.cacheFixture ?? getPublicCacheFixture(name);
  const leaseCacheFixture = options.leaseCacheFixture ?? cacheFixture;
  const lease = loadLease(fixture, {
    numericOptions: { idleTtlSeconds: options.idleTtlSeconds ?? 3600 },
    nowExecutable: options.leaseNowExecutable,
    rootAdder: options.rootAdder,
  });
  const request = makeLeaseRequest(fixture, leaseCacheFixture, options.request);
  const created = runLeaseCreate(lease, fixture, request);
  assert.equal(created.status, 0, `${created.stderr}\n${created.stdout}`);
  assert.equal(created.output?.decision, 'created', JSON.stringify(created.output));
  const targetStoreDirectory = path.join(fixture.paths.data, 'normal-store');
  fs.mkdirSync(targetStoreDirectory, { recursive: true, mode: 0o700 });
  for (const existing of options.existingContent ?? []) {
    fs.writeFileSync(
      path.join(targetStoreDirectory, path.basename(existing.storePath)),
      Buffer.from(existing.data, 'base64'),
      { mode: 0o600 },
    );
  }
  const native = createNativeAdapter(fixture, cacheFixture, targetStoreDirectory, options.native);
  const materializer = loadMaterializer(
    fixture,
    lease,
    native,
    targetStoreDirectory,
    options,
  );
  return { cacheFixture, created, fixture, lease, materializer, native, request, targetStoreDirectory };
}

function removeCutRoots(setupResult, attestation = makeAttestation(setupResult.cacheFixture)) {
  const root = requestRoot(setupResult.request);
  for (const storePath of attestation.closure) {
    fs.rmSync(path.join(root, 'roots', path.basename(storePath)), { force: true });
  }
}

function runMaterializer(setupResult, attestation, token = setupResult.request.token, options = {}) {
  const request = Array.isArray(attestation)
    ? { publicCacheCuts: attestation }
    : (attestation.publicCacheCuts === undefined
      ? { publicCacheCuts: [attestation] }
      : attestation);
  return runJson(
    setupResult.materializer,
    setupResult.fixture,
    ['materialize', token],
    request,
    options,
  );
}

function nativeCopyPaths(call) {
  return call.args
    .filter(argument => argument.startsWith('/nix/store/'))
    .map(argument => decodeURIComponent(argument));
}

function assertLeaseRemoved(setupResult) {
  assert.equal(fs.existsSync(requestRoot(setupResult.request)), false);
}

function assertLeaseRetained(setupResult) {
  const root = requestRoot(setupResult.request);
  assert.equal(fs.existsSync(root), true);
  assert.equal(fs.existsSync(path.join(root, 'manifest.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'roots')), true);
}

test('materializer materializes a complete cut, preserves bytes, and roots every closure path', () => {
  const setupResult = setup();
  try {
    const attestation = makeAttestation(setupResult.cacheFixture);
    removeCutRoots(setupResult, attestation);
    const beforeRootCalls = setupResult.lease.rootAdder.calls().length;

    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized', JSON.stringify(result.output));
    assert.equal(result.output.leaseToken, setupResult.request.token);
    assert.equal(result.output.graphDigest, setupResult.request.graphDigest);
    assert.deepEqual(result.output.publicCacheCuts, [attestation]);
    assert.deepEqual(result.output.rootedPaths, attestation.closure);
    assert.equal(fs.existsSync(requestRoot(setupResult.request)), true);
    for (const content of setupResult.cacheFixture.narContent) {
      assert.deepEqual(
        fs.readFileSync(path.join(setupResult.targetStoreDirectory, path.basename(content.storePath))),
        Buffer.from(content.data, 'base64'),
      );
      const marker = path.join(requestRoot(setupResult.request), 'roots', path.basename(content.storePath));
      assert.equal(fs.readlinkSync(marker), content.storePath);
    }
    const newRootCalls = setupResult.lease.rootAdder.calls().slice(beforeRootCalls);
    assert.deepEqual(newRootCalls.map(call => call.args[4]).sort(), attestation.closure);
    const nativeCalls = setupResult.native.calls();
    const copyCalls = nativeCalls.filter(call => call.args[0] === 'copy');
    assert.equal(copyCalls.length, 1);
    assert.deepEqual(nativeCopyPaths(copyCalls[0]).sort(), attestation.closure);
    assert.equal(nativeCalls.some(call => call.args[0] === 'store' && call.args[1] === 'delete'), false);
    for (const call of nativeCalls) {
      assert.equal(call.env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(call.env.POST_BUILD_HOOK, undefined);
      assert.equal(call.env.SSH_AUTH_SOCK, undefined);
      assert.equal(call.env.HTTPS_PROXY, PROXY_ENDPOINT);
      assert.match(call.env.NIX_CONFIG, /trusted-public-keys = cache\.nixos\.org-1:/);
    }
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer batches each disjoint cut, verifies dependencies first, and roots their union', () => {
  const { aggregate, cuts } = createDisjointCacheFixtures();
  const setupResult = setup('public', {
    cacheFixture: aggregate,
    leaseCacheFixture: aggregate,
    request: { cacheCuts: cuts },
  });
  try {
    const attestations = cuts.map(cut => makeAttestation(cut));
    const allClosure = attestations.flatMap(attestation => attestation.closure).sort();
    for (const attestation of attestations) removeCutRoots(setupResult, attestation);

    const result = runMaterializer(setupResult, { publicCacheCuts: attestations });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized', JSON.stringify(result.output));
    assert.deepEqual(result.output.publicCacheCuts, attestations);
    assert.deepEqual(result.output.rootedPaths, allClosure);

    const copyCalls = setupResult.native.calls().filter(call => call.args[0] === 'copy');
    assert.equal(copyCalls.length, attestations.length);
    assert.deepEqual(
      copyCalls.flatMap(nativeCopyPaths).sort(),
      allClosure,
    );
    for (const attestation of attestations) {
      const paths = nativeCopyPaths(
        copyCalls.find(call => nativeCopyPaths(call).includes(attestation.rootPath)),
      );
      assert.deepEqual(paths.sort(), attestation.closure);
    }

    const pathInfoPaths = setupResult.native.calls()
      .filter(call => call.args[0] === 'path-info')
      .map(call => decodeURIComponent(call.args.at(-1)));
    for (const attestation of attestations) {
      for (const entry of attestation.narinfos) {
        for (const reference of entry.references) {
          assert.ok(
            pathInfoPaths.indexOf(reference) < pathInfoPaths.indexOf(entry.storePath),
            `path-info order for ${reference} -> ${entry.storePath}`,
          );
        }
      }
    }

    const rootCalls = setupResult.lease.rootAdder.calls()
      .slice(-allClosure.length)
      .map(call => call.args);
    assert.deepEqual(rootCalls.map(args => args[4]).sort(), allClosure);
    for (const content of aggregate.narContent) {
      assert.deepEqual(
        fs.readFileSync(path.join(setupResult.targetStoreDirectory, path.basename(content.storePath))),
        Buffer.from(content.data, 'base64'),
      );
    }
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer transfers only exact paths and never leaves a recursive extra', () => {
  const extraPath = '/nix/store/ffffffffffffffffffffffffffffffff-untracked-recursive';
  const setupResult = setup('public', {
    native: { recursiveExtraPath: extraPath },
  });
  try {
    const attestation = makeAttestation(setupResult.cacheFixture);
    removeCutRoots(setupResult, attestation);
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized', JSON.stringify(result.output));
    const copyCalls = setupResult.native.calls().filter(call => call.args[0] === 'copy');
    assert.ok(copyCalls.length > 0);
    assert.equal(copyCalls.every(call => call.args.includes('--no-recursive')), true);
    assert.deepEqual(nativeCopyPaths(copyCalls[0]).sort(), attestation.closure);
    assert.equal(
      fs.existsSync(path.join(setupResult.targetStoreDirectory, path.basename(extraPath))),
      false,
    );
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer fetches absent paths only from the attesting approved endpoint', () => {
  const secondEndpoint = 'https://cache.example.test';
  const leaseCacheFixture = {
    ...getPublicCacheFixture('public'),
    endpoint: secondEndpoint,
  };
  const setupResult = setup('public', {
    leaseCacheFixture,
    approvedCacheConfigurations: [
      { endpoint: PUBLIC_ENDPOINT, trustedKeys: [PUBLIC_TRUSTED_KEY] },
      { endpoint: secondEndpoint, trustedKeys: [PUBLIC_TRUSTED_KEY] },
    ],
  });
  try {
    const attestation = makeAttestation(setupResult.cacheFixture, { endpoint: secondEndpoint });
    removeCutRoots(setupResult, attestation);
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized');
    assert.equal(
      setupResult.native.calls().filter(call => call.args[0] === 'copy')
        .every(call => call.args[call.args.indexOf('--from') + 1] === secondEndpoint),
      true,
    );
    assert.equal(
      setupResult.native.calls().some(call => call.args.includes(PUBLIC_ENDPOINT)),
      false,
    );
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects endpoint, key, and full-metadata swaps after lease creation before native work', () => {
  const alternateEndpoint = 'https://nix-community.cachix.org';
  const alternateKeyId = 'nix-community.cachix.org-1';
  const alternateKey = 'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=';
  const cases = [
    ['endpoint', cut => ({ ...cut, endpoint: alternateEndpoint })],
    ['key', cut => ({
      ...cut,
      signingKeyId: alternateKeyId,
      narinfos: cut.narinfos.map(entry => ({
        ...entry,
        signatures: entry.signatures.map(signature => `${alternateKeyId}:${signature.split(':').slice(1).join(':')}`),
      })),
    })],
    ['metadata', cut => ({
      ...cut,
      narinfos: cut.narinfos.map((entry, index) => index === 0
        ? { ...entry, narHash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }
        : entry),
    })],
  ];

  for (const [name, mutate] of cases) {
    const setupResult = setup('public', {
      approvedCacheConfigurations: [
        {
          endpoint: PUBLIC_ENDPOINT,
          trustedKeys: [PUBLIC_TRUSTED_KEY, alternateKey],
        },
        {
          endpoint: alternateEndpoint,
          trustedKeys: [PUBLIC_TRUSTED_KEY, alternateKey],
        },
      ],
    });
    try {
      const candidate = mutate(makeAttestation(setupResult.cacheFixture));
      const result = runMaterializer(setupResult, { publicCacheCuts: [candidate] });

      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.notEqual(result.output.decision, 'materialized', name);
      assert.equal(setupResult.native.calls().length, 0, name);
      assertLeaseRemoved(setupResult);
    } finally {
      setupResult.fixture.cleanup();
    }
  }
});

test('materializer verifies valid existing material without overwriting it or consulting Attic', () => {
  const cacheFixture = getPublicCacheFixture('public');
  const setupResult = setup('public', { existingContent: cacheFixture.narContent });
  try {
    const before = Object.fromEntries(cacheFixture.narContent.map(content => [
      content.storePath,
      fs.readFileSync(path.join(setupResult.targetStoreDirectory, path.basename(content.storePath))),
    ]));
    const attestation = makeAttestation(cacheFixture);
    removeCutRoots(setupResult, attestation);
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized');
    assert.equal(setupResult.native.calls().some(call => call.args[0] === 'copy'), false);
    for (const content of cacheFixture.narContent) {
      assert.deepEqual(
        fs.readFileSync(path.join(setupResult.targetStoreDirectory, path.basename(content.storePath))),
        before[content.storePath],
      );
    }
    assert.doesNotMatch(JSON.stringify(setupResult.native.calls()), /attic|daemon|cache\.shopify/);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects a symlinked target-store entry without following or replacing it', () => {
  const setupResult = setup();
  try {
    const storePath = setupResult.cacheFixture.rootPath;
    const targetPath = path.join(setupResult.targetStoreDirectory, path.basename(storePath));
    const outsidePath = path.join(setupResult.fixture.paths.data, 'outside-material');
    fs.writeFileSync(outsidePath, 'must remain\n', { mode: 0o600 });
    fs.symlinkSync(outsidePath, targetPath);
    const result = runMaterializer(
      setupResult,
      makeAttestation(setupResult.cacheFixture),
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assertLeaseRemoved(setupResult);
    assert.equal(fs.readlinkSync(targetPath), outsidePath);
    assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'must remain\n');
    assert.equal(setupResult.native.calls().length, 0);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects same-path normal or Attic content before recording a cut', () => {
  const mismatch = getPublicCacheFixture('content-mismatch');
  const setupResult = setup('public', { existingContent: mismatch.narContent });
  try {
    const attestation = makeAttestation(setupResult.cacheFixture);
    removeCutRoots(setupResult, attestation);
    const contaminatedPath = attestation.closure[0];
    const contaminatedFile = path.join(
      setupResult.targetStoreDirectory,
      path.basename(contaminatedPath),
    );
    const before = fs.readFileSync(contaminatedFile);
    const rootCallsBefore = setupResult.lease.rootAdder.calls().length;
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assertLeaseRetained(setupResult);
    assert.deepEqual(fs.readFileSync(contaminatedFile), before);
    assert.equal(setupResult.native.calls().some(call => call.args[0] === 'copy'), false);
    assert.equal(setupResult.lease.rootAdder.calls().length, rootCallsBefore);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects attested references outside the candidate closure before transfer', () => {
  const cacheFixture = getPublicCacheFixture('public');
  const storePath = cacheFixture.narinfos[0].storePath;
  const untrackedReference = '/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-untracked-reference';
  const setupResult = setup('public', {
    native: {
      pathInfoOverrides: {
        [storePath]: { references: [untrackedReference] },
      },
    },
  });
  try {
    const attestation = makeAttestation(setupResult.cacheFixture);
    attestation.narinfos = attestation.narinfos.map(entry => (
      entry.storePath === storePath
        ? { ...entry, references: [untrackedReference] }
        : entry
    ));
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assert.equal(setupResult.native.calls().length, 0);
    assertLeaseRemoved(setupResult);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects forged, expired, and wrong-graph lease state before native work', () => {
  const forged = setup();
  try {
    const attestation = makeAttestation(forged.cacheFixture);
    const forgedResult = runMaterializer(
      forged,
      attestation,
      `srb1-${forged.request.nonce}-${'b'.repeat(64)}`,
    );
    assert.equal(forgedResult.status, 0, forgedResult.stderr);
    assert.notEqual(forgedResult.output.decision, 'materialized');
    assert.equal(fs.existsSync(requestRoot(forged.request)), true);
    assert.equal(forged.native.calls().length, 0);
  } finally {
    forged.fixture.cleanup();
  }

  const expired = setup('public', { idleTtlSeconds: 10 });
  try {
    const manifestPath = path.join(requestRoot(expired.request), 'manifest.json');
    fs.utimesSync(manifestPath, 1000, 1000);
    const result = runMaterializer(expired, makeAttestation(expired.cacheFixture), expired.request.token);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.output.decision, 'materialized');
    assertLeaseRemoved(expired);
    assert.equal(expired.native.calls().length, 0);
  } finally {
    expired.fixture.cleanup();
  }

  const wrongGraph = setup();
  try {
    const attestation = makeAttestation(wrongGraph.cacheFixture, {
      closure: [wrongGraph.cacheFixture.rootPath],
      closureDigest: digestValue([wrongGraph.cacheFixture.rootPath]),
    });
    const result = runMaterializer(wrongGraph, attestation);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.output.decision, 'materialized');
    assertLeaseRemoved(wrongGraph);
    assert.equal(wrongGraph.native.calls().length, 0);
  } finally {
    wrongGraph.fixture.cleanup();
  }
});

test('materializer rejects endpoint, key, StorePath, hash, size, references, digest, partial, unsigned, and top-output attestations', () => {
  const cases = [
    ['wrong endpoint', cut => ({ ...cut, endpoint: 'https://attic.shopify.invalid' })],
    ['wrong key', cut => ({ ...cut, signingKeyId: 'forged-cache-1' })],
    ['wrong StorePath', cut => ({ ...cut, narinfos: [{ ...cut.narinfos[0], storePath: '/nix/store/99999999999999999999999999999999-forged' }, ...cut.narinfos.slice(1)] })],
    ['wrong hash', cut => ({ ...cut, narinfos: [{ ...cut.narinfos[0], narHash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }, ...cut.narinfos.slice(1)] })],
    ['wrong size', cut => ({ ...cut, narinfos: [{ ...cut.narinfos[0], narSize: cut.narinfos[0].narSize + 1 }, ...cut.narinfos.slice(1)] })],
    ['wrong references', cut => ({ ...cut, narinfos: [{ ...cut.narinfos[0], references: [] }, ...cut.narinfos.slice(1)] })],
    ['wrong closure digest', cut => ({ ...cut, closureDigest: `sha256:${'f'.repeat(64)}` })],
    ['partial closure', cut => ({ ...cut, narinfos: cut.narinfos.slice(0, -1) })],
    ['unsigned', cut => ({ ...cut, narinfos: cut.narinfos.map(entry => ({ ...entry, signatures: [] })) })],
    ['top output', cut => ({ ...cut, rootPath: '/nix/store/cccccccccccccccccccccccccccccccc-shopify-remote-top' })],
  ];

  for (const [name, mutate] of cases) {
      const setupResult = setup();
    try {
      const result = runMaterializer(setupResult, mutate(makeAttestation(setupResult.cacheFixture)));
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.notEqual(result.output.decision, 'materialized', name);
      assertLeaseRemoved(setupResult);
      assert.ok(result.stdout.length <= 2048, name);
    } finally {
      setupResult.fixture.cleanup();
    }
  }
});

test('materializer rejects the requested top output anywhere in a cut closure before transfer', () => {
  const setupResult = setup('public');
  try {
    const topOutput = setupResult.request.graph.topOutput;
    const closure = [...setupResult.cacheFixture.referenceClosure, topOutput].sort();
    const sourceNarinfo = setupResult.cacheFixture.narinfos[0];
    const topNarinfo = {
      storePath: topOutput,
      narHash: sourceNarinfo.narHash,
      narSize: sourceNarinfo.narSize,
      references: [],
      signatures: [...sourceNarinfo.signatures],
    };
    const attestation = makeAttestation(setupResult.cacheFixture, {
      closure,
      closureDigest: digestValue(closure),
    });
    attestation.narinfos = [...attestation.narinfos, topNarinfo]
      .sort((left, right) => left.storePath.localeCompare(right.storePath));
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assert.equal(setupResult.native.calls().length, 0);
    assertLeaseRemoved(setupResult);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer accepts verifier-compatible special store names and URL-encodes native paths', () => {
  const specialCacheFixture = createSpecialCharacterCacheFixture();
  const setupResult = setup('public', {
    cacheFixture: specialCacheFixture,
    leaseCacheFixture: getPublicCacheFixture('public'),
  });
  try {
    remapLeaseCacheRoot(setupResult, specialCacheFixture);
    const attestation = makeAttestation(specialCacheFixture);
    removeCutRoots(setupResult, attestation);
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'materialized');
    const encodedRootPath = specialCacheFixture.rootPath
      .replace('?', '%3F')
      .replace('=', '%3D');
    assert.ok(
      setupResult.native.calls().some(call => nativeCopyPaths(call).includes(specialCacheFixture.rootPath)),
    );
    assert.equal(
      setupResult.native.calls().some(call => call.args.at(-1).includes('?')),
      false,
    );
    assert.equal(
      setupResult.native.calls().some(call => call.args.at(-1).includes('=')),
      false,
    );
    assert.ok(
      setupResult.native.calls().some(call => call.args.includes(encodedRootPath)),
    );
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer rejects content-address-only native metadata and native availability failures', () => {
  for (const nativeOptions of [
    { contentAddressOnly: true },
    { copyFailurePath: '/nix/store/dddddddddddddddddddddddddddddddd-shopify-remote-dependency' },
    { failVerify: true, failVerifyStatus: 4 },
  ]) {
    const setupResult = setup('public', { native: nativeOptions });
    try {
      const attestation = makeAttestation(setupResult.cacheFixture);
      removeCutRoots(setupResult, attestation);
      const rootCallsBefore = setupResult.lease.rootAdder.calls().length;
      const result = runMaterializer(setupResult, attestation);
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
      assert.notEqual(result.output.decision, 'materialized');
      assertLeaseRetained(setupResult);
      assert.equal(setupResult.lease.rootAdder.calls().length, rootCallsBefore);
    } finally {
      setupResult.fixture.cleanup();
    }
  }
});

test('materializer removes fetched bytes, roots, and lease state after a partial failure', () => {
  const cacheFixture = getPublicCacheFixture('public');
  const setupResult = setup('public', {
    native: {
      copyFailurePath: cacheFixture.referenceClosure.at(-1),
      copyFailureStatus: 1,
      copyFailureLeavesPath: true,
    },
  });
  try {
    const attestation = makeAttestation(cacheFixture);
    const rootCallsBefore = setupResult.lease.rootAdder.calls().length;
    const result = runMaterializer(setupResult, attestation);

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assertLeaseRemoved(setupResult);
    for (const content of cacheFixture.narContent) {
      assert.equal(
        fs.existsSync(path.join(setupResult.targetStoreDirectory, path.basename(content.storePath))),
        false,
      );
    }
    assert.ok(setupResult.native.calls().some(call => call.args[0] === 'store' && call.args[1] === 'delete'));
    assert.equal(setupResult.lease.rootAdder.calls().length, rootCallsBefore);
  } finally {
    setupResult.fixture.cleanup();
  }
});

test('materializer preserves an active lease when strict release refuses after partial failure', async () => {
  const cacheFixture = getPublicCacheFixture('public');
  const setupResult = setup('public', {
    native: {
      blockOnFirstCopy: true,
      copyFailurePath: cacheFixture.referenceClosure.at(-1),
      copyFailureStatus: 1,
    },
  });
  let keeper;
  try {
    const attestation = makeAttestation(cacheFixture);
    const materialization = spawnJson(
      setupResult.materializer,
      setupResult.fixture,
      ['materialize', setupResult.request.token],
      attestation,
    );
    await waitForCondition(() => fs.existsSync(setupResult.native.copyReadyPath));

    keeper = spawnLeaseKeepalive(setupResult);
    const acknowledgement = await waitForLeaseJson(keeper);
    assert.equal(acknowledgement.operation, 'keepalive', JSON.stringify(acknowledgement));
    assert.equal(acknowledgement.decision, 'active', JSON.stringify(acknowledgement));
    fs.writeFileSync(setupResult.native.copyContinuePath, 'continue\n', { mode: 0o600 });

    const result = await materialization.closed;
    const root = requestRoot(setupResult.request);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'materialized');
    assert.match(
      result.stderr,
      /lease release was not confirmed; lease state was retained for TTL or explicit release/,
    );
    assert.ok(result.stderr.length <= 256);
    assert.equal(fs.existsSync(path.join(root, 'manifest.json')), true);
    assert.equal(fs.existsSync(path.join(root, 'active.lock')), true);
    assert.equal(fs.existsSync(path.join(root, 'heartbeat.json')), true);
    for (const storePath of setupResult.request.rootedPaths) {
      const marker = path.join(root, 'roots', path.basename(storePath));
      assert.equal(fs.readlinkSync(marker), storePath, marker);
    }
    assert.equal(
      fs.existsSync(path.join(setupResult.targetStoreDirectory, path.basename(attestation.closure[0]))),
      false,
    );
    assert.equal(
      setupResult.native.calls().some(call => call.args[0] === 'store' && call.args[1] === 'delete'),
      true,
    );
  } finally {
    if (keeper !== undefined) {
      if (keeper.child.exitCode === null && !keeper.child.killed) {
        keeper.child.stdin.end();
      }
      await keeper.closed;
    }
    setupResult.fixture.cleanup();
  }
});

test('materializer bounds and redacts native diagnostics', () => {
  const setupResult = setup('public', {
    native: { copyFailurePath: '/nix/store/dddddddddddddddddddddddddddddddd-shopify-remote-dependency' },
  });
  try {
    const attestation = makeAttestation(setupResult.cacheFixture);
    const result = runMaterializer(setupResult, attestation);
    assert.equal(result.status, 0, result.stderr);
    assert.notEqual(result.output.decision, 'materialized');
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /fixture-materializer-0001|fixture-materializer-secret|\/nix\/store/);
    assertLeaseRemoved(setupResult);
  } finally {
    setupResult.fixture.cleanup();
  }
});
