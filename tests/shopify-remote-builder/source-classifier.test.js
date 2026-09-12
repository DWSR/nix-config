'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
  runExecutable,
} = require('./helpers');

const CLASSIFIER_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-source-classifier.nix',
);
const HASH = 'sha256-qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq=';
const REVISION = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-source-classifier-read-only', `
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
    nixExecutable: readOnlyNixExecutable(fixture),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function runClassifier(executable, fixture, profile) {
  const result = runExecutable(executable, [], {
    fixture,
    input: `${JSON.stringify(profile)}\n`,
    timeout: 360_000,
  });
  return {
    ...result,
    output: result.stdout === '' ? null : JSON.parse(result.stdout),
  };
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

function assertNoLeak(result, forbiddenValues) {
  const serialized = `${result.stdout}\n${result.stderr}`;
  for (const value of forbiddenValues) {
    assert.doesNotMatch(
      serialized,
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
}

test('source classifier supports standard pinned fetchurl, fetchzip, and full-revision fetchgit', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const classifier = loadClassifier(fixture);
    const cases = [
      ['fetchurl', fetchurlProfile(), 'fetchurl'],
      ['fetchzip', fetchzipProfile(), 'fetchzip'],
      ['fetchgit', fetchgitProfile(), 'fetchgit'],
    ];

    for (const [name, profile, expectedProfile] of cases) {
      const result = runClassifier(classifier, fixture, profile);
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.deepEqual(result.output, {
        decision: 'supported',
        profile: expectedProfile,
        reason: null,
      }, name);
    }
  } finally {
    fixture.cleanup();
  }
});

test('source classifier returns one deterministic fail-closed result for every unsupported profile', () => {
  const credential = 'fixture-source-classifier-credential';
  const awsSignature = 'fixture-aws-signature';
  const awsAccessKey = 'fixture-aws-access-key';
  const arbitraryQuerySecret = 'fixture-arbitrary-query-secret';
  const localPath = `/Users/fixture/${credential}`;
  const cases = [
    {
      name: 'local path',
      profile: fetchurlProfile({ urls: [localPath] }),
      reason: 'local input',
      forbidden: [credential, localPath],
    },
    {
      name: 'mutable source without a static hash',
      profile: fetchurlProfile({ hash: null }),
      reason: 'mutable source',
    },
    {
      name: 'hash with trailing newline',
      profile: fetchurlProfile({ hash: `${HASH}\n` }),
      reason: 'mutable source',
      forbidden: [`${HASH}\n`],
    },
    {
      name: 'userinfo credentials',
      profile: fetchurlProfile({ urls: [`https://user:${credential}@downloads.example.test/source`] }),
      reason: 'credential syntax',
      forbidden: [credential, `https://user:${credential}@downloads.example.test/source`],
    },
    {
      name: 'query credentials',
      profile: fetchurlProfile({ urls: [`https://downloads.example.test/source?token=${credential}`] }),
      reason: 'credential syntax',
      forbidden: [credential],
    },
    {
      name: 'AWS signed query credentials',
      profile: fetchurlProfile({ urls: [
        `https://downloads.example.test/source?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${awsAccessKey}&X-Amz-Signature=${awsSignature}`,
      ] }),
      reason: 'credential syntax',
      forbidden: [awsAccessKey, awsSignature],
    },
    {
      name: 'AWS access key query credential',
      profile: fetchurlProfile({ urls: [
        `https://downloads.example.test/source?AWSAccessKeyId=${awsAccessKey}&Signature=${awsSignature}`,
      ] }),
      reason: 'credential syntax',
      forbidden: [awsAccessKey, awsSignature],
    },
    {
      name: 'arbitrary query value',
      profile: fetchurlProfile({ urls: [
        `https://downloads.example.test/source?download=${arbitraryQuerySecret}`,
      ] }),
      reason: 'credential syntax',
      forbidden: [arbitraryQuerySecret],
    },
    {
      name: 'unknown builder',
      profile: fetchurlProfile({ builder: 'fetchFromGitHub' }),
      reason: 'unknown fetcher',
    },
    {
      name: 'custom curl options',
      profile: fetchurlProfile({ options: { curlOpts: ['--header', credential] } }),
      reason: 'custom options',
      forbidden: [credential],
    },
    {
      name: 'custom git configuration',
      profile: fetchgitProfile({ options: { ...fetchgitProfile().options, gitConfig: credential } }),
      reason: 'custom options',
      forbidden: [credential],
    },
    {
      name: 'custom hook',
      profile: fetchurlProfile({ options: { hooks: [`postFetch=${credential}`] } }),
      reason: 'custom hook',
      forbidden: [credential],
    },
    {
      name: 'mirror',
      profile: fetchurlProfile({ options: { mirrors: ['https://mirror.example.test/source'] } }),
      reason: 'mirrors',
    },
    {
      name: 'git submodules',
      profile: fetchgitProfile({ options: { ...fetchgitProfile().options, submodules: true } }),
      reason: 'submodules',
    },
    {
      name: 'git LFS',
      profile: fetchgitProfile({ options: { ...fetchgitProfile().options, lfs: true } }),
      reason: 'lfs',
    },
    {
      name: 'git tags',
      profile: fetchgitProfile({ options: { ...fetchgitProfile().options, tags: true } }),
      reason: 'tags',
    },
    {
      name: 'short git revision',
      profile: fetchgitProfile({ revision: 'deadbeef' }),
      reason: 'mutable source',
    },
    {
      name: 'git revision with trailing newline',
      profile: fetchgitProfile({ revision: `${REVISION}\n` }),
      reason: 'mutable source',
      forbidden: [`${REVISION}\n`],
    },
    {
      name: 'git revision missing',
      profile: (() => {
        const profile = fetchgitProfile();
        delete profile.revision;
        return profile;
      })(),
      reason: 'mutable source',
    },
    {
      name: 'multiple URLs',
      profile: fetchurlProfile({ urls: [
        'https://downloads.example.test/source.tar.gz',
        'https://mirror.example.test/source.tar.gz',
      ] }),
      reason: 'multiple sources',
    },
    {
      name: 'hyphen-only host',
      profile: fetchurlProfile({ urls: ['https://-/source.tar.gz'] }),
      reason: 'schema drift',
    },
    {
      name: 'empty DNS label',
      profile: fetchurlProfile({ urls: ['https://downloads..example.test/source.tar.gz'] }),
      reason: 'schema drift',
    },
    {
      name: 'invalid IPv4 address',
      profile: fetchurlProfile({ urls: ['https://999.999.999.999/source.tar.gz'] }),
      reason: 'schema drift',
    },
    {
      name: 'malformed IPv6 address',
      profile: fetchurlProfile({ urls: ['https://[2001:db8::1::2]/source.tar.gz'] }),
      reason: 'schema drift',
    },
    {
      name: 'unknown top-level source path',
      profile: fetchurlProfile({ sourcePath: localPath }),
      reason: 'schema drift',
      forbidden: [credential, localPath],
    },
  ];

  const fixture = createRemoteBuilderFixture();
  try {
    const classifier = loadClassifier(fixture);
    for (const testCase of cases) {
      const first = runClassifier(classifier, fixture, testCase.profile);
      const second = runClassifier(classifier, fixture, testCase.profile);
      for (const result of [first, second]) {
        assert.equal(result.status, 0, `${testCase.name}: ${result.stderr}`);
        assert.deepEqual(result.output, {
          decision: 'ineligible',
          profile: null,
          reason: testCase.reason,
        }, testCase.name);
        assertNoLeak(result, testCase.forbidden ?? []);
      }
      assert.deepEqual(first.output, second.output, `${testCase.name} must be deterministic`);
    }
  } finally {
    fixture.cleanup();
  }
});

test('source classifier rejects malformed input without echoing data', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const classifier = loadClassifier(fixture);
    const secret = 'fixture-malformed-source-secret';
    const result = runExecutable(classifier, [], {
      fixture,
      input: `{ "builder": "fetchurl", "sourcePath": "/Users/${secret}",`,
      timeout: 360_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      decision: 'ineligible',
      profile: null,
      reason: 'schema drift',
    });
    assertNoLeak(result, [secret]);
  } finally {
    fixture.cleanup();
  }
});

test('source classifier rejects multiple JSON values as schema drift', () => {
  const secret = 'fixture-trailing-source-secret';
  const fixture = createRemoteBuilderFixture();
  try {
    const classifier = loadClassifier(fixture);
    const result = runExecutable(classifier, [], {
      fixture,
      input: `${JSON.stringify(fetchurlProfile())}\n{"sourcePath":"/Users/${secret}"}\n`,
      timeout: 360_000,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      decision: 'ineligible',
      profile: null,
      reason: 'schema drift',
    });
    assertNoLeak(result, [secret]);
  } finally {
    fixture.cleanup();
  }
});
