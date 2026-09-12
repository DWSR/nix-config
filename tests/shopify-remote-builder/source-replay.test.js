'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  nixEnvironment,
  repoRoot,
  runExecutable,
} = require('./helpers');

const CLASSIFIER_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-source-classifier.nix',
);
const REPLAY_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-source-replay.nix',
);
const HASH = 'sha256-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq=';
const OTHER_HASH = 'sha256-rrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr=';
const NIX32_HASH = '1amamamamamamamamamamamamamamamamamamamamamamamamama';
const OTHER_NIX32_HASH = '1fmfxfxaxsxsmvmvmbpbpapfpfmfxfxaxsxsmvmvmbpbpapfpfmf';
const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EXPECTED_PATH = '/nix/store/eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-fixture-replay-source';

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
    if (result.error) {
      throw result.error;
    }
    process.exit(result.status ?? 1);
  `);
}

function loadClassifier(fixture) {
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in (pkgs.callPackage ${nixString(CLASSIFIER_PATH)} {}).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-source-classifier');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture, 'nix-source-replay-classifier-read-only'),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function loadReplay(fixture, classifierExecutable, options = {}) {
  const pinnedCaBundle = options.pinnedCaBundle
    ?? fs.realpathSync(path.join(fixture.paths.control, 'pinned-ca-bundle.pem'));
  const pinnedCaBundleSha256 = options.pinnedCaBundleSha256
    ?? crypto.createHash('sha256').update(fs.readFileSync(pinnedCaBundle)).digest('hex');
  const packageArguments = Object.entries({
    commandTimeoutSeconds: options.commandTimeoutSeconds,
    commandKillAfterSeconds: options.commandKillAfterSeconds,
    classifierTimeoutSeconds: options.classifierTimeoutSeconds,
    maxCommandOutputBytes: options.maxCommandOutputBytes,
    maxWorkspaceBytes: options.maxWorkspaceBytes,
    pinnedCaBundle,
    pinnedCaBundleSha256,
    policyProxyPort: options.policyProxyPort,
    nixExecutable: options.nixExecutable ?? fixture.controls.nix.executable,
    classifierExecutable,
    curlExecutable: '/nix/store/11111111111111111111111111111111-curl/bin/curl',
    gitExecutable: '/nix/store/22222222222222222222222222222222-git/bin/git',
    tarExecutable: '/nix/store/33333333333333333333333333333333-tar/bin/tar',
    unzipExecutable: '/nix/store/44444444444444444444444444444444-unzip/bin/unzip',
  })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => typeof value === 'number'
      ? `${name} = ${Number(value)};`
      : `${name} = ${nixString(value)};`)
    .join('\n        ');
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ${nixString(REPLAY_PATH)} {
        ${packageArguments}
      }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-source-replay');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture, 'nix-source-replay-builder-read-only'),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function buildReplayPackage(fixture) {
  const pinnedCaBundle = fs.realpathSync(path.join(fixture.paths.control, 'pinned-ca-bundle.pem'));
  const pinnedCaBundleSha256 = crypto
    .createHash('sha256')
    .update(fs.readFileSync(pinnedCaBundle))
    .digest('hex');
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in pkgs.callPackage ${nixString(REPLAY_PATH)} {
      pinnedCaBundle = ${nixString(pinnedCaBundle)};
      pinnedCaBundleSha256 = ${nixString(pinnedCaBundleSha256)};
    }
  `;
  return childProcess.spawnSync(
    'nix',
    [
      'build',
      '--impure',
      '--no-link',
      '--expr',
      expression,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...(() => {
          const environment = nixEnvironment({ fixture });
          delete environment.NIX_CACHE_DIR;
          delete environment.NIX_LOG_DIR;
          delete environment.NIX_STATE_DIR;
          environment.NIX_REMOTE = 'daemon';
          return environment;
        })(),
      },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 120_000,
    },
  );
}

function fetchurlProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    builder: 'fetchurl',
    urls: ['https://downloads.example.test/source.tar.gz'],
    hash: HASH,
    hashMode: 'flat',
    options: {},
    ...overrides,
  };
}

function fetchzipProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    builder: 'fetchzip',
    urls: ['https://downloads.example.test/source.zip'],
    hash: HASH,
    hashMode: 'recursive',
    options: { stripRoot: true },
    ...overrides,
  };
}

