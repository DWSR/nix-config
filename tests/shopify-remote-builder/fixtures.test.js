'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  runExecutable,
} = require('./helpers');
const {
  CACHE_FIXTURE_NAMES,
  COMMAND_FIXTURE_NAMES,
  ENVIRONMENT_FIXTURE_NAMES,
  GRAPH_FIXTURE_NAMES,
  LEASE_FIXTURE_NAMES,
  NETWORK_FIXTURE_NAMES,
  PROCESS_FIXTURE_NAMES,
  ROUTE_FIXTURE_NAMES,
  SIGNAL_FIXTURE_NAMES,
  TRUST_FIXTURE_NAMES,
  getCommandFixture,
  getDerivationGraph,
  getEnvironmentFixture,
  getLeaseFixture,
  getNetworkFixture,
  getProcessFixture,
  getPublicCacheFixture,
  getRouteFixture,
  getSignalFixture,
  getTrustFixture,
  listPublicCacheFixtures,
  loadFixtureCatalog,
  materializeEnvironmentFixture,
  materializeLeaseFixture,
  materializePublicCacheFixture,
  materializeProcessFixture,
  validateFixtureCatalog,
} = require('./fixtures');

const EXPECTED_CACHE_FIXTURES = [
  'public',
  'private',
  'partial',
  'unsigned',
  'stale',
  'content-mismatch',
];

