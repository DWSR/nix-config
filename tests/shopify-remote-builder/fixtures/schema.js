'use strict';

const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const NAR_HASH_RE = /^sha256-[A-Za-z0-9+/]{43}=$/;
const STORE_PATH_RE = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9._+-]+$/;
const STORE_EXECUTABLE_RE = /^\/nix\/store\/[a-z0-9]{32}-[A-Za-z0-9._+-]+(?:\/[^\s]+)+$/;

function fail(message) {
  throw new Error(`invalid shopify-remote-builder fixture: ${message}`);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map(key => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function digestValue(value) {
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(value)).digest('hex')}`;
}

function assertKeys(value, allowedKeys, label) {
  if (!isObject(value)) {
    fail(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail(`${label} contains unknown field ${key}`);
    }
  }
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
}

function assertInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    fail(`${label} must be a non-negative integer`);
  }
}

function assertStorePath(value, label) {
  assertString(value, label);
  if (!STORE_PATH_RE.test(value)) {
    fail(`${label} is not a store path: ${value}`);
  }
}

function assertDerivationPath(value, label) {
  assertStorePath(value, label);
  if (!value.endsWith('.drv')) {
    fail(`${label} must end in .drv: ${value}`);
  }
}

function assertSortedUnique(values, label, assertValue = assertString) {
  if (!Array.isArray(values)) {
    fail(`${label} must be an array`);
  }
  let previous;
  for (const [index, value] of values.entries()) {
    assertValue(value, `${label}[${index}]`);
    if (previous !== undefined && value <= previous) {
      fail(`${label} must be sorted and duplicate-free`);
    }
    previous = value;
  }
}

function assertDigest(value, label) {
  assertString(value, label);
  if (!DIGEST_RE.test(value)) {
    fail(`${label} must be a sha256 hex digest`);
  }
}

function assertNarHash(value, label) {
  assertString(value, label);
  if (!NAR_HASH_RE.test(value)) {
    fail(`${label} must be a base64 NAR hash`);
  }
}

function assertStringArray(values, label) {
  if (!Array.isArray(values) || values.some(value => typeof value !== 'string')) {
    fail(`${label} must be an array of strings`);
  }
}

function graphDigestInput(graph) {
  return {
    cacheRoot: graph.cacheRoot,
    derivations: graph.derivations,
    graphIdentity: {
      evaluatorConfigDigest: graph.graphIdentity.evaluatorConfigDigest,
      schemaVersion: graph.graphIdentity.schemaVersion,
    },
    id: graph.id,
    references: graph.references,
    referenceClosures: graph.referenceClosures,
    schemaVersion: graph.schemaVersion,
    system: graph.system,
    topDerivation: graph.topDerivation,
    topOutput: graph.topOutput,
  };
}

function graphDigest(graph) {
  return digestValue(graphDigestInput(graph));
}

function validateDerivation(derivation, graphName, index) {
  const label = `${graphName}.derivations[${index}]`;
  assertKeys(
    derivation,
    new Set([
      'path',
      'system',
      'builder',
      'args',
      'environment',
      'outputs',
      'inputDerivations',
      'inputSources',
    ]),
    label,
  );
  assertDerivationPath(derivation.path, `${label}.path`);
  assertString(derivation.system, `${label}.system`);
  assertString(derivation.builder, `${label}.builder`);
  if (!STORE_EXECUTABLE_RE.test(derivation.builder)) {
    fail(`${label}.builder must be a store executable`);
  }
  assertStringArray(derivation.args, `${label}.args`);
  if (!isObject(derivation.environment)) {
    fail(`${label}.environment must be an object`);
  }
  for (const [key, value] of Object.entries(derivation.environment)) {
    assertString(key, `${label}.environment key`);
    assertString(value, `${label}.environment.${key}`);
  }
  if (!Array.isArray(derivation.outputs) || derivation.outputs.length === 0) {
    fail(`${label}.outputs must be a non-empty array`);
  }
  const outputNames = [];
  for (const [outputIndex, output] of derivation.outputs.entries()) {
    const outputLabel = `${label}.outputs[${outputIndex}]`;
    assertKeys(output, new Set(['name', 'path', 'hash']), outputLabel);
    assertString(output.name, `${outputLabel}.name`);
    assertStorePath(output.path, `${outputLabel}.path`);
    assertKeys(
      output.hash,
      new Set(['algorithm', 'mode', 'value']),
      `${outputLabel}.hash`,
    );
    assertString(output.hash.algorithm, `${outputLabel}.hash.algorithm`);
    assertString(output.hash.mode, `${outputLabel}.hash.mode`);
    assertDigest(output.hash.value, `${outputLabel}.hash.value`);
    outputNames.push(output.name);
  }
  assertSortedUnique(outputNames, `${label}.outputs names`);

  if (!Array.isArray(derivation.inputDerivations)) {
    fail(`${label}.inputDerivations must be an array`);
  }
  const inputDerivationPaths = [];
  for (const [inputIndex, input] of derivation.inputDerivations.entries()) {
    const inputLabel = `${label}.inputDerivations[${inputIndex}]`;
    assertKeys(input, new Set(['path', 'outputs']), inputLabel);
    assertDerivationPath(input.path, `${inputLabel}.path`);
    assertSortedUnique(input.outputs, `${inputLabel}.outputs`);
    inputDerivationPaths.push(input.path);
  }
  assertSortedUnique(inputDerivationPaths, `${label}.inputDerivations paths`);
  assertSortedUnique(derivation.inputSources, `${label}.inputSources`, assertStorePath);
}

function validateGraph(graph, graphName) {
  const label = `graphs.${graphName}`;
  assertKeys(
    graph,
    new Set([
      'schemaVersion',
      'id',
      'system',
      'topDerivation',
      'topOutput',
      'cacheRoot',
      'graphIdentity',
      'derivations',
      'references',
      'referenceClosures',
    ]),
    label,
  );
  if (graph.schemaVersion !== SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (graph.id !== graphName) {
    fail(`${label}.id must equal ${graphName}`);
  }
  assertString(graph.system, `${label}.system`);
  assertDerivationPath(graph.topDerivation, `${label}.topDerivation`);
  assertStorePath(graph.topOutput, `${label}.topOutput`);
  assertStorePath(graph.cacheRoot, `${label}.cacheRoot`);
  if (graph.cacheRoot === graph.topOutput) {
    fail(`${label}.cacheRoot must not be the top output`);
  }
  assertKeys(
    graph.graphIdentity,
    new Set(['schemaVersion', 'topDerivation', 'evaluatorConfigDigest', 'graphDigest']),
    `${label}.graphIdentity`,
  );
  if (graph.graphIdentity.schemaVersion !== SCHEMA_VERSION) {
    fail(`${label}.graphIdentity.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (graph.graphIdentity.topDerivation !== graph.topDerivation) {
    fail(`${label}.graphIdentity.topDerivation must match topDerivation`);
  }
  assertDigest(
    graph.graphIdentity.evaluatorConfigDigest,
    `${label}.graphIdentity.evaluatorConfigDigest`,
  );
  if (!Array.isArray(graph.derivations) || graph.derivations.length === 0) {
    fail(`${label}.derivations must be a non-empty array`);
  }
  const derivationPaths = graph.derivations.map(derivation => derivation.path);
  if (new Set(derivationPaths).size !== derivationPaths.length) {
    const duplicatePath = derivationPaths.find(
      (path, index) => derivationPaths.indexOf(path) !== index,
    );
    fail(`${label}: duplicate derivation path ${duplicatePath}`);
  }
  assertSortedUnique(derivationPaths, `${label}.derivation paths`, assertDerivationPath);
  const derivations = new Map();
  const outputs = new Map();
  const sourcePaths = new Set();
  for (const [index, derivation] of graph.derivations.entries()) {
    validateDerivation(derivation, graphName, index);
    derivations.set(derivation.path, derivation);
    for (const output of derivation.outputs) {
      if (outputs.has(output.path)) {
        fail(`${label}: duplicate output path ${output.path}`);
      }
      outputs.set(output.path, { derivation, output });
    }
    for (const sourcePath of derivation.inputSources) {
      sourcePaths.add(sourcePath);
    }
  }
  if (!derivations.has(graph.topDerivation)) {
    fail(`${label}.topDerivation is not in derivations`);
  }
  if (!outputs.has(graph.topOutput)) {
    fail(`${label}.topOutput is not a derivation output`);
  }
  if (outputs.get(graph.topOutput).derivation.path !== graph.topDerivation) {
    fail(`${label}.topOutput is not produced by topDerivation`);
  }
  if (!outputs.has(graph.cacheRoot)) {
    fail(`${label}.cacheRoot is not a derivation output`);
  }

  for (const derivation of graph.derivations) {
    for (const input of derivation.inputDerivations) {
      const inputDerivation = derivations.get(input.path);
      if (!inputDerivation) {
        fail(`${label}: input derivation is not in graph: ${input.path}`);
      }
      const inputNames = new Set(inputDerivation.outputs.map(output => output.name));
      for (const outputName of input.outputs) {
        if (!inputNames.has(outputName)) {
          fail(`${label}: input output is not declared: ${input.path}^${outputName}`);
        }
      }
    }
  }

  const knownPaths = new Set([...outputs.keys(), ...sourcePaths]);
  const referenceKeys = Object.keys(graph.references);
  assertSortedUnique(referenceKeys, `${label}.references keys`, assertStorePath);
  if (referenceKeys.length !== knownPaths.size || referenceKeys.some(path => !knownPaths.has(path))) {
    fail(`${label}.references must cover every graph path exactly once`);
  }
  for (const referencePath of referenceKeys) {
    assertSortedUnique(
      graph.references[referencePath],
      `${label}.references.${referencePath}`,
      assertStorePath,
    );
    for (const target of graph.references[referencePath]) {
      if (!knownPaths.has(target)) {
        fail(`${label}: reference target is not in graph: ${target}`);
      }
    }
  }

  const closureKeys = Object.keys(graph.referenceClosures);
  assertSortedUnique(closureKeys, `${label}.referenceClosures keys`, assertStorePath);
  if (closureKeys.length !== knownPaths.size || closureKeys.some(path => !knownPaths.has(path))) {
    fail(`${label}.referenceClosures must cover every graph path exactly once`);
  }
  for (const closurePath of closureKeys) {
    const closure = graph.referenceClosures[closurePath];
    assertSortedUnique(closure, `${label}.referenceClosures.${closurePath}`, assertStorePath);
    if (!closure.includes(closurePath)) {
      fail(`${label}.referenceClosures.${closurePath} must include its root`);
    }
    const expected = new Set();
    const visit = path => {
      if (expected.has(path)) {
        return;
      }
      expected.add(path);
      for (const target of graph.references[path]) {
        visit(target);
      }
    };
    visit(closurePath);
    const expectedSorted = [...expected].sort();
    if (JSON.stringify(closure) !== JSON.stringify(expectedSorted)) {
      fail(`${label}.referenceClosures.${closurePath} does not match transitive references`);
    }
  }

  const computedDigest = graphDigest(graph);
  if (graph.graphIdentity.graphDigest !== undefined) {
    assertDigest(graph.graphIdentity.graphDigest, `${label}.graphIdentity.graphDigest`);
    if (graph.graphIdentity.graphDigest !== computedDigest) {
      fail(`${label}.graphIdentity.graphDigest does not match graph contents`);
    }
  }
  return { computedDigest, knownPaths, outputs };
}

