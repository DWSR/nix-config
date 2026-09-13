'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath } = require('node:url');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
  runExecutable,
} = require('./helpers');
const {
  getPublicCacheFixture,
} = require('./fixtures');

const CACHE_VERIFIER_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-cache-verifier.nix',
);
const PROXY_ENDPOINT = 'socks5h://127.0.0.1:1080';
const PUBLIC_ENDPOINT = 'https://cache.nixos.org';
const NONCE = 'fixture-cache-verifier-nonce-0001';
const PUBLIC_TRUSTED_KEY = 'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=';

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function nixValue(value) {
  if (typeof value === 'string') return nixString(value);
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return `[ ${value.map(nixValue).join(' ')} ]`;
  if (value !== null && typeof value === 'object') {
    return `{ ${Object.entries(value).map(([key, entry]) => (
      `${nixString(key)} = ${nixValue(entry)};`
    )).join(' ')} }`;
  }
  throw new TypeError(`unsupported Nix fixture value: ${value}`);
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-cache-verifier-read-only', `
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

function loadVerifier(fixture, nativeCacheVerifierExecutable, options = {}) {
  const packageArguments = Object.entries({
    approvedCacheConfigurations: options.approvedCacheConfigurations,
    approvedCacheEndpoints: options.approvedCacheEndpoints,
    curlExecutable: options.curlExecutable,
    maxGraphPaths: options.maxGraphPaths,
    maxRequestBytes: options.maxRequestBytes,
    policyProxyPort: options.policyProxyPort,
    queryTimeoutSeconds: options.queryTimeoutSeconds,
    nativeCacheVerifierExecutable,
  })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name} = ${nixValue(value)};`)
    .join('\n        ');
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ${nixString(CACHE_VERIFIER_PATH)} {
        ${packageArguments}
      }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-cache-verifier');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function createMultiReferenceCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  const sourcePath = cacheFixture.graph.references[rootPath][0];
  const extraPath = '/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-shopify-remote-extra';
  const references = {
    ...cacheFixture.graph.references,
    [extraPath]: [],
    [rootPath]: [extraPath, sourcePath].sort(),
  };
  const sourceNarinfo = cacheFixture.narinfos.find(entry => entry.storePath === sourcePath);
  const sourceContent = cacheFixture.narContent.find(entry => entry.storePath === sourcePath);

  cacheFixture.graph = {
    ...cacheFixture.graph,
    references,
  };
  cacheFixture.referenceClosure = [rootPath, extraPath, sourcePath].sort();
  cacheFixture.narinfos = [
    ...cacheFixture.narinfos.map(entry => entry.storePath === rootPath
      ? { ...entry, references: references[rootPath] }
      : entry),
    {
      ...sourceNarinfo,
      storePath: extraPath,
      references: [],
      signatures: [`${cacheFixture.trustedKeyId}:fixture-signature-extra-v1`],
    },
  ].sort((left, right) => left.storePath.localeCompare(right.storePath));
  cacheFixture.narContent = [
    ...cacheFixture.narContent,
    { ...sourceContent, storePath: extraPath },
  ].sort((left, right) => left.storePath.localeCompare(right.storePath));
  return cacheFixture;
}

function createSelfReferenceCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  const references = {
    ...cacheFixture.graph.references,
    [rootPath]: [
      ...new Set([...cacheFixture.graph.references[rootPath], rootPath]),
    ].sort(),
  };

  cacheFixture.graph = {
    ...cacheFixture.graph,
    references,
  };
  cacheFixture.narinfos = cacheFixture.narinfos.map(entry => (
    entry.storePath === rootPath
      ? { ...entry, references: references[rootPath] }
      : entry
  ));
  return cacheFixture;
}

function createCyclicReferenceCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  const childPath = cacheFixture.graph.references[rootPath][0];
  cacheFixture.graph = {
    ...cacheFixture.graph,
    references: {
      ...cacheFixture.graph.references,
      [rootPath]: [childPath],
      [childPath]: [rootPath],
    },
  };
  return cacheFixture;
}

function createInvalidReferenceCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  const invalidPath = '/nix/store/99999999999999999999999999999999-shopify-remote-invalid';
  cacheFixture.graph = {
    ...cacheFixture.graph,
    references: {
      ...cacheFixture.graph.references,
      [rootPath]: [...cacheFixture.graph.references[rootPath], invalidPath].sort(),
    },
  };
  return cacheFixture;
}

function createTopOutputClosureCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const topOutput = cacheFixture.graph.topOutput;
  const extraPath = '/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-shopify-remote-top-descendant';
  const dependencyNarinfo = cacheFixture.narinfos.find(
    entry => entry.storePath === cacheFixture.rootPath,
  );
  const dependencyContent = cacheFixture.narContent.find(
    entry => entry.storePath === cacheFixture.rootPath,
  );
  const narinfo = (storePath, references, deriver) => ({
    ...dependencyNarinfo,
    storePath,
    references,
    deriver,
    signatures: [`${cacheFixture.trustedKeyId}:fixture-signature-${path.basename(storePath)}`],
  });

  cacheFixture.graph = {
    ...cacheFixture.graph,
    references: {
      ...cacheFixture.graph.references,
      [extraPath]: [topOutput],
    },
  };
  cacheFixture.narinfos = [
    ...cacheFixture.narinfos,
    narinfo(extraPath, [topOutput], null),
    narinfo(topOutput, cacheFixture.graph.references[topOutput], cacheFixture.graph.topDerivation),
  ];
  cacheFixture.narContent = [
    ...cacheFixture.narContent,
    { ...dependencyContent, storePath: extraPath },
    { ...dependencyContent, storePath: topOutput },
  ];

  return { cacheFixture, extraPath };
}

function createSpecialCharacterCacheFixture() {
  const cacheFixture = getPublicCacheFixture('public');
  const originalRoot = cacheFixture.rootPath;
  const specialRoot = originalRoot.replace(
    '-shopify-remote-dependency',
    '-shopify?remote',
  );
  const remapPath = storePath => storePath === originalRoot ? specialRoot : storePath;
  const remapReferences = references => Object.fromEntries(
    Object.entries(references).map(([storePath, childPaths]) => [
      remapPath(storePath),
      childPaths.map(remapPath),
    ]),
  );

  cacheFixture.rootPath = specialRoot;
  cacheFixture.referenceClosure = cacheFixture.referenceClosure.map(remapPath).sort();
  cacheFixture.graph = {
    ...cacheFixture.graph,
    cacheRoot: specialRoot,
    references: remapReferences(cacheFixture.graph.references),
    referenceClosures: remapReferences(cacheFixture.graph.referenceClosures),
  };
  cacheFixture.narinfos = cacheFixture.narinfos.map(entry => ({
    ...entry,
    storePath: remapPath(entry.storePath),
    references: entry.references.map(remapPath),
  }));
  cacheFixture.narContent = cacheFixture.narContent.map(entry => ({
    ...entry,
    storePath: remapPath(entry.storePath),
  }));
  return cacheFixture;
}

function createSamePathContaminationFixture() {
  const cacheFixture = getPublicCacheFixture('content-mismatch');
  const validPublicFixture = getPublicCacheFixture('public');
  const localContent = validPublicFixture.narContent.map(content => ({ ...content }));
  return {
    atticStore: {
      endpoint: 'https://attic.shopify.invalid/private',
      narContent: localContent,
    },
    cacheFixture,
    normalStore: {
      endpoint: 'daemon',
      narContent: localContent,
    },
    contaminatedPath: cacheFixture.graph.references[cacheFixture.rootPath][0],
  };
}

function materializeStoreFixture(fixture, name, store) {
  if (store === undefined) return undefined;
  const root = path.join(fixture.paths.data, 'cache-verifier-stores', name);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const files = Object.fromEntries(store.narContent.map(content => {
    const contentPath = path.join(root, `${path.basename(content.storePath)}.nar`);
    fs.writeFileSync(contentPath, Buffer.from(content.data, 'base64'), { mode: 0o600 });
    return [content.storePath, contentPath];
  }));
  return { root, files };
}

function pathIsContained(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function nativeMetadata(entry, overrides = {}) {
  const metadata = {
    storePath: entry.storePath,
    narHash: entry.narHash,
    narSize: entry.narSize,
    references: entry.references,
    deriver: entry.deriver,
    signatures: entry.signatures,
    ...overrides,
  };
  if (overrides.omitNarHash) {
    delete metadata.narHash;
    delete metadata.omitNarHash;
  }
  if (overrides.omitDeriver) {
    delete metadata.deriver;
    delete metadata.omitDeriver;
  }
  return metadata;
}

function attestedMetadata(entry) {
  const metadata = nativeMetadata(entry);
  delete metadata.deriver;
  return metadata;
}

function createFakeNativeVerifier(fixture, cacheFixture, options = {}) {
  const logPath = path.join(fixture.paths.logs, 'cache-verifier-native.jsonl');
  const staticConfiguration = options.approvedCacheConfigurations?.[0] ?? {
    endpoint: PUBLIC_ENDPOINT,
    trustedKeys: [PUBLIC_TRUSTED_KEY],
  };
  const staticKeyId = staticConfiguration.trustedKeys[0]?.split(':')[0];
  const nativeStatus = options.nativeStatus;
  const materializedStoreFiles = Object.fromEntries(
    Object.entries(options.materializedStores ?? {}).map(([name, store]) => [name, store.files]),
  );
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const executable = fixture.createExecutable('cache-verifier-native', `
    const fs = require('node:fs');
    const crypto = require('node:crypto');
    const path = require('node:path');
    const { fileURLToPath } = require('node:url');
    const logPath = ${JSON.stringify(logPath)};
    const trustedKeyId = ${JSON.stringify(staticKeyId)};
    const forcedStatus = ${nativeStatus === undefined ? 'null' : Number(nativeStatus)};
    const materializedStoreFiles = ${JSON.stringify(materializedStoreFiles)};
    const args = process.argv.slice(2);
    const encodedCandidate = args[args.length - 1];
    const candidate = decodeURIComponent(encodedCandidate);
    const storeIndex = args.indexOf('--store');
    const store = storeIndex === -1 ? null : args[storeIndex + 1];

    function hashPart(storePath) {
      return path.basename(storePath).slice(0, 32);
    }

    function parseNarinfo(cacheRoot, storePath) {
      const narinfoPath = path.join(cacheRoot, hashPart(storePath) + '.narinfo');
      const fields = {};
      for (const line of fs.readFileSync(narinfoPath, 'utf8').split(/\\r?\\n/)) {
        const separator = line.indexOf(': ');
        if (separator === -1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 2);
        if (key === 'References' || key === 'Sig') {
          fields[key] = value === '' ? [] : value.split(/\\s+/);
        } else {
          fields[key] = value;
        }
      }
      if (fields.StorePath !== storePath || typeof fields.URL !== 'string') {
        throw new Error('materialized narinfo identity mismatch');
      }
      const narPath = path.resolve(cacheRoot, decodeURIComponent(fields.URL));
      const relativeNarPath = path.relative(cacheRoot, narPath);
      if (relativeNarPath === '..' || relativeNarPath.startsWith('..' + path.sep)
        || path.isAbsolute(relativeNarPath)) {
        throw new Error('materialized nar path escaped cache root');
      }
      const content = fs.readFileSync(narPath);
      return {
        narHash: fields.NarHash,
        narSize: fields.NarSize === undefined ? undefined : Number(fields.NarSize),
        references: fields.References ?? [],
        signatures: fields.Sig ?? [],
        deriver: fields.Deriver,
        content,
        materializedMatches: materializedMatches(storePath, content),
      };
    }

    function storePathFromReference(reference) {
      return reference.startsWith('/nix/store/') ? reference : '/nix/store/' + reference;
    }

    function materializedMatches(storePath, content) {
      return Object.fromEntries(Object.entries(materializedStoreFiles).map(([name, files]) => {
        const contentPath = files[storePath];
        if (!contentPath) return [name, false];
        try {
          return [name, fs.readFileSync(contentPath).equals(content)];
        } catch {
          return [name, false];
        }
      }));
    }

    function readClosure(cacheRoot, rootPath) {
      const records = new Map();
      const visit = current => {
        if (records.has(current)) return;
        const record = parseNarinfo(cacheRoot, current);
        records.set(current, record);
        for (const reference of record.references) visit(storePathFromReference(reference));
      };
      visit(rootPath);
      return records;
    }

    function metadataFor(storePath, record) {
      const metadata = {
        narHash: record.narHash,
        narSize: record.narSize,
        references: record.references.map(storePathFromReference).sort(),
        signatures: record.signatures,
      };
      if (record.deriver !== undefined) metadata.deriver = record.deriver;
      return [storePath, metadata];
    }

    try {
      const cacheRoot = store === null ? null : fileURLToPath(store);
      if (cacheRoot === null) throw new Error('native store is missing');
      const records = readClosure(cacheRoot, candidate);
      fs.appendFileSync(logPath, JSON.stringify({
        args,
        env: process.env,
        materializedMatches: Object.fromEntries(
          [...records.entries()].map(([storePath, record]) => [
            storePath,
            record.materializedMatches,
          ]),
        ),
      }) + '\\n');
      if (args[0] === 'path-info') {
        process.stdout.write(JSON.stringify(Object.fromEntries(
          [...records.entries()].map(([storePath, record]) => metadataFor(storePath, record)),
        )));
        process.exit(0);
      }
      if (args[0] === 'store' && args[1] === 'verify') {
        if (forcedStatus !== null) process.exit(forcedStatus);
        let status = 0;
        for (const record of records.values()) {
          if (record.signatures.length === 0
            || record.signatures.some(signature => !signature.startsWith(trustedKeyId + ':'))) {
            status |= 2;
          }
          const contentHash = 'sha256-' + crypto.createHash('sha256')
            .update(record.content).digest('base64');
          if (record.narHash === undefined
            || record.narSize !== record.content.length
            || record.narHash !== contentHash) {
            status |= 1;
          }
        }
        process.exit(status);
      }
      process.exit(0);
    } catch {
      process.exit(4);
    }
  `);
  return {
    executable,
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
  };
}

function createFakeCacheFetcher(fixture, cacheFixture, options = {}) {
  const logPath = path.join(fixture.paths.logs, 'cache-verifier-cache-fetcher.jsonl');
  const entriesByHash = new Map(cacheFixture.narinfos.map(entry => {
    const metadata = nativeMetadata(entry, options.overrides?.[entry.storePath]);
    const narinfo = {
      ...entry,
      ...metadata,
    };
    if (!Object.hasOwn(metadata, 'narHash')) delete narinfo.narHash;
    if (!Object.hasOwn(metadata, 'deriver')) delete narinfo.deriver;
    return [path.basename(entry.storePath).slice(0, 32), narinfo];
  }));
  const contentByHash = new Map(cacheFixture.narContent.map(content => [
    path.basename(content.storePath).slice(0, 32),
    content.data,
  ]));
  const redirectOrigins = options.redirectOrigins ?? {};
  const narUrlOverrides = options.narUrlOverrides ?? {};
  const materializedStoreFiles = Object.fromEntries(
    Object.entries(options.materializedStores ?? {}).map(([name, store]) => [name, store.files]),
  );
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const executable = fixture.createExecutable('cache-verifier-fetcher', `
    const fs = require('node:fs');
    const path = require('node:path');
    const logPath = ${JSON.stringify(logPath)};
    const entries = ${JSON.stringify(Object.fromEntries(entriesByHash))};
    const contents = ${JSON.stringify(Object.fromEntries(contentByHash))};
    const redirectOrigins = ${JSON.stringify(redirectOrigins)};
    const narUrlOverrides = ${JSON.stringify(narUrlOverrides)};
    const materializedStoreFiles = ${JSON.stringify(materializedStoreFiles)};
    const args = process.argv.slice(2);
    const outputIndex = args.indexOf('--output');
    const output = outputIndex === -1 ? null : args[outputIndex + 1];
    const requestedUrl = args.at(-1);
    const requestedPath = new URL(requestedUrl).pathname;
    const isNarinfo = requestedPath.endsWith('.narinfo');
    const isNar = requestedPath.includes('/nar/');
    const kind = isNarinfo ? 'narinfo' : isNar ? 'nar' : null;
    const redirectMatch = /^\\/redirect-(\\d+)(\\/.*)$/.exec(requestedPath);
    const redirectIndex = redirectMatch === null ? 0 : Number(redirectMatch[1]);
    const basePath = redirectMatch === null ? requestedPath : redirectMatch[2];
    const redirectOrigin = kind === null ? null : (redirectOrigins[kind]?.[redirectIndex] ?? null);
    const redirectLocation = redirectOrigin === null
      ? null
      : redirectOrigin + '/redirect-' + (redirectIndex + 1) + basePath;
    const entry = isNarinfo
      ? entries[path.basename(requestedPath, '.narinfo')]
      : null;
    const narEntry = isNar
      ? entries[path.basename(requestedPath, '.nar')]
      : null;

    function materializedMatches(storePath, body) {
      return Object.fromEntries(Object.entries(materializedStoreFiles).map(([name, files]) => {
        const contentPath = storePath === null ? null : files[storePath];
        if (!contentPath) return [name, false];
        try {
          return [name, fs.readFileSync(contentPath).equals(body)];
        } catch {
          return [name, false];
        }
      }));
    }

    const call = {
      args,
      env: process.env,
      materializedStoreFiles,
      materializedMatches: {},
      location: redirectLocation,
      requestedUrl,
      status: redirectLocation === null ? 200 : 302,
    };
    if (isNarinfo && !entry) {
      fs.appendFileSync(logPath, JSON.stringify(call) + '\\n');
      process.exit(22);
    }
    if (redirectLocation !== null) {
      fs.appendFileSync(logPath, JSON.stringify(call) + '\\n');
      process.stdout.write('302\\n' + redirectLocation + '\\n' + requestedUrl + '\\n');
      process.exit(0);
    }
    let body = null;
    if (output && output !== '/dev/null') {
      body = isNarinfo
        ? [
          'StorePath: ' + entry.storePath,
          'URL: ' + (narUrlOverrides[entry.storePath]
            ?? ('nar/' + path.basename(entry.storePath).slice(0, 32) + '.nar')),
          'Compression: none',
          'FileHash: sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
          ...(entry.narHash === undefined ? [] : ['NarHash: ' + entry.narHash]),
          ...(entry.narSize === undefined ? [] : ['NarSize: ' + entry.narSize]),
          'References: ' + entry.references.map(reference => path.basename(reference)).join(' '),
          ...(entry.deriver === null || entry.deriver === undefined
            ? []
            : ['Deriver: ' + entry.deriver]),
          ...entry.signatures.map(signature => 'Sig: ' + signature),
          '',
        ].join('\\n')
        : Buffer.from(contents[path.basename(new URL(requestedUrl).pathname)
          .replace(/\\.nar$/, '')] ?? '', 'base64');
    }
    if (isNar && body !== null) {
      call.materializedMatches = materializedMatches(narEntry?.storePath ?? null, body);
    }
    fs.appendFileSync(logPath, JSON.stringify(call) + '\\n');
    if (body !== null) {
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, body);
    }
    process.stdout.write('200\\n\\n' + requestedUrl + '\\n');
  `);
  return {
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    executable,
  };
}

function makeRequest(cacheFixture, options = {}) {
  const graph = cacheFixture.graph;
  const request = {
    schemaVersion: 1,
    nonce: NONCE,
    topOutput: graph.topOutput,
    candidateRoots: [graph.cacheRoot],
    graph: {
      references: graph.references,
    },
    proxy: {
      endpoint: PROXY_ENDPOINT,
      nonce: NONCE,
    },
  };
  return {
    ...request,
    ...options.request,
  };
}

function runVerifier(executable, fixture, request, options = {}) {
  const result = runExecutable(executable, [], {
    fixture,
    input: `${JSON.stringify(request)}\n`,
    env: {
      AWS_ACCESS_KEY_ID: 'fixture-cache-verifier-aws-key',
      HTTPS_PROXY: 'fixture-poisoned-proxy',
      NIX_CONFIG: 'experimental-features = poisoned-feature',
      POST_BUILD_HOOK: 'fixture-poisoned-hook',
      SSH_AUTH_SOCK: 'fixture-poisoned-agent',
      ...options.env,
    },
    timeout: 120_000,
  });
  return {
    ...result,
    output: result.stdout === '' ? null : JSON.parse(result.stdout),
  };
}

function setup(name, options = {}) {
  const { cacheFixture: cacheFixtureOverride, ...verifierOptions } = options;
  const fixture = createRemoteBuilderFixture();
  const cacheFixture = cacheFixtureOverride ?? getPublicCacheFixture(name);
  const materializedStores = Object.fromEntries(
    Object.entries({
      normal: verifierOptions.normalStore,
      attic: verifierOptions.atticStore,
    })
      .filter(([, store]) => store !== undefined)
      .map(([storeName, store]) => [
        storeName,
        materializeStoreFixture(fixture, storeName, store),
      ]),
  );
  const fakeOptions = { ...verifierOptions, materializedStores };
  const native = createFakeNativeVerifier(fixture, cacheFixture, fakeOptions);
  const fetcher = createFakeCacheFetcher(fixture, cacheFixture, fakeOptions);
  const verifier = loadVerifier(fixture, native.executable, {
    ...verifierOptions,
    curlExecutable: fetcher.executable,
  });
  return {
    cacheFixture,
    fixture,
    fetcher,
    native,
    verifier,
  };
}

test('cache verifier leaves a valid candidate in traversal when its NAR redirects off-origin', () => {
  const fixtureSetup = setup('public', {
    redirectOrigins: {
      nar: ['https://attic.shopify.invalid'],
    },
  });
  try {
    const result = runVerifier(
      fixtureSetup.verifier,
      fixtureSetup.fixture,
      makeRequest(fixtureSetup.cacheFixture),
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'traverse', JSON.stringify(result.output));
    assert.deepEqual(result.output.publicCacheCuts, []);
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === fixtureSetup.cacheFixture.rootPath)?.reason,
      'redirect origin mismatch',
    );
    assert.equal(fixtureSetup.native.calls().length, 0);
    assert.ok(fixtureSetup.fetcher.calls().some(call => call.requestedUrl.includes('/nar/')));
  } finally {
    fixtureSetup.fixture.cleanup();
  }
});

test('cache verifier follows approved redirect chains with hermetic curl configuration', () => {
  const fixtureSetup = setup('public', {
    redirectOrigins: {
      narinfo: ['https://cache.nixos.org'],
      nar: ['https://cache.nixos.org', 'https://cache.nixos.org'],
    },
  });
  try {
    const poisonedCurlHome = path.join(fixtureSetup.fixture.root, 'poisoned-curl-home');
    const poisonedConfigHome = path.join(fixtureSetup.fixture.root, 'poisoned-config-home');
    fs.mkdirSync(poisonedCurlHome, { recursive: true, mode: 0o700 });
    fs.mkdirSync(poisonedConfigHome, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(poisonedCurlHome, '.curlrc'),
      `url = https://fixture-poisoned.example.invalid/extra\nheader = X-Fixture-Poison: yes\n`,
      { mode: 0o600 },
    );
    fs.writeFileSync(
      path.join(poisonedConfigHome, 'curlrc'),
      `url = https://fixture-poisoned.example.invalid/config\n`,
      { mode: 0o600 },
    );
    const result = runVerifier(
      fixtureSetup.verifier,
      fixtureSetup.fixture,
      makeRequest(fixtureSetup.cacheFixture),
      {
        env: {
          CURL_HOME: poisonedCurlHome,
          XDG_CONFIG_HOME: poisonedConfigHome,
        },
      },
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(
      result.output.decision,
      'cut',
      JSON.stringify(result.output),
    );
    assert.deepEqual(result.output.traversal, []);
    const fetchCalls = fixtureSetup.fetcher.calls();
    assert.ok(fetchCalls.some(call => call.status === 302 && call.location !== null));
    assert.ok(fetchCalls.some(call => call.status === 200 && call.requestedUrl.includes('/nar/')));
    for (const call of fetchCalls) {
      assert.equal(call.args[0], '--disable');
      assert.equal(call.args.includes('https://fixture-poisoned.example.invalid/extra'), false);
      assert.equal(call.args.includes('https://fixture-poisoned.example.invalid/config'), false);
      assert.equal(pathIsContained(call.env.TMPDIR, call.env.CURL_HOME), true);
      assert.equal(pathIsContained(call.env.TMPDIR, call.env.XDG_CONFIG_HOME), true);
      assert.equal(call.env.HTTPS_PROXY, PROXY_ENDPOINT);
      assert.equal(call.env.AWS_ACCESS_KEY_ID, undefined);
    }
  } finally {
    fixtureSetup.fixture.cleanup();
  }
});

