'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  clone,
  decodeContent,
  digestValue,
  enrichGraph,
  validateFixtureCatalog,
} = require('./schema');

const CATALOG_PATH = path.join(__dirname, 'catalog-v1.json');

function readFixtureCatalog() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  validateFixtureCatalog(catalog);
  return catalog;
}

const INITIAL_CATALOG = readFixtureCatalog();
const GRAPH_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.graphs));
const CACHE_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.cacheCases));

function loadFixtureCatalog() {
  return clone(readFixtureCatalog());
}

function getDerivationGraph(name) {
  const catalog = readFixtureCatalog();
  const graph = catalog.graphs[name];
  if (!graph) {
    throw new Error(`unknown derivation graph fixture: ${name}`);
  }
  return enrichGraph(graph);
}

function getPublicCacheFixture(name) {
  const catalog = readFixtureCatalog();
  const cacheCase = catalog.cacheCases[name];
  if (!cacheCase) {
    throw new Error(`unknown public-cache fixture: ${name}`);
  }
  const graph = enrichGraph(catalog.graphs[cacheCase.graphId]);
  const narinfos = clone(catalog.narinfoSets[cacheCase.narinfoSet]);
  const narinfoByPath = new Map(narinfos.map(narinfo => [narinfo.storePath, narinfo]));
  const narContent = catalog.contentSets[cacheCase.contentSet].map(content => {
    const bytes = decodeContent(content, `${name}.${content.storePath}`);
    const narinfo = narinfoByPath.get(content.storePath);
    const contentHash = `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
    return {
      ...clone(content),
      matchesNarinfo: narinfo === undefined
        ? false
        : narinfo.narSize === bytes.length && narinfo.narHash === contentHash,
    };
  });
  const referenceClosure = [...cacheCase.referenceClosure];
  const closureDigest = digestValue(referenceClosure);
  const publicCacheCut = cacheCase.expectedDecision === 'cut'
    ? {
      rootPath: cacheCase.rootPath,
      closure: referenceClosure,
      closureDigest,
      endpoint: cacheCase.endpoint,
      signingKeyId: cacheCase.trustedKeyId,
    }
    : null;

  return {
    ...clone(cacheCase),
    graph,
    narinfos,
    narContent,
    closureDigest,
    publicCacheCut,
  };
}

function assertHarness(harness) {
  if (!harness?.paths?.data || !path.isAbsolute(harness.paths.data)) {
    throw new Error('fixture materialization requires the shared isolated harness');
  }
}

function materializePublicCacheFixture(harness, name) {
  assertHarness(harness);
  const fixture = getPublicCacheFixture(name);
  const root = path.join(harness.paths.data, 'shopify-remote-builder', name);
  const contentRoot = path.join(root, 'nar-content');
  fs.mkdirSync(contentRoot, { recursive: true, mode: 0o700 });

  const graphPath = path.join(root, 'graph.json');
  const cachePath = path.join(root, 'cache.json');
  fs.writeFileSync(graphPath, `${JSON.stringify(fixture.graph, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(cachePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });

  const narContentFiles = {};
  for (const content of fixture.narContent) {
    const contentPath = path.join(contentRoot, `${path.basename(content.storePath)}.nar`);
    fs.writeFileSync(contentPath, decodeContent(content, `${name}.${content.storePath}`), {
      mode: 0o600,
    });
    narContentFiles[content.storePath] = contentPath;
  }

  return {
    ...fixture,
    root,
    files: {
      graph: graphPath,
      cache: cachePath,
      narContent: narContentFiles,
    },
  };
}

function listPublicCacheFixtures() {
  return [...CACHE_FIXTURE_NAMES];
}

module.exports = {
  CACHE_FIXTURE_NAMES,
  GRAPH_FIXTURE_NAMES,
  getDerivationGraph,
  getPublicCacheFixture,
  listPublicCacheFixtures,
  loadFixtureCatalog,
  materializePublicCacheFixture,
  validateFixtureCatalog,
};
