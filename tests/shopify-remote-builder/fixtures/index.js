'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const {
  createFakeCommand,
  nixEnvironment,
} = require('../helpers');
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
const NETWORK_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.networkCases));
const ROUTE_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.routeCases));
const TRUST_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.trustCases));
const COMMAND_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.commandCases));
const LEASE_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.leaseCases));
const SIGNAL_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.signalCases));
const ENVIRONMENT_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.environmentCases));
const PROCESS_FIXTURE_NAMES = Object.freeze(Object.keys(INITIAL_CATALOG.processCases));

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

function getCatalogCase(collectionName, name, label) {
  const catalog = readFixtureCatalog();
  const fixture = catalog[collectionName][name];
  if (!fixture) {
    throw new Error(`unknown ${label} fixture: ${name}`);
  }
  return clone(fixture);
}

function getNetworkFixture(name) {
  return getCatalogCase('networkCases', name, 'network');
}

function getRouteFixture(name) {
  return getCatalogCase('routeCases', name, 'route');
}

function getTrustFixture(name) {
  return getCatalogCase('trustCases', name, 'trust');
}

function getCommandFixture(name) {
  return getCatalogCase('commandCases', name, 'command');
}

function getLeaseFixture(name) {
  return getCatalogCase('leaseCases', name, 'lease');
}

function getSignalFixture(name) {
  return getCatalogCase('signalCases', name, 'signal');
}

function getEnvironmentFixture(name) {
  return getCatalogCase('environmentCases', name, 'environment');
}

function getProcessFixture(name) {
  return getCatalogCase('processCases', name, 'process');
}

function assertContainedPath(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative)
  ) {
    throw new Error(`fixture materialization path escapes disposable root: ${label}`);
  }
  return resolvedCandidate;
}

function materializedPath(harness, containmentRoot, candidate, label) {
  const resolved = assertContainedPath(containmentRoot, candidate, label);
  return assertContainedPath(harness.root, resolved, label);
}

function assertHarness(harness) {
  if (
    !harness?.root
    || !path.isAbsolute(harness.root)
    || !harness?.paths?.data
    || !path.isAbsolute(harness.paths.data)
  ) {
    throw new Error('fixture materialization requires the shared isolated harness');
  }
  assertContainedPath(harness.root, harness.paths.data, 'harness data directory');
}