test('cache verifier rejects encoded traversal before creating a native file cache', () => {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  for (const narUrl of [
    'nar/%2e%2e/escape.nar',
    'nar/%2E%2E/%2fescape.nar',
    'nar/../escape.nar',
  ]) {
    const fixtureSetup = setup('public', {
      narUrlOverrides: { [rootPath]: narUrl },
    });
    try {
      const result = runVerifier(
        fixtureSetup.verifier,
        fixtureSetup.fixture,
        makeRequest(fixtureSetup.cacheFixture),
      );

      assert.equal(result.status, 0, `${narUrl}: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.output.decision, 'traverse', narUrl);
      assert.equal(
        result.output.traversal.find(entry => entry.rootPath === rootPath)?.reason,
        'metadata malformed',
        narUrl,
      );
      assert.equal(
        result.output.publicCacheCuts.some(cut => cut.rootPath === rootPath),
        false,
        narUrl,
      );
      assert.equal(
        fixtureSetup.native.calls().some(call => call.args.at(-1) === rootPath),
        false,
        narUrl,
      );
      assert.equal(
        fixtureSetup.fetcher.calls().some(call => call.requestedUrl.includes(
          `/nar/${path.basename(rootPath).slice(0, 32)}.nar`,
        )),
        false,
        narUrl,
      );
    } finally {
      fixtureSetup.fixture.cleanup();
    }
  }
});

test('cache verifier emits a complete cut through the native verifier seam', () => {
  const { cacheFixture, fetcher, fixture, native, verifier } = setup('public');
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(
      result.output.decision,
      'cut',
      JSON.stringify(result.output),
    );
    assert.deepEqual(result.output.traversal, []);
    assert.deepEqual(result.output.publicCacheCuts, [{
      rootPath: cacheFixture.rootPath,
      closure: cacheFixture.referenceClosure,
      closureDigest: cacheFixture.closureDigest,
      endpoint: PUBLIC_ENDPOINT,
      signingKeyId: cacheFixture.trustedKeyId,
      narinfos: cacheFixture.narinfos.map(entry => attestedMetadata(entry)),
    }]);
    assert.ok(fetcher.calls().length > 0);
    assert.equal(fetcher.calls().every(call => call.requestedUrl.startsWith(`${PUBLIC_ENDPOINT}/`)), true);

    const calls = native.calls();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map(call => call.args[0]).sort(), ['path-info', 'store']);
    for (const call of calls) {
      assert.equal(call.args.at(-1), cacheFixture.rootPath);
      assert.match(call.args[call.args.indexOf('--store') + 1], /^file:\/\//);
      assert.equal(call.env.ALL_PROXY, PROXY_ENDPOINT);
      assert.equal(call.env.HTTPS_PROXY, PROXY_ENDPOINT);
      assert.equal(call.env.HTTP_PROXY, PROXY_ENDPOINT);
      assert.equal(call.env.AWS_ACCESS_KEY_ID, undefined);
      assert.equal(call.env.POST_BUILD_HOOK, undefined);
      assert.equal(call.env.SSH_AUTH_SOCK, undefined);
      assert.equal(call.env.NIX_USER_CONF_FILES, '/dev/null');
      assert.equal(call.env._NIX_FORCE_HTTP, '1');
      assert.equal(pathIsContained(call.env.TMPDIR, call.env.HOME), true, JSON.stringify(call.env));
      assert.equal(pathIsContained(call.env.TMPDIR, call.env.NIX_CONF_DIR), true);
      assert.match(call.env.NIX_CONFIG, /substituters = file:\/\//);
      assert.match(call.env.NIX_CONFIG, /trusted-public-keys = cache\.nixos\.org-1:/);
    }
    assert.equal(calls.some(call => call.args.at(-1) === cacheFixture.graph.topOutput), false);
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier preserves native multi-reference closure metadata', () => {
  const cacheFixture = createMultiReferenceCacheFixture();
  const { fixture, verifier } = setup('public', { cacheFixture });
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'cut', JSON.stringify(result.output));
    assert.deepEqual(result.output.traversal, []);
    assert.deepEqual(result.output.publicCacheCuts[0].closure, cacheFixture.referenceClosure);
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier accepts native self-references but rejects distinct cycles and invalid references', () => {
  const selfReferenceFixture = createSelfReferenceCacheFixture();
  const selfSetup = setup('public', { cacheFixture: selfReferenceFixture });
  try {
    const result = runVerifier(
      selfSetup.verifier,
      selfSetup.fixture,
      makeRequest(selfReferenceFixture),
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'cut', JSON.stringify(result.output));
    assert.deepEqual(result.output.publicCacheCuts[0].closure, selfReferenceFixture.referenceClosure);
    assert.deepEqual(
      result.output.publicCacheCuts[0].narinfos.find(
        entry => entry.storePath === selfReferenceFixture.rootPath,
      ).references,
      selfReferenceFixture.graph.references[selfReferenceFixture.rootPath],
    );
  } finally {
    selfSetup.fixture.cleanup();
  }

  for (const cacheFixture of [
    createCyclicReferenceCacheFixture(),
    createInvalidReferenceCacheFixture(),
  ]) {
    const invalidSetup = setup('public', { cacheFixture });
    try {
      const result = runVerifier(invalidSetup.verifier, invalidSetup.fixture, makeRequest(cacheFixture));

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.decision, 'ineligible', JSON.stringify(result.output));
      assert.equal(result.output.reason, 'schema drift');
      assert.equal(invalidSetup.native.calls().length, 0);
    } finally {
      invalidSetup.fixture.cleanup();
    }
  }
});

test('cache verifier URL-encodes special store-name characters for native cache queries', () => {
  const cacheFixture = createSpecialCharacterCacheFixture();
  const { fixture, native, verifier } = setup('public', { cacheFixture });
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'cut', JSON.stringify(result.output));
    const encodedRootPath = cacheFixture.rootPath.replace('?', '%3F');
    assert.ok(native.calls().some(call => call.args.at(-1) === encodedRootPath));
    assert.equal(native.calls().some(call => call.args.at(-1).includes('?remote')), false);
    assert.equal(native.calls().every(call => (
      call.args[call.args.indexOf('--store') + 1].startsWith('file://')
    )), true);
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier keeps decoded native file URIs under its validator root with hostile TMPDIR components', () => {
  const { cacheFixture, fixture, native, verifier } = setup('public');
  const hostileTmpdir = path.join(fixture.root, '%2e%2e', 'tmp with ? and #');
  fs.mkdirSync(hostileTmpdir, { recursive: true, mode: 0o700 });
  try {
    const result = runVerifier(
      verifier,
      fixture,
      makeRequest(cacheFixture),
      { env: { TMPDIR: hostileTmpdir } },
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'cut', JSON.stringify(result.output));
    const calls = native.calls();
    assert.equal(calls.length, 2);
    const validationRoots = new Set(calls.map(call => path.dirname(call.env.HOME)));
    assert.equal(validationRoots.size, 1);
    const [validationRoot] = validationRoots;
    assert.notEqual(validationRoot, fs.realpathSync(hostileTmpdir));
    assert.equal(validationRoot.includes('%2e%2e'), false);

    for (const call of calls) {
      const nativeStoreUri = call.args[call.args.indexOf('--store') + 1];
      const nativeStorePath = fileURLToPath(nativeStoreUri);
      assert.equal(pathIsContained(validationRoot, nativeStorePath), true);
      const substituterLine = call.env.NIX_CONFIG.split('\n')
        .find(line => line.startsWith('substituters = '));
      assert.ok(substituterLine);
      const substituterPath = fileURLToPath(substituterLine.slice('substituters = '.length));
      assert.equal(pathIsContained(validationRoot, substituterPath), true);
      assert.equal(substituterLine.includes('%2e%2e'), false);
      assert.equal(substituterLine.includes('tmp with ? and #'), false);
      assert.equal(call.env.TMPDIR, validationRoot);
    }
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier ignores same-path normal-store and Attic contamination', () => {
  const {
    atticStore,
    cacheFixture,
    contaminatedPath,
    normalStore,
  } = createSamePathContaminationFixture();
  const { fetcher, fixture, native, verifier } = setup('content-mismatch', {
    atticStore,
    cacheFixture,
    normalStore,
  });
  try {
    const localContaminatedContent = normalStore.narContent.find(
      content => content.storePath === contaminatedPath,
    );
    const cacheContaminatedContent = cacheFixture.narContent.find(
      content => content.storePath === contaminatedPath,
    );
    assert.deepEqual(localContaminatedContent, atticStore.narContent.find(
      content => content.storePath === contaminatedPath,
    ));
    assert.notDeepEqual(localContaminatedContent, cacheContaminatedContent);

    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'traverse', JSON.stringify(result.output));
    assert.deepEqual(result.output.publicCacheCuts, []);
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === cacheFixture.rootPath)?.reason,
      'NAR content mismatch',
    );
    const nativeMatches = native.calls()
      .flatMap(call => Object.entries(call.materializedMatches ?? {}))
      .filter(([storePath]) => storePath === contaminatedPath)
      .map(([, matches]) => matches);
    assert.ok(nativeMatches.length > 0);
    assert.equal(nativeMatches.every(matches => matches.normal === false), true);
    assert.equal(nativeMatches.every(matches => matches.attic === false), true);
    const contaminatedHash = path.basename(contaminatedPath).slice(0, 32);
    const fetchedContaminatedMatches = fetcher.calls()
      .filter(call => call.requestedUrl.endsWith(`/nar/${contaminatedHash}.nar`))
      .map(call => call.materializedMatches);
    assert.ok(fetchedContaminatedMatches.length > 0);
    assert.equal(fetchedContaminatedMatches.every(matches => matches.normal === false), true);
    assert.equal(fetchedContaminatedMatches.every(matches => matches.attic === false), true);
    assert.equal(native.calls().every(call => (
      call.args[call.args.indexOf('--store') + 1].startsWith('file://')
    )), true);
    assert.doesNotMatch(JSON.stringify(native.calls()), /daemon|attic\.shopify/);
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier treats native Deriver as non-authoritative', () => {
  const cacheFixture = getPublicCacheFixture('public');
  const rootPath = cacheFixture.rootPath;
  const cases = [
    ['omitted', { omitDeriver: true }],
    ['null', { deriver: null }],
    ['forged', {
      deriver: '/nix/store/99999999999999999999999999999999-forged-deriver.drv',
    }],
  ];

  for (const [name, override] of cases) {
    const { fixture, verifier } = setup('public', {
      overrides: { [rootPath]: override },
    });
    try {
      const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

      assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.output.decision, 'cut', name);
      const rootNarinfo = result.output.publicCacheCuts[0].narinfos.find(
        entry => entry.storePath === rootPath,
      );
      assert.equal(Object.hasOwn(rootNarinfo, 'deriver'), false, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('cache verifier keeps partial, unsigned, and mismatching content in traversal but ignores cache age', () => {
  for (const name of ['partial', 'unsigned', 'stale', 'content-mismatch']) {
    const { cacheFixture, fixture, verifier } = setup(name);
    try {
      const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

      assert.equal(result.status, 0, `${name}: ${result.stderr}\n${result.stdout}`);
      if (name === 'stale') {
        assert.equal(result.output.decision, 'cut', name);
        assert.deepEqual(result.output.traversal, [], name);
      } else {
        assert.equal(result.output.decision, 'traverse', name);
        assert.deepEqual(result.output.publicCacheCuts, [], name);
        assert.ok(
          result.output.traversal.some(entry => entry.rootPath === cacheFixture.rootPath),
          `${name}: root must remain in traversal`,
        );
      }
    } finally {
      fixture.cleanup();
    }
  }
});

test('cache verifier rejects wrong narinfo signatures, references, sizes, and hashes', () => {
  const publicFixture = getPublicCacheFixture('public');
  const rootPath = publicFixture.rootPath;
  const cases = [
    {
      name: 'wrong signature key',
      overrides: {
        [rootPath]: { signatures: ['not-approved-key:fixture-signature'] },
      },
      reason: 'signature mismatch',
    },
    {
      name: 'wrong references',
      overrides: {
        [rootPath]: { references: [] },
      },
      reason: 'incomplete reference closure',
    },
    {
      name: 'wrong size',
      overrides: {
        [rootPath]: { narSize: publicFixture.narinfos[0].narSize + 1 },
      },
      reason: 'NAR content mismatch',
    },
    {
      name: 'wrong hash',
      overrides: {
        [rootPath]: { narHash: 'sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' },
      },
      reason: 'NAR content mismatch',
    },
    {
      name: 'missing hash',
      overrides: {
        [rootPath]: { omitNarHash: true },
      },
      nativeStatus: 0,
      reason: 'metadata missing',
    },
  ];

  for (const testCase of cases) {
    const { cacheFixture, fixture, verifier } = setup('public', testCase);
    try {
      const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

      assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}\n${result.stdout}`);
      assert.equal(result.output.decision, 'traverse', testCase.name);
      assert.equal(
        result.output.publicCacheCuts.some(cut => cut.rootPath === rootPath),
        false,
        testCase.name,
      );
      assert.equal(
        result.output.traversal.find(entry => entry.rootPath === cacheFixture.rootPath)?.reason,
        testCase.reason,
        testCase.name,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('cache verifier does not trust non-static signing keys', () => {
  const baseFixture = getPublicCacheFixture('public');
  const forgedKeyId = 'forged-cache-1';
  const forgedSignature = `${forgedKeyId}:fixture-forged-signature`;
  const overrides = Object.fromEntries(baseFixture.narinfos.map(entry => [
    entry.storePath,
    { signatures: [forgedSignature] },
  ]));
  const { cacheFixture, fixture, native, verifier } = setup('public', { overrides });
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.equal(result.output.decision, 'traverse', JSON.stringify(result.output));
    assert.equal(result.output.reason, 'incomplete cache coverage');
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === cacheFixture.rootPath)?.reason,
      'signature mismatch',
    );
    assert.deepEqual(result.output.publicCacheCuts, []);
    assert.ok(native.calls().length > 0);
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier rejects top-output and private Attic or Shopify endpoints', () => {
  const publicSetup = setup('public');
  try {
    const { cacheFixture, fixture, native, verifier } = publicSetup;
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture, {
      request: {
        candidateRoots: [cacheFixture.graph.topOutput, cacheFixture.rootPath],
      },
    }));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'traverse');
    assert.equal(result.output.publicCacheCuts.length, 1);
    assert.equal(result.output.publicCacheCuts[0].rootPath, cacheFixture.rootPath);
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === cacheFixture.graph.topOutput)?.reason,
      'top output',
    );
    assert.equal(
      native.calls().some(call => call.args.at(-1) === cacheFixture.graph.topOutput),
      false,
    );
  } finally {
    publicSetup.fixture.cleanup();
  }

  for (const endpoint of ['https://attic.shopify.invalid', 'https://cache.shopify.invalid']) {
    const privateSetup = setup('public', {
      redirectOrigins: {
        nar: [endpoint],
      },
    });
    try {
      const result = runVerifier(
        privateSetup.verifier,
        privateSetup.fixture,
        makeRequest(privateSetup.cacheFixture),
      );

      assert.equal(result.status, 0, endpoint);
      assert.equal(result.output.decision, 'traverse', endpoint);
      assert.equal(
        result.output.traversal.find(entry => entry.rootPath === privateSetup.cacheFixture.rootPath)?.reason,
        'redirect origin mismatch',
        endpoint,
      );
      assert.equal(privateSetup.native.calls().length, 0, endpoint);
      assert.ok(privateSetup.fetcher.calls().some(call => call.location?.startsWith(endpoint)), endpoint);
    } finally {
      privateSetup.fixture.cleanup();
    }
  }

  const staticPrivateSetup = setup('private', {
    approvedCacheConfigurations: [{
      endpoint: 'https://attic.shopify.invalid',
      trustedKeys: [PUBLIC_TRUSTED_KEY],
    }],
  });
  try {
    const result = runVerifier(
      staticPrivateSetup.verifier,
      staticPrivateSetup.fixture,
      makeRequest(staticPrivateSetup.cacheFixture),
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'traverse', JSON.stringify(result.output));
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === staticPrivateSetup.cacheFixture.rootPath)?.reason,
      'signature mismatch',
    );
    assert.ok(staticPrivateSetup.fetcher.calls().every(call => (
      call.requestedUrl.startsWith('https://attic.shopify.invalid/')
    )));
  } finally {
    staticPrivateSetup.fixture.cleanup();
  }
});