function fetchgitProfile(overrides = {}) {
  return {
    schemaVersion: 1,
    builder: 'fetchgit',
    urls: ['https://github.com/NixOS/nixpkgs.git'],
    hash: HASH,
    hashMode: 'recursive',
    revision: REVISION,
    options: {
      submodules: false,
      lfs: false,
      tags: false,
      mirrors: [],
      hooks: [],
      gitConfig: null,
      curlOpts: [],
    },
    ...overrides,
  };
}

function makeRequest(profile, fixture, overrides = {}) {
  const caBundlePath = path.join(fixture.paths.control, 'pinned-ca-bundle.pem');
  fs.writeFileSync(caBundlePath, 'fixture pinned CA bundle\n', { mode: 0o400 });
  const caBundle = fs.realpathSync(caBundlePath);
  const request = {
    schemaVersion: 1,
    nonce: 'fixture-source-replay-nonce-0001',
    system: 'aarch64-darwin',
    source: profile,
    expected: {
      path: EXPECTED_PATH,
      hash: HASH,
    },
    proxy: {
      endpoint: 'socks5h://127.0.0.1:1080',
      nonce: 'fixture-source-replay-nonce-0001',
    },
    ...overrides,
  };
  Object.defineProperty(request, 'caBundle', {
    configurable: true,
    enumerable: false,
    value: caBundle,
  });
  return request;
}

