'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createRemoteBuilderFixture } = require('./helpers');
const {
  CACHE_FIXTURE_NAMES,
  GRAPH_FIXTURE_NAMES,
  getDerivationGraph,
  getPublicCacheFixture,
  listPublicCacheFixtures,
  loadFixtureCatalog,
  materializePublicCacheFixture,
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