test('cache verifier can cut a complete descendant while its parent remains unresolved', () => {
  const publicFixture = getPublicCacheFixture('public');
  const rootPath = publicFixture.rootPath;
  const setupOptions = {
    overrides: {
      [rootPath]: { signatures: ['not-approved-key:fixture-signature'] },
    },
  };
  const { cacheFixture, fixture, verifier } = setup('public', setupOptions);
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'traverse');
    assert.deepEqual(result.output.publicCacheCuts.map(cut => cut.rootPath), [
      '/nix/store/ffffffffffffffffffffffffffffffff-shopify-remote-source',
    ]);
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === rootPath)?.reason,
      'signature mismatch',
    );
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier rejects a candidate closure containing the top output', () => {
  const { cacheFixture, extraPath } = createTopOutputClosureCacheFixture();
  const { fixture, verifier } = setup('public', { cacheFixture });
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture, {
      request: {
        candidateRoots: [cacheFixture.graph.cacheRoot, extraPath].sort(),
      },
    }));

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.notEqual(result.output.decision, 'cut', JSON.stringify(result.output));
    assert.equal(
      result.output.publicCacheCuts.some(cut => cut.rootPath === extraPath),
      false,
    );
    assert.equal(
      result.output.publicCacheCuts.some(cut => cut.closure.includes(cacheFixture.graph.topOutput)),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test('cache verifier keeps a candidate in traversal when native verification is unavailable', () => {
  const { cacheFixture, fixture, verifier } = setup('public', { nativeStatus: 4 });
  try {
    const result = runVerifier(verifier, fixture, makeRequest(cacheFixture));

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'traverse');
    assert.deepEqual(result.output.publicCacheCuts, []);
    assert.equal(
      result.output.traversal.find(entry => entry.rootPath === cacheFixture.rootPath)?.reason,
      'narinfo unavailable',
    );
  } finally {
    fixture.cleanup();
  }
});