function createReplayNix(fixture, request, options = {}) {
  const logPath = path.join(fixture.paths.logs, 'source-replay-nix.jsonl');
  const statePath = path.join(fixture.paths.control, 'source-replay-nix-state.json');
  const childPidPath = path.join(fixture.paths.logs, 'source-replay-child.pid');
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  fs.writeFileSync(statePath, JSON.stringify({ pathInfoCalls: 0 }) + '\n', { mode: 0o600 });
  const executable = fixture.createExecutable('source-replay-nix', `
    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const path = require('node:path');
    const args = process.argv.slice(2);
    const logPath = ${JSON.stringify(logPath)};
    const statePath = ${JSON.stringify(statePath)};
    const childPidPath = ${JSON.stringify(childPidPath)};
    const expectedPath = ${JSON.stringify(request.expected.path)};
    const sourceHash = ${JSON.stringify(request.source.hash)};
    const delaySeconds = ${JSON.stringify(options.delaySeconds ?? 0)};
    const config = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    fs.appendFileSync(logPath, JSON.stringify({ args, env: process.env }) + '\\n');
    const command = args[0];
    if (delaySeconds > 0) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delaySeconds * 1000);
    }
    if (command === 'hash') {
      if (args.length !== 7
        || args[1] !== 'convert'
        || args[2] !== '--from'
        || args[3] !== 'sri'
        || args[4] !== '--to'
        || args[5] !== 'nix32'
        || args[6] !== sourceHash) {
        process.stderr.write('unsupported hash argument\\n');
        process.exit(64);
      }
      const convertedHash = sourceHash === ${JSON.stringify(HASH)}
        ? ${JSON.stringify(NIX32_HASH)}
        : sourceHash === ${JSON.stringify(OTHER_HASH)}
          ? ${JSON.stringify(OTHER_NIX32_HASH)}
          : ${JSON.stringify(options.convertedHash ?? NIX32_HASH)};
      process.stdout.write(convertedHash + '\\n');
      process.exit(${Number(options.hashConvertStatus ?? 0)});
    }
    if (command === 'path-info') {
      const firstProbe = config.pathInfoCalls === 0;
      config.pathInfoCalls += 1;
      fs.writeFileSync(statePath, JSON.stringify(config) + '\\n');
      if (${JSON.stringify(options.present !== true)} && firstProbe) {
        process.exit(1);
      }
      const observedPath = ${JSON.stringify(options.observedPath ?? request.expected.path)};
      const observedHash = ${JSON.stringify(
        options.observedNarHash
          ?? options.observedHash
          ?? (request.source.hashMode === 'flat' ? OTHER_HASH : request.expected.hash),
      )};
      const observedCa = ${JSON.stringify(
        options.observedCa
          ?? (request.source.hashMode === 'flat'
            ? `fixed:sha256:${NIX32_HASH}`
            : `fixed:r:sha256:${NIX32_HASH}`),
      )};
      const metadata = {
        path: observedPath,
        narHash: observedHash,
      };
      if (!${JSON.stringify(options.omitCa === true)}) {
        metadata.ca = observedCa;
      }
      process.stdout.write(JSON.stringify({
        [observedPath]: metadata,
      }));
      process.exit(0);
    }
    if (command === 'build') {
      const optionNames = new Set([
        'sandbox',
        'substitute',
        'builders',
        'substituters',
        'extra-substituters',
        'trusted-substituters',
        'post-build-hook',
        'plugin-files',
        'access-tokens',
        'netrc-file',
        'flake-registry',
        'impure-envs',
        'max-build-log-size',
        'build-dir',
        'http-proxy',
        'ssl-cert-file',
      ]);
      const invalidArguments = [];
      for (let index = 1; index < args.length;) {
        if (args[index] === '--store' || args[index] === '--expr') {
          index += 2;
        } else if (args[index] === '--option') {
          if (!optionNames.has(args[index + 1])) {
            invalidArguments.push(args[index + 1] ?? args[index]);
          }
          index += 3;
        } else if (args[index] === '--no-link' || args[index] === '--refresh' || args[index] === '--rebuild') {
          index += 1;
        } else {
          invalidArguments.push(args[index]);
          index += 1;
        }
      }
      if (invalidArguments.length > 0) {
        process.stderr.write('unsupported build argument\\n');
        process.exit(64);
      }
      const isRebuild = args.includes('--rebuild');
      if (isRebuild && ${JSON.stringify(options.output !== undefined)}) {
        process.stdout.write(${JSON.stringify(options.output?.stdout ?? '')});
        process.stderr.write(${JSON.stringify(options.output?.stderr ?? '')});
      }
      if (isRebuild && ${JSON.stringify(options.workspaceOutputBytes ?? null)} !== null) {
        const buildDir = args[args.indexOf('build-dir') + 1];
        fs.mkdirSync(buildDir, { recursive: true });
        fs.writeFileSync(
          path.join(buildDir, 'fixture-workspace-overflow'),
          'w'.repeat(${JSON.stringify(options.workspaceOutputBytes ?? null)}),
        );
      }
      if (isRebuild && ${JSON.stringify(options.storeOutputBytes ?? null)} !== null) {
        const storeArgument = args[args.indexOf('--store') + 1] ?? '';
        const storeRoot = storeArgument.startsWith('local?root=')
          ? storeArgument.slice('local?root='.length)
          : ${JSON.stringify(path.join(fixture.paths.state, 'fallback-store'))};
        fs.mkdirSync(storeRoot, { recursive: true });
        fs.writeFileSync(
          path.join(storeRoot, 'fixture-store-overflow'),
          's'.repeat(${JSON.stringify(options.storeOutputBytes ?? null)}),
        );
      }
      const status = isRebuild
        ? ${Number(options.checkStatus ?? 0)}
        : ${Number(options.normalStatus ?? 0)};
      if (isRebuild && ${JSON.stringify(options.hangOnCheck === true || options.hangOnOutput === true)}) {
        const child = childProcess.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
          stdio: 'ignore',
        });
        fs.writeFileSync(childPidPath, String(child.pid) + '\\n', { mode: 0o600 });
        setInterval(() => {}, 1000);
      } else {
        process.exit(status);
      }
    }
    process.exit(99);
  `);
  return {
    executable,
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    childPidPath,
  };
}

function runReplay(executable, fixture, request, options = {}) {
  const result = runExecutable(executable, [], {
    fixture,
    input: `${JSON.stringify(request)}\n`,
    env: {
      AWS_ACCESS_KEY_ID: 'fixture-replay-aws-key',
      HTTPS_PROXY: 'fixture-poisoned-proxy',
      NIX_CONFIG: 'experimental-features = poisoned-feature',
      POST_BUILD_HOOK: 'fixture-poisoned-hook',
      SSH_AUTH_SOCK: 'fixture-poisoned-agent',
    },
    timeout: options.timeout ?? 360_000,
  });
  return {
    ...result,
    output: result.stdout === '' ? null : JSON.parse(result.stdout),
  };
}

function optionMap(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--option') {
      values.set(args[index + 1], args[index + 2]);
      index += 2;
    }
  }
  return values;
}