function materializePublicCacheFixture(harness, name) {
  assertHarness(harness);
  const fixture = getPublicCacheFixture(name);
  const root = materializedPath(
    harness,
    harness.root,
    path.join(harness.paths.data, 'shopify-remote-builder', name),
    'public cache fixture root',
  );
  const contentRoot = materializedPath(harness, root, path.join(root, 'nar-content'), 'NAR content root');
  fs.mkdirSync(contentRoot, { recursive: true, mode: 0o700 });

  const graphPath = materializedPath(harness, root, path.join(root, 'graph.json'), 'graph fixture');
  const cachePath = materializedPath(harness, root, path.join(root, 'cache.json'), 'cache fixture');
  fs.writeFileSync(graphPath, `${JSON.stringify(fixture.graph, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(cachePath, `${JSON.stringify(fixture, null, 2)}\n`, { mode: 0o600 });

  const narContentFiles = {};
  for (const content of fixture.narContent) {
    const contentPath = materializedPath(
      harness,
      contentRoot,
      path.join(contentRoot, `${path.basename(content.storePath)}.nar`),
      `NAR content for ${content.storePath}`,
    );
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

function materializeEnvironmentFixture(harness, name, fixtureOverride) {
  assertHarness(harness);
  const fixture = fixtureOverride ?? getEnvironmentFixture(name);
  const pathRoot = materializedPath(
    harness,
    harness.root,
    path.join(harness.paths.data, 'shopify-remote-builder', 'environment', name),
    'environment fixture root',
  );
  fs.mkdirSync(pathRoot, { recursive: true, mode: 0o700 });
  const pathValues = {};
  for (const pathKey of fixture.pathKeys) {
    const pathValue = materializedPath(
      harness,
      pathRoot,
      path.join(pathRoot, fixture.poisonedSettings[pathKey]),
      `environment path ${pathKey}`,
    );
    if (fixture.pathKinds[pathKey] === 'file') {
      const parentPath = materializedPath(
        harness,
        pathRoot,
        path.dirname(pathValue),
        `environment parent for ${pathKey}`,
      );
      fs.mkdirSync(parentPath, { recursive: true, mode: 0o700 });
      fs.writeFileSync(pathValue, 'fixture-poisoned-setting\n', { mode: 0o600 });
    } else {
      fs.mkdirSync(pathValue, { recursive: true, mode: 0o700 });
    }
    pathValues[pathKey] = pathValue;
  }

  const poisonedEnvironment = {
    ...fixture.poisonedSettings,
    ...pathValues,
  };
  return {
    ...fixture,
    pathRoot,
    pathValues,
    poisonedEnvironment,
    remoteEnvironment: nixEnvironment({ fixture: harness }),
  };
}

function materializeLeaseFixture(harness, name) {
  assertHarness(harness);
  const fixture = getLeaseFixture(name);
  const requestRoot = materializedPath(
    harness,
    harness.root,
    path.join(harness.paths.state, 'shopify-remote-builder', 'leases', name),
    'lease fixture root',
  );
  const rootsRoot = materializedPath(harness, requestRoot, path.join(requestRoot, 'roots'), 'lease roots');
  fs.mkdirSync(rootsRoot, { recursive: true, mode: 0o700 });

  const manifestPath = materializedPath(
    harness,
    requestRoot,
    path.join(requestRoot, 'manifest.json'),
    'lease manifest',
  );
  const lockPath = materializedPath(harness, requestRoot, path.join(requestRoot, 'active.lock'), 'lease lock');
  const heartbeatPath = materializedPath(
    harness,
    requestRoot,
    path.join(requestRoot, 'heartbeat.json'),
    'lease heartbeat',
  );
  const rootMarkers = Object.fromEntries(fixture.rootedPaths.map(storePath => {
    const markerPath = materializedPath(
      harness,
      rootsRoot,
      path.join(rootsRoot, path.basename(storePath)),
      `lease root marker for ${storePath}`,
    );
    fs.writeFileSync(markerPath, `${storePath}\n`, { mode: 0o600 });
    return [storePath, markerPath];
  }));
  const manifest = {
    token: fixture.token,
    graphDigest: fixture.graphDigest,
    rootedPaths: fixture.rootedPaths,
    selectedInputOutputs: fixture.selectedInputOutputs,
    expectedOutputs: fixture.expectedOutputs,
  };
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(lockPath, `${JSON.stringify(fixture.lock, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(
    heartbeatPath,
    `${JSON.stringify({ ageSeconds: fixture.heartbeatAgeSeconds, token: fixture.token }, null, 2)}\n`,
    { mode: 0o600 },
  );

  return {
    ...fixture,
    requestRoot,
    files: {
      manifest: manifestPath,
      lock: lockPath,
      heartbeat: heartbeatPath,
      roots: rootMarkers,
    },
  };
}

function materializeProcessFixture(harness, name) {
  assertHarness(harness);
  const fixture = getProcessFixture(name);
  const controls = Object.fromEntries(Object.entries(fixture.controls).map(
    ([commandName, options]) => [
      commandName,
      createFakeCommand(harness, `catalog-${name}-${commandName}`, options),
    ],
  ));
  return {
    ...fixture,
    controls,
  };
}

function listCases(names) {
  return [...names];
}

function listPublicCacheFixtures() {
  return [...CACHE_FIXTURE_NAMES];
}

module.exports = {
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
  listCommandFixtures: () => listCases(COMMAND_FIXTURE_NAMES),
  listEnvironmentFixtures: () => listCases(ENVIRONMENT_FIXTURE_NAMES),
  listLeaseFixtures: () => listCases(LEASE_FIXTURE_NAMES),
  listNetworkFixtures: () => listCases(NETWORK_FIXTURE_NAMES),
  listProcessFixtures: () => listCases(PROCESS_FIXTURE_NAMES),
  listPublicCacheFixtures,
  listRouteFixtures: () => listCases(ROUTE_FIXTURE_NAMES),
  listSignalFixtures: () => listCases(SIGNAL_FIXTURE_NAMES),
  listTrustFixtures: () => listCases(TRUST_FIXTURE_NAMES),
  loadFixtureCatalog,
  materializeEnvironmentFixture,
  materializeLeaseFixture,
  materializePublicCacheFixture,
  materializeProcessFixture,
  validateFixtureCatalog,
};