function validateNarinfoSet(entries, setName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`narinfoSets.${setName} must be a non-empty array`);
  }
  const paths = [];
  for (const [index, entry] of entries.entries()) {
    const label = `narinfoSets.${setName}[${index}]`;
    assertKeys(
      entry,
      new Set(['storePath', 'narHash', 'narSize', 'references', 'deriver', 'lastModified', 'signatures']),
      label,
    );
    assertStorePath(entry.storePath, `${label}.storePath`);
    assertNarHash(entry.narHash, `${label}.narHash`);
    assertInteger(entry.narSize, `${label}.narSize`);
    assertSortedUnique(entry.references, `${label}.references`, assertStorePath);
    if (entry.deriver !== null) {
      assertDerivationPath(entry.deriver, `${label}.deriver`);
    }
    assertInteger(entry.lastModified, `${label}.lastModified`);
    if (!Array.isArray(entry.signatures) || entry.signatures.some(signature => typeof signature !== 'string')) {
      fail(`${label}.signatures must be an array of strings`);
    }
    if (new Set(entry.signatures).size !== entry.signatures.length) {
      fail(`${label}.signatures must be duplicate-free`);
    }
    for (const signature of entry.signatures) {
      if (!/^[A-Za-z0-9._-]+:[A-Za-z0-9._:-]+$/.test(signature)) {
        fail(`${label}.signatures contains an invalid signature`);
      }
    }
    paths.push(entry.storePath);
  }
  assertSortedUnique(paths, `narinfoSets.${setName} paths`, assertStorePath);
}