function assertSafeReplayCommand(call, request, {
  check,
  maxCommandOutputBytes = 64 * 1024,
}) {
  assert.equal(call.args[0], 'build');
  assert.ok(call.args.includes('--store'));
  const storeArgumentIndex = call.args.indexOf('--store');
  const expectedStore = `local?root=${path.dirname(call.env.TMPDIR)}.store`;
  assert.equal(call.args[storeArgumentIndex + 1], expectedStore);
  assert.ok(call.args.includes('--no-link'));
  assert.ok(call.args.includes('--expr'));
  assert.ok(call.args.includes('--refresh'));
  if (check) {
    assert.ok(call.args.includes('--rebuild'));
    assert.equal(call.args.includes('--check'), false);
  } else {
    assert.equal(call.args.includes('--check'), false);
    assert.equal(call.args.includes('--rebuild'), false);
  }

  const options = optionMap(call.args);
  for (const [key, value] of [
    ['sandbox', 'true'],
    ['builders', ''],
    ['substituters', ''],
    ['extra-substituters', ''],
    ['trusted-substituters', ''],
    ['substitute', 'false'],
    ['post-build-hook', ''],
    ['ssl-cert-file', request.caBundle],
    ['http-proxy', request.proxy.endpoint],
    ['max-build-log-size', String(maxCommandOutputBytes)],
  ]) {
    assert.equal(options.get(key), value, `${key} must be explicit`);
  }
  const buildDir = options.get('build-dir');
  assert.ok(buildDir?.startsWith(path.dirname(call.env.TMPDIR)), 'build workspace must be isolated');
  assert.match(call.args[call.args.indexOf('--expr') + 1], /builtins\.derivation/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], /impureEnvVars/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], /REPLAY_PROXY/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], /REPLAY_CA_BUNDLE/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], /name = "fixture-replay-source";/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], /outputHash = "sha256-/);
  assert.match(call.args[call.args.indexOf('--expr') + 1], new RegExp(request.expected.hash));
  assert.equal(call.env.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(call.env.POST_BUILD_HOOK, undefined);
  assert.equal(call.env.SSH_AUTH_SOCK, undefined);
  assert.equal(call.env.ALL_PROXY, request.proxy.endpoint);
  assert.equal(call.env.HTTP_PROXY, request.proxy.endpoint);
  assert.equal(call.env.HTTPS_PROXY, request.proxy.endpoint);
  assert.equal(call.env.SSL_CERT_FILE, request.caBundle);
  assert.match(call.env.NIX_CONFIG, /substituters\s*=\s*$/m);
  assert.match(call.env.NIX_CONFIG, /builders\s*=\s*$/m);
  assert.match(call.env.NIX_CONFIG, /post-build-hook\s*=\s*$/m);
}

function assertProfileReplayExpression(call, profile) {
  const expression = call.args[call.args.indexOf('--expr') + 1];
  if (profile === 'fetchurl') {
    assert.match(expression, /--proto/);
    assert.match(expression, /--cacert/);
  } else if (profile === 'fetchzip') {
    assert.match(expression, /REPLAY_TAR/);
    assert.match(expression, /REPLAY_UNZIP/);
    assert.match(expression, /REPLAY_MV/);
  } else {
    assert.match(expression, /--no-tags/);
    assert.match(expression, /--no-recurse-submodules/);
    assert.match(expression, /GIT_CONFIG_NOSYSTEM/);
    assert.match(expression, /GIT_SSL_CAINFO/);
  }
}

function setupReplay(options = {}) {
  const fixture = createRemoteBuilderFixture();
  const classifier = loadClassifier(fixture);
  const profile = options.profile ?? fetchurlProfile();
  const request = makeRequest(profile, fixture);
  const nix = createReplayNix(fixture, request, options);
  const replay = loadReplay(fixture, classifier, {
    ...options,
    nixExecutable: nix.executable,
  });
  return { classifier, fixture, nix, profile, replay, request };
}

test('source replay production derivation passes writeShellApplication checks', () => {
  const fixture = createRemoteBuilderFixture();
  const caBundle = path.join(fixture.paths.control, 'pinned-ca-bundle.pem');
  fs.writeFileSync(caBundle, 'fixture pinned CA bundle\n', { mode: 0o400 });
  try {
    const result = buildReplayPackage(fixture);

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fixture.cleanup();
  }
});