function makeFixturePublicKey(keyLength, comment) {
  const keyType = Buffer.from('ssh-ed25519');
  const keyData = Buffer.alloc(keyLength, 0x42);
  const blob = Buffer.alloc(4 + keyType.length + 4 + keyData.length);
  blob.writeUInt32BE(keyType.length, 0);
  keyType.copy(blob, 4);
  blob.writeUInt32BE(keyData.length, 4 + keyType.length);
  keyData.copy(blob, 8 + keyType.length);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}`;
}

function decodeFixturePublicKey(publicKey) {
  const [, encoded] = publicKey.split(' ');
  const blob = Buffer.from(encoded, 'base64');
  const keyTypeLength = blob.readUInt32BE(0);
  const keyType = blob.subarray(4, 4 + keyTypeLength).toString('ascii');
  const keyLengthOffset = 4 + keyTypeLength;
  const keyLength = blob.readUInt32BE(keyLengthOffset);
  const keyData = blob.subarray(keyLengthOffset + 4);
  return { blob, keyData, keyLength, keyType };
}

test('fixture catalog exposes a versioned derivation graph and reusable cache cases', () => {
  const catalog = loadFixtureCatalog();

  assert.equal(catalog.schemaVersion, 1);
  assert.deepEqual(GRAPH_FIXTURE_NAMES, ['public-v1']);
  assert.deepEqual(CACHE_FIXTURE_NAMES, EXPECTED_CACHE_FIXTURES);
  assert.deepEqual(listPublicCacheFixtures(), EXPECTED_CACHE_FIXTURES);
  assert.doesNotThrow(() => validateFixtureCatalog(catalog));

  const graph = getDerivationGraph('public-v1');
  assert.equal(graph.schemaVersion, 1);
  assert.equal(graph.graphIdentity.schemaVersion, 1);
  assert.equal(graph.graphIdentity.topDerivation, graph.topDerivation);
  assert.match(graph.graphIdentity.graphDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(graph.graphIdentity.evaluatorConfigDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(graph.derivations.length, 2);
  assert.equal(graph.derivations.every(derivation => derivation.outputs.length > 0), true);
  assert.equal(Object.keys(graph.referenceClosures).length, 3);
  assert.equal(graph.referenceClosures[graph.cacheRoot].includes(graph.cacheRoot), true);
  assert.equal(graph.referenceClosures[graph.cacheRoot].length > 1, true);
});

test('each public-cache case is independently reusable and carries complete fixture data', () => {
  for (const name of EXPECTED_CACHE_FIXTURES) {
    const fixture = getPublicCacheFixture(name);
    const freshFixture = getPublicCacheFixture(name);

    assert.equal(fixture.schemaVersion, 1, name);
    assert.equal(fixture.caseName, name, name);
    assert.equal(fixture.graph.graphIdentity.schemaVersion, 1, name);
    assert.equal(fixture.narinfos.length > 0, true, name);
    assert.equal(fixture.referenceClosure.includes(fixture.rootPath), true, name);
    assert.deepEqual(
      fixture.referenceClosure,
      [...fixture.referenceClosure].sort(),
      `${name} closure must be canonical and sorted`,
    );
    assert.notStrictEqual(fixture, freshFixture, name);
    assert.notStrictEqual(fixture.narinfos, freshFixture.narinfos, name);
    assert.notStrictEqual(fixture.narContent, freshFixture.narContent, name);
  }
});

test('public cache fixtures distinguish a trusted matching cut from negative cases', () => {
  const expectations = {
    public: {
      decision: 'cut',
      contentStatus: 'matching',
      closureStatus: 'complete',
      signatureStatus: 'trusted',
      freshnessStatus: 'fresh',
    },
    private: {
      decision: 'traverse',
      contentStatus: 'matching',
      closureStatus: 'complete',
      signatureStatus: 'trusted',
      freshnessStatus: 'fresh',
    },
    partial: {
      decision: 'traverse',
      contentStatus: 'matching',
      closureStatus: 'partial',
      signatureStatus: 'trusted',
      freshnessStatus: 'fresh',
    },
    unsigned: {
      decision: 'traverse',
      contentStatus: 'matching',
      closureStatus: 'complete',
      signatureStatus: 'unsigned',
      freshnessStatus: 'fresh',
    },
    stale: {
      decision: 'traverse',
      contentStatus: 'matching',
      closureStatus: 'complete',
      signatureStatus: 'trusted',
      freshnessStatus: 'stale',
    },
    'content-mismatch': {
      decision: 'traverse',
      contentStatus: 'mismatch',
      closureStatus: 'complete',
      signatureStatus: 'trusted',
      freshnessStatus: 'fresh',
    },
  };

  for (const [name, expected] of Object.entries(expectations)) {
    const fixture = getPublicCacheFixture(name);
    assert.deepEqual({
      decision: fixture.expectedDecision,
      contentStatus: fixture.contentStatus,
      closureStatus: fixture.closureStatus,
      signatureStatus: fixture.signatureStatus,
      freshnessStatus: fixture.freshnessStatus,
    }, expected, name);
  }

  const publicFixture = getPublicCacheFixture('public');
  assert.equal(publicFixture.publicCacheCut.rootPath, publicFixture.rootPath);
  assert.equal(publicFixture.publicCacheCut.endpoint, publicFixture.endpoint);
  assert.equal(publicFixture.publicCacheCut.signingKeyId, publicFixture.trustedKeyId);
  assert.match(publicFixture.publicCacheCut.closureDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(publicFixture.narContent.every(content => content.matchesNarinfo), true);

  const mismatchFixture = getPublicCacheFixture('content-mismatch');
  assert.equal(mismatchFixture.narContent.some(content => !content.matchesNarinfo), true);
  assert.equal(mismatchFixture.narContent.length, publicFixture.narContent.length);
});

test('fixture schema rejects ambiguous derivation graphs and cache cuts', () => {
  const graphAmbiguity = loadFixtureCatalog();
  const derivations = graphAmbiguity.graphs['public-v1'].derivations;
  derivations[1].path = derivations[0].path;
  assert.throws(
    () => validateFixtureCatalog(graphAmbiguity),
    /duplicate derivation path/,
  );

  const cacheAmbiguity = loadFixtureCatalog();
  cacheAmbiguity.cacheCases.public.expectedDecision = 'traverse';
  assert.throws(
    () => validateFixtureCatalog(cacheAmbiguity),
    /approved complete cache case must cut/,
  );

  const closureAmbiguity = loadFixtureCatalog();
  closureAmbiguity.cacheCases.public.referenceClosure = [
    closureAmbiguity.cacheCases.public.rootPath,
  ];
  assert.throws(
    () => validateFixtureCatalog(closureAmbiguity),
    /reference closure does not match the graph closure/,
  );
});

test('cache fixture materialization stays inside the shared isolated harness', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const materialized = materializePublicCacheFixture(fixture, 'content-mismatch');

    assert.equal(materialized.root.startsWith(fixture.root), true);
    assert.equal(materialized.files.graph.startsWith(fixture.root), true);
    assert.equal(materialized.files.cache.startsWith(fixture.root), true);
    assert.equal(fs.existsSync(materialized.files.graph), true);
    assert.equal(fs.existsSync(materialized.files.cache), true);
    for (const contentPath of Object.values(materialized.files.narContent)) {
      assert.equal(contentPath.startsWith(path.join(fixture.root, 'data')), true);
      assert.equal(fs.existsSync(contentPath), true);
    }
    assert.equal(materialized.files.narContent[materialized.rootPath] !== undefined, true);
  } finally {
    fixture.cleanup();
  }
});

test('fixture catalog exposes deterministic network, route, trust, command, lease, signal, and environment cases', () => {
  const catalog = loadFixtureCatalog();

  assert.equal(catalog.networkSchemaVersion, 1);
  assert.equal(catalog.trustSchemaVersion, 1);
  assert.equal(catalog.leaseSchemaVersion, 1);
  assert.equal(catalog.environmentSchemaVersion, 1);
  assert.equal(catalog.processSchemaVersion, 1);
  assert.deepEqual(NETWORK_FIXTURE_NAMES, [
    'mixed-destination',
    'private-cname',
    'private-destination',
    'private-redirect',
    'public-destination',
    'public-redirect',
  ]);
  assert.deepEqual(ROUTE_FIXTURE_NAMES, [
    'declared-en0',
    'unexpected-default',
    'unexpected-vpn',
  ]);
  assert.deepEqual(TRUST_FIXTURE_NAMES, [
    'malformed-client-key',
    'malformed-host-key',
    'valid',
  ]);
  assert.deepEqual(COMMAND_FIXTURE_NAMES, [
    'forced-stdio',
    'lease-command',
    'malformed-command',
    'unknown-command',
  ]);
  assert.deepEqual(LEASE_FIXTURE_NAMES, [
    'active-lock',
    'stale-lock',
  ]);
  assert.deepEqual(SIGNAL_FIXTURE_NAMES, ['sigint', 'sigterm']);
  assert.deepEqual(ENVIRONMENT_FIXTURE_NAMES, ['private-shopify-settings']);
  assert.deepEqual(PROCESS_FIXTURE_NAMES, [
    'network-probe',
    'remote-command',
    'signal-keeper',
    'signal-keeper-sigint',
  ]);
  assert.doesNotThrow(() => validateFixtureCatalog(catalog));
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /(?:\/Users\/|\/home\/|\/run\/secrets\/|live-secret|real-secret)/);
  assert.doesNotMatch(serialized, /(?:AKIA[0-9A-Z]{16}|sk_live_|ghp_)/);
});

test('network and route fixtures distinguish public, private, mixed, redirect, and VPN cases', () => {
  const publicCase = getNetworkFixture('public-destination');
  const privateCase = getNetworkFixture('private-destination');
  const privateCname = getNetworkFixture('private-cname');
  const mixedCase = getNetworkFixture('mixed-destination');
  const publicRedirect = getNetworkFixture('public-redirect');
  const privateRedirect = getNetworkFixture('private-redirect');

  assert.equal(publicCase.expectedDecision, 'allow');
  assert.equal(publicCase.destinations.every(destination => destination.classification === 'public'), true);
  assert.equal(privateCase.expectedDecision, 'reject');
  assert.equal(privateCase.destinations.every(destination => destination.classification === 'private'), true);
  assert.equal(privateCname.expectedDecision, 'reject');
  assert.equal(privateCname.dnsRecords[0].recordType, 'CNAME');
  assert.equal(mixedCase.expectedDecision, 'reject');
  assert.deepEqual(
    new Set(mixedCase.destinations.map(destination => destination.classification)),
    new Set(['private', 'public']),
  );
  assert.equal(publicRedirect.expectedDecision, 'allow');
  assert.equal(publicRedirect.redirects.length, 1);
  assert.equal(privateRedirect.expectedDecision, 'reject');
  assert.equal(privateRedirect.redirects[0].destinationClass, 'private');

  assert.equal(getRouteFixture('declared-en0').expectedDecision, 'allow');
  assert.equal(getRouteFixture('unexpected-default').expectedDecision, 'reject');
  assert.equal(getRouteFixture('unexpected-vpn').vpn, true);
  assert.equal(getRouteFixture('unexpected-vpn').expectedDecision, 'reject');
});

test('trust and command fixtures cover valid keys and every rejected dispatcher shape', () => {
  const validTrust = getTrustFixture('valid');
  const malformedClient = getTrustFixture('malformed-client-key');
  const malformedHost = getTrustFixture('malformed-host-key');

  assert.equal(validTrust.expectedDecision, 'accept');
  assert.match(validTrust.client.publicKey, /^ssh-ed25519 /);
  assert.match(validTrust.host.publicKey, /^ssh-ed25519 /);
  for (const publicKey of [validTrust.client.publicKey, validTrust.host.publicKey]) {
    const decoded = decodeFixturePublicKey(publicKey);
    assert.equal(decoded.keyType, 'ssh-ed25519');
    assert.equal(decoded.keyLength, 32);
    assert.equal(decoded.keyData.length, 32);
    assert.equal(decoded.blob.length, 51);
  }
  assert.equal(malformedClient.expectedDecision, 'reject');
  assert.equal(malformedHost.expectedDecision, 'reject');
  assert.equal(malformedClient.reason, 'malformed client key');
  assert.equal(malformedHost.reason, 'malformed host key');

  const shortKeyCatalog = loadFixtureCatalog();
  shortKeyCatalog.trustCases.valid.client.publicKey = makeFixturePublicKey(23, 'fixture-short-key');
  assert.throws(
    () => validateFixtureCatalog(shortKeyCatalog),
    /fixture key material|Ed25519 public key wire format/,
  );

  assert.equal(getCommandFixture('forced-stdio').expectedDecision, 'accept');
  assert.equal(getCommandFixture('lease-command').expectedDecision, 'accept');
  assert.equal(getCommandFixture('malformed-command').expectedDecision, 'reject');
  assert.equal(getCommandFixture('unknown-command').expectedDecision, 'reject');
  for (const name of ['malformed-command', 'unknown-command']) {
    assert.match(getCommandFixture(name).reason, /command/);
  }
});

test('lease and signal fixtures distinguish active protection from stale cleanup and interruption', () => {
  const active = getLeaseFixture('active-lock');
  const stale = getLeaseFixture('stale-lock');

  assert.equal(active.lock.state, 'active');
  assert.equal(active.expectedDecision, 'retain');
  assert.equal(active.lock.ageSeconds > active.idleTtlSeconds, true);
  assert.equal(stale.lock.state, 'stale');
  assert.equal(stale.expectedDecision, 'expire');
  assert.equal(stale.lock.active, false);
  assert.equal(stale.lock.ageSeconds > stale.idleTtlSeconds, true);
  assert.deepEqual(active.rootedPaths, [...active.rootedPaths].sort());
  assert.match(active.token, /^fixture-lease-token-/);

  const sigint = getSignalFixture('sigint');
  const sigterm = getSignalFixture('sigterm');
  assert.equal(sigint.signal, 'SIGINT');
  assert.equal(sigterm.signal, 'SIGTERM');
  assert.equal(sigint.processCase, 'signal-keeper-sigint');
  assert.equal(sigterm.processCase, 'signal-keeper');
  assert.equal(
    getProcessFixture(sigint.processCase).controls.keeper.defaultResponse.signal,
    sigint.signal,
  );
  assert.equal(
    getProcessFixture(sigterm.processCase).controls.keeper.responses[0].signal,
    sigterm.signal,
  );
  assert.equal(sigterm.expectedCleanup, 'remove-state-and-processes');
});

test('lease fixtures materialize manifest, lock, heartbeat, and root markers under the harness', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    for (const name of ['active-lock', 'stale-lock']) {
      const lease = materializeLeaseFixture(fixture, name);
      assert.equal(lease.requestRoot.startsWith(fixture.root), true);
      for (const filePath of [lease.files.manifest, lease.files.lock, lease.files.heartbeat]) {
        assert.equal(filePath.startsWith(fixture.root), true, filePath);
        assert.equal(fs.existsSync(filePath), true, filePath);
      }
      assert.deepEqual(JSON.parse(fs.readFileSync(lease.files.lock, 'utf8')), lease.lock);
      assert.equal(JSON.parse(fs.readFileSync(lease.files.heartbeat, 'utf8')).ageSeconds, lease.heartbeatAgeSeconds);
      assert.deepEqual(Object.keys(lease.files.roots).sort(), lease.rootedPaths);
      for (const rootMarker of Object.values(lease.files.roots)) {
        assert.equal(rootMarker.startsWith(fixture.root), true, rootMarker);
        assert.equal(fs.existsSync(rootMarker), true, rootMarker);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('environment fixtures redact private Shopify settings and materialize only under the harness root', () => {
  const environment = getEnvironmentFixture('private-shopify-settings');
  const fixture = createRemoteBuilderFixture();
  try {
    const materialized = materializeEnvironmentFixture(fixture, 'private-shopify-settings');

    assert.equal(environment.expectedRemoteExposure, 'sanitized');
    assert.ok(environment.poisonedKeys.includes('AWS_ACCESS_KEY_ID'));
    assert.ok(environment.poisonedKeys.includes('NIX_CONFIG'));
    assert.ok(environment.remoteForbiddenKeys.includes('SSH_OPTIONS'));
    for (const value of Object.values(environment.poisonedSettings)) {
      assert.match(value, /^(fixture-|<redacted>)/);
    }
    for (const pathValue of Object.values(materialized.pathValues)) {
      assert.equal(path.relative(fixture.root, pathValue).startsWith('..'), false, pathValue);
    }
    assert.equal(materialized.pathRoot.startsWith(fixture.root), true);
    assert.equal(materialized.remoteEnvironment.NIX_USER_CONF_FILES, '/dev/null');
    assert.equal(materialized.remoteEnvironment.NIX_CONFIG, 'experimental-features = nix-command flakes');
    for (const key of environment.remoteForbiddenKeys) {
      assert.equal(materialized.remoteEnvironment[key], undefined, key);
    }
  } finally {
    fixture.cleanup();
  }
});

test('environment fixture rejects traversal before materializing outside the disposable root', () => {
  const fixture = createRemoteBuilderFixture();
  const malicious = getEnvironmentFixture('private-shopify-settings');
  const maliciousPath = 'fixture-/../../../../../../outside';
  malicious.poisonedSettings.HOME = maliciousPath;
  const pathRoot = path.join(
    fixture.paths.data,
    'shopify-remote-builder',
    'environment',
    malicious.caseName,
  );
  const escapedPath = path.resolve(pathRoot, maliciousPath);
  const escapedInitially = fs.existsSync(escapedPath);

  try {
    assert.equal(path.relative(fixture.root, escapedPath).startsWith('..'), true);
    assert.equal(escapedInitially, false);
    assert.throws(
      () => materializeEnvironmentFixture(fixture, malicious.caseName, malicious),
      /fixture-relative path|escapes disposable root/,
    );
    assert.equal(fs.existsSync(escapedPath), false);

    const catalog = loadFixtureCatalog();
    catalog.environmentCases['private-shopify-settings'].poisonedSettings.HOME = maliciousPath;
    assert.throws(
      () => validateFixtureCatalog(catalog),
      /safe fixture-relative path/,
    );
  } finally {
    if (!escapedInitially) {
      fs.rmSync(escapedPath, { force: true, recursive: true });
    }
    fixture.cleanup();
  }
});

test('process catalog materializes and executes every deterministic fake response', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    for (const processName of PROCESS_FIXTURE_NAMES) {
      const processFixture = getProcessFixture(processName);
      const materialized = materializeProcessFixture(fixture, processName);

      assert.equal(JSON.stringify(processFixture).includes('/Users/'), false, processName);
      assert.equal(JSON.stringify(processFixture).includes('live-secret'), false, processName);
      for (const [commandName, control] of Object.entries(materialized.controls)) {
        const catalogControl = processFixture.controls[commandName];
        const responses = [...catalogControl.responses, catalogControl.defaultResponse];
        for (const [responseIndex, response] of responses.entries()) {
          const result = runExecutable(control.executable, ['probe', commandName], { fixture });
          assert.equal(result.status, response.signal === undefined ? response.status : null,
            `${processName}.${commandName}[${responseIndex}] status`);
          assert.equal(result.signal, response.signal ?? null,
            `${processName}.${commandName}[${responseIndex}] signal`);
          assert.equal(result.stdout, response.stdout,
            `${processName}.${commandName}[${responseIndex}] stdout`);
          assert.equal(result.stderr, response.stderr,
            `${processName}.${commandName}[${responseIndex}] stderr`);
        }
        assert.equal(control.calls().length, responses.length, `${processName}.${commandName} calls`);
        for (const call of control.calls()) {
          assert.equal(call.cwd.startsWith(fs.realpathSync(fixture.root)), true);
          assert.equal(call.env.HOME.startsWith(fixture.root), true);
        }
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('fixture schema rejects unsafe paths, malformed keys, active lease ambiguity, and poisoned process values', () => {
  const unsafePath = loadFixtureCatalog();
  unsafePath.environmentCases['private-shopify-settings'].poisonedSettings.HOME = '/Users/live-user';
  assert.throws(
    () => validateFixtureCatalog(unsafePath),
    /host path|disposable fixture value/,
  );

  const malformedKey = loadFixtureCatalog();
  malformedKey.trustCases.valid.client.publicKey = 'ssh-ed25519 live-key-material';
  assert.throws(
    () => validateFixtureCatalog(malformedKey),
    /client\.publicKey|fixture key material/,
  );

  const ambiguousLease = loadFixtureCatalog();
  ambiguousLease.leaseCases['active-lock'].lock.active = false;
  assert.throws(
    () => validateFixtureCatalog(ambiguousLease),
    /active lease fixture must have an active lock/,
  );

  const poisonedProcess = loadFixtureCatalog();
  poisonedProcess.processCases['network-probe'].controls.proxy.defaultResponse.stdout = 'live-secret';
  assert.throws(
    () => validateFixtureCatalog(poisonedProcess),
    /fixture response|disposable fixture value/,
  );
});