function decodeContent(content, label) {
  const { data } = content;
  if (content.encoding !== 'base64') {
    fail(`${label}.encoding must be base64`);
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 !== 0) {
    fail(`${label}.data must be canonical base64`);
  }
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) {
    fail(`${label}.data must be canonical base64`);
  }
  return bytes;
}

function validateContentSet(entries, setName) {
  if (!Array.isArray(entries) || entries.length === 0) {
    fail(`contentSets.${setName} must be a non-empty array`);
  }
  const paths = [];
  for (const [index, content] of entries.entries()) {
    const label = `contentSets.${setName}[${index}]`;
    assertKeys(content, new Set(['storePath', 'encoding', 'data']), label);
    assertStorePath(content.storePath, `${label}.storePath`);
    assertString(content.data, `${label}.data`);
    decodeContent(content, label);
    paths.push(content.storePath);
  }
  assertSortedUnique(paths, `contentSets.${setName} paths`, assertStorePath);
}

function mapEntries(entries) {
  return new Map(entries.map(entry => [entry.storePath, entry]));
}

function validateCacheCase(cacheCase, caseName, catalog, graphResults) {
  const label = `cacheCases.${caseName}`;
  assertKeys(
    cacheCase,
    new Set([
      'schemaVersion',
      'caseName',
      'graphId',
      'rootPath',
      'endpoint',
      'cacheClass',
      'approvalStatus',
      'trustedKeyId',
      'narinfoSet',
      'contentSet',
      'observedAt',
      'maxAgeSeconds',
      'referenceClosure',
      'missingPaths',
      'expectedDecision',
      'reason',
      'closureStatus',
      'signatureStatus',
      'freshnessStatus',
      'contentStatus',
    ]),
    label,
  );
  if (cacheCase.schemaVersion !== SCHEMA_VERSION) {
    fail(`${label}.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (cacheCase.caseName !== caseName) {
    fail(`${label}.caseName must equal ${caseName}`);
  }
  if (!catalog.graphs[cacheCase.graphId]) {
    fail(`${label}.graphId does not name a graph`);
  }
  const graph = catalog.graphs[cacheCase.graphId];
  const graphResult = graphResults.get(cacheCase.graphId);
  assertStorePath(cacheCase.rootPath, `${label}.rootPath`);
  if (cacheCase.rootPath !== graph.cacheRoot) {
    fail(`${label}.rootPath must equal the graph cacheRoot`);
  }
  assertString(cacheCase.endpoint, `${label}.endpoint`);
  try {
    if (new URL(cacheCase.endpoint).protocol !== 'https:') {
      fail(`${label}.endpoint must use HTTPS`);
    }
  } catch {
    fail(`${label}.endpoint must be a valid HTTPS URL`);
  }
  if (!['public', 'private'].includes(cacheCase.cacheClass)) {
    fail(`${label}.cacheClass is not supported`);
  }
  if (!['approved', 'private'].includes(cacheCase.approvalStatus)) {
    fail(`${label}.approvalStatus is not supported`);
  }
  assertString(cacheCase.trustedKeyId, `${label}.trustedKeyId`);
  if (!catalog.narinfoSets[cacheCase.narinfoSet]) {
    fail(`${label}.narinfoSet does not name a set`);
  }
  if (!catalog.contentSets[cacheCase.contentSet]) {
    fail(`${label}.contentSet does not name a set`);
  }
  assertInteger(cacheCase.observedAt, `${label}.observedAt`);
  if (!Number.isInteger(cacheCase.maxAgeSeconds) || cacheCase.maxAgeSeconds <= 0) {
    fail(`${label}.maxAgeSeconds must be a positive integer`);
  }
  assertSortedUnique(cacheCase.referenceClosure, `${label}.referenceClosure`, assertStorePath);
  assertSortedUnique(cacheCase.missingPaths, `${label}.missingPaths`, assertStorePath);
  assertSortedUnique(
    graph.referenceClosures[cacheCase.rootPath],
    `${label}.graph reference closure`,
    assertStorePath,
  );
  if (JSON.stringify(cacheCase.referenceClosure) !== JSON.stringify(graph.referenceClosures[cacheCase.rootPath])) {
    fail(`${label}: reference closure does not match the graph closure`);
  }
  if (!['cut', 'traverse'].includes(cacheCase.expectedDecision)) {
    fail(`${label}.expectedDecision is not supported`);
  }
  if (!['complete', 'partial'].includes(cacheCase.closureStatus)) {
    fail(`${label}.closureStatus is not supported`);
  }
  if (!['trusted', 'unsigned', 'untrusted'].includes(cacheCase.signatureStatus)) {
    fail(`${label}.signatureStatus is not supported`);
  }
  if (!['fresh', 'stale'].includes(cacheCase.freshnessStatus)) {
    fail(`${label}.freshnessStatus is not supported`);
  }
  if (!['matching', 'mismatch'].includes(cacheCase.contentStatus)) {
    fail(`${label}.contentStatus is not supported`);
  }
  if (cacheCase.reason !== null) {
    assertString(cacheCase.reason, `${label}.reason`);
  }

  const narinfos = catalog.narinfoSets[cacheCase.narinfoSet];
  const narinfoMap = mapEntries(narinfos);
  const expectedMissingPaths = cacheCase.referenceClosure.filter(path => !narinfoMap.has(path));
  if (JSON.stringify(cacheCase.missingPaths) !== JSON.stringify(expectedMissingPaths)) {
    fail(`${label}.missingPaths does not match missing narinfos`);
  }
  const content = catalog.contentSets[cacheCase.contentSet];
  const contentMap = mapEntries(content);
  if (contentMap.size !== cacheCase.referenceClosure.length
    || cacheCase.referenceClosure.some(path => !contentMap.has(path))) {
    fail(`${label}.contentSet must contain exactly the reference closure`);
  }
  for (const narinfo of narinfos) {
    if (!cacheCase.referenceClosure.includes(narinfo.storePath)) {
      fail(`${label}.narinfo contains a path outside the reference closure`);
    }
    if (JSON.stringify(narinfo.references) !== JSON.stringify(graph.references[narinfo.storePath])) {
      fail(`${label}.narinfo references do not match graph references for ${narinfo.storePath}`);
    }
  }

  const actualSignatureStatus = narinfos.every(narinfo => narinfo.signatures.length === 0)
    ? 'unsigned'
    : narinfos.every(narinfo => narinfo.signatures.length > 0
      && narinfo.signatures.every(signature => signature.startsWith(`${cacheCase.trustedKeyId}:`)))
      ? 'trusted'
      : 'untrusted';
  if (actualSignatureStatus !== cacheCase.signatureStatus) {
    fail(`${label}.signatureStatus does not match narinfo signatures`);
  }
  const actualFreshnessStatus = narinfos.every(
    narinfo => narinfo.lastModified >= cacheCase.observedAt - cacheCase.maxAgeSeconds,
  ) ? 'fresh' : 'stale';
  if (actualFreshnessStatus !== cacheCase.freshnessStatus) {
    fail(`${label}.freshnessStatus does not match narinfo timestamps`);
  }
  const actualContentStatus = narinfos.every(narinfo => {
    const bytes = decodeContent(contentMap.get(narinfo.storePath), `${label}.content`);
    const narHash = `sha256-${crypto.createHash('sha256').update(bytes).digest('base64')}`;
    return narinfo.narSize === bytes.length && narinfo.narHash === narHash;
  }) ? 'matching' : 'mismatch';
  if (actualContentStatus !== cacheCase.contentStatus) {
    fail(`${label}.contentStatus does not match NAR content`);
  }
  const actualClosureStatus = expectedMissingPaths.length === 0 ? 'complete' : 'partial';
  if (actualClosureStatus !== cacheCase.closureStatus) {
    fail(`${label}.closureStatus does not match narinfo coverage`);
  }

  const approvedComplete = cacheCase.cacheClass === 'public'
    && cacheCase.approvalStatus === 'approved'
    && actualClosureStatus === 'complete'
    && actualSignatureStatus === 'trusted'
    && actualFreshnessStatus === 'fresh'
    && actualContentStatus === 'matching';
  if (approvedComplete && cacheCase.expectedDecision !== 'cut') {
    fail(`${label}: approved complete cache case must cut`);
  }
  if (cacheCase.expectedDecision === 'cut' && !approvedComplete) {
    fail(`${label}: only an approved complete trusted fresh matching cache case may cut`);
  }
  if (cacheCase.expectedDecision === 'cut' && cacheCase.reason !== null) {
    fail(`${label}.reason must be null for a cut`);
  }
  if (cacheCase.expectedDecision === 'traverse' && cacheCase.reason === null) {
    fail(`${label}.reason is required when traversal continues`);
  }
  if (cacheCase.cacheClass === 'private'
    && (cacheCase.approvalStatus !== 'private' || cacheCase.expectedDecision !== 'traverse')) {
    fail(`${label}: private cache cases cannot produce a cut`);
  }
  if (cacheCase.cacheClass === 'public' && cacheCase.approvalStatus !== 'approved') {
    fail(`${label}: public cache cases require approved status`);
  }
  if (graphResult.outputs.size === 0) {
    fail(`${label}: graph has no outputs`);
  }
}

function validateFixtureCatalog(catalog) {
  assertKeys(
    catalog,
    new Set([
      'schemaVersion',
      'graphSchemaVersion',
      'cacheSchemaVersion',
      'graphs',
      'narinfoSets',
      'contentSets',
      'cacheCases',
    ]),
    'catalog',
  );
  if (catalog.schemaVersion !== SCHEMA_VERSION) {
    fail(`catalog.schemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (catalog.graphSchemaVersion !== SCHEMA_VERSION) {
    fail(`catalog.graphSchemaVersion must be ${SCHEMA_VERSION}`);
  }
  if (catalog.cacheSchemaVersion !== SCHEMA_VERSION) {
    fail(`catalog.cacheSchemaVersion must be ${SCHEMA_VERSION}`);
  }
  for (const [graphName, graph] of Object.entries(catalog.graphs)) {
    validateGraph(graph, graphName);
  }
  if (!isObject(catalog.narinfoSets) || Object.keys(catalog.narinfoSets).length === 0) {
    fail('catalog.narinfoSets must be a non-empty object');
  }
  for (const [setName, entries] of Object.entries(catalog.narinfoSets)) {
    validateNarinfoSet(entries, setName);
  }
  if (!isObject(catalog.contentSets) || Object.keys(catalog.contentSets).length === 0) {
    fail('catalog.contentSets must be a non-empty object');
  }
  for (const [setName, entries] of Object.entries(catalog.contentSets)) {
    validateContentSet(entries, setName);
  }
  if (!isObject(catalog.cacheCases) || Object.keys(catalog.cacheCases).length === 0) {
    fail('catalog.cacheCases must be a non-empty object');
  }
  const graphResults = new Map(
    Object.entries(catalog.graphs).map(([name, graph]) => [name, {
      ...validateGraph(graph, name),
      graph,
    }]),
  );
  for (const [caseName, cacheCase] of Object.entries(catalog.cacheCases)) {
    validateCacheCase(cacheCase, caseName, catalog, graphResults);
  }
  return catalog;
}

function enrichGraph(graph) {
  const result = clone(graph);
  result.graphIdentity.graphDigest = graphDigest(result);
  return result;
}

module.exports = {
  SCHEMA_VERSION,
  canonicalJson,
  clone,
  decodeContent,
  digestValue,
  enrichGraph,
  graphDigest,
  validateFixtureCatalog,
};