test('source replay builds fresh matching evidence for every classified standard profile', () => {
  for (const [name, profile] of [
    ['fetchurl', fetchurlProfile()],
    ['fetchzip', fetchzipProfile()],
    ['fetchgit', fetchgitProfile()],
  ]) {
    const { fixture, nix, replay, request } = setupReplay({ profile });
    try {
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'eligible', JSON.stringify(result.output));
      assert.equal(result.output.profile, name);
      assert.equal(result.output.primed, true);
      assert.equal(result.output.checkRuns, 1);
      assert.deepEqual(result.output.evidence, {
        output: request.expected.path,
        hash: request.expected.hash,
        source: 'fresh-check',
      });

      const calls = nix.calls();
      const buildCalls = calls.filter(call => call.args[0] === 'build');
      assert.equal(buildCalls.length, 2, name);
      const hashCalls = calls.filter(call => call.args[0] === 'hash');
      assert.equal(hashCalls.length, 1, name);
      assert.deepEqual(hashCalls[0].args, [
        'hash',
        'convert',
        '--from',
        'sri',
        '--to',
        'nix32',
        request.source.hash,
      ], name);
      const checkCall = buildCalls.find(call => call.args.includes('--rebuild'));
      assertSafeReplayCommand(checkCall, request, { check: true });
      assertProfileReplayExpression(checkCall, name);
      assertSafeReplayCommand(buildCalls.find(call => !call.args.includes('--rebuild')), request, { check: false });
      assert.equal(fixture.controls.cache.calls().length, 0, `${name}: no cache hook may run`);
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay skips Normal priming for a present output but always runs Check', () => {
  const { fixture, nix, replay, request } = setupReplay({ present: true });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'eligible');
    assert.equal(result.output.primed, false);
    assert.equal(result.output.checkRuns, 1);
    const buildCalls = nix.calls().filter(call => call.args[0] === 'build');
    assert.equal(buildCalls.length, 1);
    assertSafeReplayCommand(buildCalls[0], request, { check: true });
  } finally {
    fixture.cleanup();
  }
});

test('source replay fails closed on output/hash mismatch and leaves no queue or proof state', () => {
  for (const mismatch of [
    { name: 'output mismatch', observedPath: '/nix/store/ffffffffffffffffffffffffffffffff-wrong-output' },
    {
      name: 'flat content-address mismatch',
      observedNarHash: HASH,
      observedCa: `fixed:sha256:${OTHER_NIX32_HASH}`,
    },
  ]) {
    const { fixture, nix, replay, request } = setupReplay({
      present: true,
      ...mismatch,
    });
    try {
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${mismatch.name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', mismatch.name);
      assert.match(result.output.reason, /mismatch/);
      assert.equal(result.output.evidence, null);
      assert.equal(result.output.primed, false);
      assert.equal(nix.calls().filter(call => call.args[0] === 'build').length, 1);
      assert.equal(fixture.controls.cache.calls().length, 0);
      assert.equal(fs.readdirSync(fixture.paths.state).length, 0, 'proof state must be removed');
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay requires mode-consistent CA metadata and recursive NAR identity', () => {
  for (const mismatch of [
    {
      name: 'flat recursive CA mode mismatch',
      profile: fetchurlProfile(),
      observedNarHash: HASH,
      observedCa: `fixed:r:sha256:${NIX32_HASH}`,
    },
    {
      name: 'flat malformed CA',
      profile: fetchurlProfile(),
      observedNarHash: HASH,
      observedCa: 'not-a-content-address',
    },
    {
      name: 'flat missing CA',
      profile: fetchurlProfile(),
      observedNarHash: HASH,
      omitCa: true,
    },
    {
      name: 'recursive NAR mismatch',
      profile: fetchzipProfile(),
      observedNarHash: OTHER_HASH,
    },
  ]) {
    const { fixture, nix, replay, request } = setupReplay({ present: true, ...mismatch });
    try {
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${mismatch.name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', mismatch.name);
      assert.equal(result.output.reason, 'hash mismatch', mismatch.name);
      assert.equal(result.output.evidence, null, mismatch.name);
      assert.equal(
        nix.calls().filter(call => call.args[0] === 'build').length,
        1,
        mismatch.name,
      );
      assert.equal(fixture.controls.cache.calls().length, 0, mismatch.name);
      assert.equal(
        fs.readdirSync(fixture.paths.state).length,
        0,
        `${mismatch.name}: proof state must be removed`,
      );
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay always attempts Check and reports command failure without cache or credentials', () => {
  const { fixture, nix, replay, request } = setupReplay({
    present: true,
    checkStatus: 42,
  });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    const checkCall = nix.calls().find(call => call.args.includes('--rebuild'));
    assert.ok(checkCall, 'final Check must run even when it fails');
    assertSafeReplayCommand(checkCall, request, { check: true });
    assert.equal(fixture.controls.cache.calls().length, 0);
    assert.equal(fs.readdirSync(fixture.paths.state).length, 0, 'proof state must be removed');
  } finally {
    fixture.cleanup();
  }
});

test('source replay converts a final Check command failure to error and does not retain a proof process', () => {
  const { fixture, nix, replay, request } = setupReplay({
    present: true,
    hangOnCheck: true,
    commandTimeoutSeconds: 3,
    commandKillAfterSeconds: 1,
  });
  try {
    const result = runReplay(replay, fixture, request, { timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    assert.equal(nix.calls().filter(call => call.args[0] === 'build').length, 1);
    assert.equal(fixture.controls.cache.calls().length, 0);
    const childPid = Number(fs.readFileSync(nix.childPidPath, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
  } finally {
    fixture.cleanup();
  }
});

test('source replay terminates an overflowing command and redacts bounded stdout and stderr', () => {
  const secret = 'fixture-source-replay-output-secret';
  const maxCommandOutputBytes = 128;
  const { fixture, nix, replay, request } = setupReplay({
    present: true,
    maxCommandOutputBytes,
    hangOnOutput: true,
    output: {
      stdout: `${secret}${'o'.repeat(4096)}`,
      stderr: `${secret}${'e'.repeat(4096)}`,
    },
  });
  try {
    const result = runReplay(replay, fixture, request, { timeout: 30_000 });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    const checkCall = nix.calls().find(call => call.args.includes('--rebuild'));
    assertSafeReplayCommand(checkCall, request, {
      check: true,
      maxCommandOutputBytes,
    });
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.equal(fixture.controls.cache.calls().length, 0);
    assert.equal(fs.readdirSync(fixture.paths.state).length, 0, 'proof state must be removed');
    const childPid = Number(fs.readFileSync(nix.childPidPath, 'utf8'));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.throws(() => process.kill(childPid, 0), error => error.code === 'ESRCH');
  } finally {
    fixture.cleanup();
  }
});

test('source replay enforces the isolated workspace bound before accepting build evidence', () => {
  const { fixture, nix, replay, request } = setupReplay({
    present: true,
    maxWorkspaceBytes: 64 * 1024,
    workspaceOutputBytes: 128 * 1024,
  });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    const checkCall = nix.calls().find(call => call.args.includes('--rebuild'));
    assertSafeReplayCommand(checkCall, request, { check: true });
    assert.equal(fixture.controls.cache.calls().length, 0);
    assert.equal(fs.readdirSync(fixture.paths.state).length, 0, 'proof state must be removed');
  } finally {
    fixture.cleanup();
  }
});

test('source replay counts canonical store output outside validation_root against the workspace bound', () => {
  const { fixture, nix, replay, request } = setupReplay({
    present: true,
    maxWorkspaceBytes: 64 * 1024,
    storeOutputBytes: 128 * 1024,
  });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    const checkCall = nix.calls().find(call => call.args.includes('--rebuild'));
    assertSafeReplayCommand(checkCall, request, { check: true });
    const storeRoot = checkCall.args[checkCall.args.indexOf('--store') + 1].slice('local?root='.length);
    assert.notEqual(storeRoot, path.dirname(checkCall.env.TMPDIR));
    assert.equal(fixture.controls.cache.calls().length, 0);
    assert.equal(fs.readdirSync(fixture.paths.state).length, 0, 'proof state must be removed');
  } finally {
    fixture.cleanup();
  }
});

test('source replay enforces one aggregate deadline across classifier, priming, Check, and comparison', () => {
  const { fixture, nix, replay, request } = setupReplay({
    delaySeconds: 0.75,
    commandTimeoutSeconds: 2,
    commandKillAfterSeconds: 1,
  });
  const startedAt = Date.now();
  try {
    const result = runReplay(replay, fixture, request, { timeout: 15_000 });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'error');
    assert.equal(result.output.reason, 'command failure');
    assert.ok(elapsedMs < 2_800, `aggregate deadline exceeded: ${elapsedMs}ms`);
    assert.equal(
      nix.calls().filter(call => call.args[0] === 'path-info').length,
      1,
      'comparison must not start after the aggregate deadline',
    );
    assert.equal(fixture.controls.cache.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('source replay binds the proxy endpoint and nonce to validator-owned request values', () => {
  const cases = [
    {
      name: 'unexpected endpoint',
      mutate(request) {
        request.proxy.endpoint = 'socks5h://127.0.0.1:1081';
      },
    },
    {
      name: 'proxy nonce mismatch',
      mutate(request) {
        request.proxy.nonce = 'fixture-source-replay-other-nonce';
      },
    },
    {
      name: 'caller-selected CA path',
      secret: 'fixture-source-replay-arbitrary-ca-path',
      mutate(request, fixture, secret) {
        request.proxy.caBundle = path.join(fixture.paths.control, secret);
      },
    },
  ];

  for (const testCase of cases) {
    const fixture = createRemoteBuilderFixture();
    const profile = fetchurlProfile();
    const request = makeRequest(profile, fixture);
    const secret = testCase.secret ?? 'fixture-source-replay-proxy-secret';
    testCase.mutate(request, fixture, secret);
    const nix = createReplayNix(fixture, request);
    const classifier = loadClassifier(fixture);
    const replay = loadReplay(fixture, classifier, { nixExecutable: nix.executable });
    try {
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', testCase.name);
      assert.equal(result.output.reason, 'schema drift', testCase.name);
      assert.equal(nix.calls().length, 0, `${testCase.name}: Nix must not run`);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
      assert.equal(fixture.controls.cache.calls().length, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay rejects daemon and caller-selected store roots before invoking Nix', () => {
  for (const store of [
    'daemon',
    'local?root=/private/var/tmp/fixture-caller-selected-replay-store',
  ]) {
    const { fixture, nix, replay, request } = setupReplay();
    request.store = store;
    try {
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${store}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', store);
      assert.equal(result.output.reason, 'schema drift', store);
      assert.equal(nix.calls().length, 0, `${store}: Nix must not run`);
      assert.equal(fixture.controls.cache.calls().length, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay rejects a changed or writable injected CA bundle without invoking Nix', () => {
  for (const change of [
    {
      name: 'changed content',
      apply(caBundle) {
        fs.chmodSync(caBundle, 0o600);
        fs.writeFileSync(caBundle, 'fixture changed CA content\n', { mode: 0o600 });
        fs.chmodSync(caBundle, 0o400);
      },
    },
    {
      name: 'writable content',
      apply(caBundle) {
        fs.chmodSync(caBundle, 0o666);
      },
    },
  ]) {
    const fixture = createRemoteBuilderFixture();
    const profile = fetchurlProfile();
    const request = makeRequest(profile, fixture);
    const nix = createReplayNix(fixture, request);
    const classifier = loadClassifier(fixture);
    const replay = loadReplay(fixture, classifier, { nixExecutable: nix.executable });
    try {
      change.apply(request.caBundle);
      const result = runReplay(replay, fixture, request);

      assert.equal(result.status, 0, `${change.name}: ${result.stderr}`);
      assert.equal(result.output.decision, 'ineligible', change.name);
      assert.equal(result.output.reason, 'schema drift', change.name);
      assert.equal(nix.calls().length, 0, `${change.name}: Nix must not run`);
      assert.equal(fixture.controls.cache.calls().length, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('source replay rejects unsupported classifier output without invoking Nix', () => {
  const fixture = createRemoteBuilderFixture();
  const profile = fetchurlProfile({ builder: 'fetchFromGitHub' });
  const request = makeRequest(profile, fixture);
  const nix = createReplayNix(fixture, request);
  const classifier = loadClassifier(fixture);
  const replay = loadReplay(fixture, classifier, { nixExecutable: nix.executable });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'ineligible');
    assert.equal(result.output.reason, 'unknown fetcher');
    assert.equal(nix.calls().length, 0);
    assert.equal(fixture.controls.cache.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('source replay rejects credential-bearing sources without echoing or invoking a proof command', () => {
  const secret = 'fixture-source-replay-credential';
  const fixture = createRemoteBuilderFixture();
  const profile = fetchurlProfile({
    urls: [`https://downloads.example.test/source.tar.gz?token=${secret}`],
  });
  const request = makeRequest(profile, fixture);
  const nix = createReplayNix(fixture, request);
  const classifier = loadClassifier(fixture);
  const replay = loadReplay(fixture, classifier, { nixExecutable: nix.executable });
  try {
    const result = runReplay(replay, fixture, request);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.decision, 'ineligible');
    assert.equal(result.output.reason, 'credential syntax');
    assert.equal(nix.calls().length, 0);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
    assert.equal(fixture.controls.cache.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});
