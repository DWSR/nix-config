'use strict';

// Evaluation tests for `configurations/mac-builder/substituters.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 3; design "Component
// Contracts → Builder Host → Builder Cache Policy"; requirements 5.3, 5.4,
// 7.1, 7.2, 7.3, 7.4, 7.7).
//
// Two evaluation shapes are covered:
//
// - `darwinConfigurations.mac-builder` proves what the host really ships: the
//   exact public substituter and key sets, no extra substituters, no private
//   cache credential, no publication hook, `aarch64-darwin` only, and no
//   `extra-platforms`.
// - A standalone nix-darwin fixture imports the cache policy module plus one
//   deliberate violation per case, so every assertion is proven to fail for a
//   fixture that adds a private cache host, a private cache key, a cache
//   credential, an extra platform, a foreign host platform, a
//   `post-build-hook`, or a cache directive smuggled through `nix.extraOptions`.
//   Assertions are forced through `system.build.toplevel.drvPath`, which is
//   where nix-darwin evaluates them.
//
// `nix.extraOptions` is appended verbatim after the generated settings in
// `/etc/nix/nix.conf`, so a later module could restate `substituters` there and
// silently override the public list while the system still evaluates. The same
// applies to Nix's pre-2.0 aliases: `binary-caches` is `substituters`,
// `extra-binary-caches` is appended after the modern key, and
// `binary-cache-public-keys` is `trusted-public-keys`. The tests therefore pin
// both the declared settings (modern keys only, no alias) and the generated
// `nix.conf` text that Nix actually reads.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const policyModule = `${repoRoot}/configurations/mac-builder/substituters.nix`;
const NIX_TIMEOUT_MS = 600_000;

// The two public caches this repository declares, with the keys pinned in
// `research.md` ("Public caches") and `tests/local-binary-cache`.
const publicSubstituters = [
  'https://cache.nixos.org/',
  'https://nix-community.cachix.org',
];
const publicTrustedPublicKeys = [
  'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
  'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=',
];

// The repository's private binary cache and an unrelated private cache key:
// the builder must reference neither.
const privateSubstituter = 'https://Brandons-MacBook-Pro.local:8443/darwin';
const privateTrustedPublicKey = 'private-cache.example-1:AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=';

const cachePolicyMarker = 'mac-builder cache policy';

// Nix still honours these pre-2.0 names for the cache settings, so any of them
// in `nix.settings` is written to `nix.conf` and can add or override a cache
// without touching the modern keys.
const legacyCacheAliases = [
  'binary-caches',
  'extra-binary-caches',
  'binary-cache-public-keys',
  'trusted-binary-caches',
  'extra-trusted-binary-caches',
];

const SELECTION = `{
  hostPlatform = config.nixpkgs.hostPlatform.system;
  substituters = config.nix.settings.substituters;
  trustedPublicKeys = config.nix.settings.trusted-public-keys;
  legacyAliasSettings = builtins.filter (name: builtins.hasAttr name config.nix.settings) [ ${legacyCacheAliases.map((alias) => JSON.stringify(alias)).join(' ')} ];
  hasExtraSubstituters = config.nix.settings ? extra-substituters;
  extraSubstituters = config.nix.settings.extra-substituters or [ ];
  hasExtraTrustedPublicKeys = config.nix.settings ? extra-trusted-public-keys;
  extraTrustedPublicKeys = config.nix.settings.extra-trusted-public-keys or [ ];
  hasExtraPlatforms = config.nix.settings ? extra-platforms;
  extraPlatforms = config.nix.settings.extra-platforms or [ ];
  hasNetrcFile = config.nix.settings ? netrc-file;
  secretKeyFiles = config.nix.settings.secret-key-files or [ ];
  hasPostBuildHook = config.nix.settings ? post-build-hook;
  postBuildHook = config.nix.settings.post-build-hook or null;
  extraOptions = config.nix.extraOptions;
  nixConfText = config.environment.etc."nix/nix.conf".source.text;
}`;

// `nix.extraOptions` is free-form `nix.conf` text: lines that are blank or only
// a `#` comment change nothing, every other line is a directive that lands
// after the generated settings.
function extraOptionDirectives(text) {
  return text
    .split('\n')
    .filter((line) => !/^\s*(#.*)?$/.test(line));
}

// Parse the generated `nix.conf` into `key = value` entries so the effective
// cache configuration can be inspected the way Nix reads it.
function nixConfEntries(text) {
  return text
    .split('\n')
    .map((raw) => raw.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => {
      // `include` and `!include` are bare directives, not `key = value` lines.
      if (line.startsWith('include ') || line.startsWith('!include ')) {
        return { key: 'include', value: line };
      }
      const eq = line.indexOf('=');
      const key = (eq === -1 ? line : line.slice(0, eq)).trim().replace(/^!/, '');
      const value = eq === -1 ? '' : line.slice(eq + 1).trim();
      return { key, value };
    });
}

function tokens(value) {
  return value.split(/\s+/).filter((token) => token !== '');
}

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
}

function nixEvalRawFailure(expr) {
  try {
    childProcess.execFileSync(
      'nix',
      ['eval', '--raw', '--impure', '--expr', expr],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: NIX_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    return String(error.stderr ?? error.message);
  }

  throw new Error('expected nix eval to fail, but it succeeded');
}

// The real `darwinConfigurations.mac-builder`, i.e. what the builder boots.
function hostReport() {
  return nixEvalJson(`
let
  flake = builtins.getFlake (toString ${repoRoot});
  config = flake.darwinConfigurations.mac-builder.config;
in ${SELECTION}
`);
}

// The cache policy module in a standalone nix-darwin system, beside one
// fixture module per case.
function fixtureConfig(extraModules) {
  return `
let
  flake = builtins.getFlake (toString ${repoRoot});
  darwin = flake.inputs.darwin.lib;
  config = (darwin.darwinSystem {
    modules = [
      ({ lib, ... }: {
        nixpkgs.hostPlatform = lib.mkDefault "aarch64-darwin";
        system.stateVersion = 7;
      })
      ${policyModule}
      ${extraModules}
    ];
  }).config;
in`;
}

function fixtureReport(extraModules) {
  return nixEvalJson(`${fixtureConfig(extraModules)} ${SELECTION}`);
}

function fixtureAssertionFailure(extraModules) {
  return nixEvalRawFailure(`${fixtureConfig(extraModules)} config.system.build.toplevel.drvPath`);
}

// The evaluated list is a *set* of caches: nix-darwin's own module appends the
// stock `https://cache.nixos.org/` with `mkAfter`, so the module's exact pair
// can repeat there. What matters is that no cache outside the public pair can
// appear, which is what these comparisons pin.
function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

test('the builder host substitutes from exactly the two public caches', () => {
  const report = hostReport();

  assert.deepStrictEqual(
    uniqueSorted(report.substituters),
    uniqueSorted(publicSubstituters),
    `the host must declare exactly the public caches, got: ${JSON.stringify(report.substituters)}`,
  );
});

test('the builder host trusts exactly the two public cache keys', () => {
  const report = hostReport();

  assert.deepStrictEqual(
    uniqueSorted(report.trustedPublicKeys),
    uniqueSorted(publicTrustedPublicKeys),
    `the host must trust exactly the public cache keys, got: ${JSON.stringify(report.trustedPublicKeys)}`,
  );
});

test('the builder host adds no extra substituter, cache credential, or publication hook', () => {
  const report = hostReport();

  assert.equal(
    report.hasExtraSubstituters,
    false,
    `no extra-substituters may be declared, got: ${JSON.stringify(report.extraSubstituters)}`,
  );
  assert.equal(
    report.hasExtraTrustedPublicKeys,
    false,
    `no extra-trusted-public-keys may be declared, got: ${JSON.stringify(report.extraTrustedPublicKeys)}`,
  );
  assert.equal(report.hasNetrcFile, false, 'the builder must hold no cache credential file');
  assert.deepStrictEqual(report.secretKeyFiles, [], 'the builder must hold no cache signing key');
  assert.equal(
    report.hasPostBuildHook,
    false,
    `no post-build-hook may publish outputs, got: ${JSON.stringify(report.postBuildHook)}`,
  );
});

test('the builder host stays aarch64-darwin with no extra platforms', () => {
  const report = hostReport();

  assert.equal(report.hostPlatform, 'aarch64-darwin');
  assert.equal(
    report.hasExtraPlatforms,
    false,
    `extra-platforms must stay unset, got: ${JSON.stringify(report.extraPlatforms)}`,
  );
});

test('the builder host declares no cache directive in nix.extraOptions', () => {
  const report = hostReport();

  assert.deepStrictEqual(
    extraOptionDirectives(report.extraOptions),
    [],
    `nix.extraOptions is appended after the generated settings, so it must stay empty, got: ${JSON.stringify(report.extraOptions)}`,
  );
});

test('the builder host sets no legacy cache alias', () => {
  const report = hostReport();

  assert.deepStrictEqual(
    report.legacyAliasSettings,
    [],
    `nix.settings must use the modern cache keys only, got: ${JSON.stringify(report.legacyAliasSettings)}`,
  );
});

test('the generated nix.conf carries only the public cache policy', () => {
  const report = hostReport();
  const entries = nixConfEntries(report.nixConfText);

  const substituterEntries = entries.filter(
    (entry) => entry.key === 'substituters' || entry.key === 'extra-substituters',
  );
  const trustedKeyEntries = entries.filter(
    (entry) => entry.key === 'trusted-public-keys' || entry.key === 'extra-trusted-public-keys',
  );
  const aliasEntries = entries.filter((entry) => legacyCacheAliases.includes(entry.key));

  assert.equal(
    substituterEntries.length,
    1,
    `nix.conf must state the substituters once, got: ${JSON.stringify(substituterEntries)}`,
  );
  assert.equal(
    trustedKeyEntries.length,
    1,
    `nix.conf must state the trusted keys once, got: ${JSON.stringify(trustedKeyEntries)}`,
  );
  assert.deepStrictEqual(
    uniqueSorted(tokens(substituterEntries[0].value)),
    uniqueSorted(publicSubstituters),
    `nix.conf must substitute from the public caches only, got: ${JSON.stringify(substituterEntries[0].value)}`,
  );
  assert.deepStrictEqual(
    uniqueSorted(tokens(trustedKeyEntries[0].value)),
    uniqueSorted(publicTrustedPublicKeys),
    `nix.conf must trust the public cache keys only, got: ${JSON.stringify(trustedKeyEntries[0].value)}`,
  );

  // Nix reads the alias directives too, so a clean modern key must not hide a
  // second cache source written under a legacy name.
  assert.deepStrictEqual(
    aliasEntries,
    [],
    `nix.conf must not restate the cache policy through a legacy alias, got: ${JSON.stringify(aliasEntries)}`,
  );
  for (const { key, value } of entries) {
    assert.equal(
      ['netrc-file', 'secret-key-files', 'post-build-hook', 'include', 'extra-platforms'].includes(key),
      false,
      `nix.conf must not carry a cache credential, publication hook, include, or extra platform, got: ${key} = ${value}`,
    );
  }
});

test('the evaluated builder host passes the cache policy assertions', () => {
  const drvPath = childProcess.execFileSync(
    'nix',
    [
      'eval',
      '--raw',
      '--impure',
      '--expr',
      `let
        flake = builtins.getFlake (toString ${repoRoot});
      in flake.darwinConfigurations.mac-builder.config.system.build.toplevel.drvPath`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();

  assert.match(drvPath, /^\/nix\/store\/.+darwin-system-.+\.drv$/);
});

test('the cache policy module alone declares the exact public cache sets', () => {
  const report = fixtureReport('');

  assert.deepStrictEqual(uniqueSorted(report.substituters), uniqueSorted(publicSubstituters));
  assert.deepStrictEqual(uniqueSorted(report.trustedPublicKeys), uniqueSorted(publicTrustedPublicKeys));
  assert.equal(report.hostPlatform, 'aarch64-darwin');
});

test('a fixture that adds a private substituter fails the substituter assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.substituters = [ ${JSON.stringify(privateSubstituter)} ];
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: every substituter`));
  assert.ok(
    stderr.includes(privateSubstituter),
    `the failure must name the private cache host, got: ${stderr}`,
  );
});

test('a fixture that adds a private cache key to the trusted set fails the trusted-key assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.trusted-public-keys = [ ${JSON.stringify(privateTrustedPublicKey)} ];
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: every trusted public key`));
  assert.ok(
    stderr.includes(privateTrustedPublicKey),
    `the failure must name the private cache key, got: ${stderr}`,
  );
});

test('a fixture that adds a private cache host fails the substituter assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.extra-substituters = [ ${JSON.stringify(privateSubstituter)} ];
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: every substituter`));
  assert.ok(
    stderr.includes(privateSubstituter),
    `the failure must name the private cache host, got: ${stderr}`,
  );
});

test('a fixture that adds a private cache key fails the trusted-key assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.extra-trusted-public-keys = [ ${JSON.stringify(privateTrustedPublicKey)} ];
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: every trusted public key`));
  assert.ok(
    stderr.includes(privateTrustedPublicKey),
    `the failure must name the private cache key, got: ${stderr}`,
  );
});

test('a fixture that adds an extra platform fails the Darwin-only assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.extra-platforms = [ "x86_64-darwin" ];
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: extra-platforms must stay unset`));
  assert.ok(stderr.includes('x86_64-darwin'), `the failure must name the extra platform, got: ${stderr}`);
});

test('a fixture that targets another Darwin platform fails the Darwin-only assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nixpkgs.hostPlatform = "x86_64-darwin";
  }`);

  assert.match(
    stderr,
    new RegExp(`${cachePolicyMarker}: nixpkgs.hostPlatform must stay aarch64-darwin`),
  );
  assert.ok(stderr.includes('x86_64-darwin'), `the failure must name the host platform, got: ${stderr}`);
});

test('a fixture that adds a post-build-hook fails the no-publication assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.post-build-hook = "/usr/local/bin/publish-darwin-output";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: the builder must not publish`));
  assert.ok(
    stderr.includes('/usr/local/bin/publish-darwin-output'),
    `the failure must name the publication hook, got: ${stderr}`,
  );
});

test('a fixture that adds a cache credential file fails the no-credential assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.settings.netrc-file = "/run/secrets/attic-client-token";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: the builder must not hold a private cache credential`));
  assert.ok(
    stderr.includes('/run/secrets/attic-client-token'),
    `the failure must name the credential file, got: ${stderr}`,
  );
});

test('a fixture that restates substituters in nix.extraOptions fails the extraOptions assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.extraOptions = "substituters = ${privateSubstituter}";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: nix.extraOptions must stay empty`));
  assert.ok(
    stderr.includes(privateSubstituter),
    `the failure must name the extra cache host, got: ${stderr}`,
  );
});

test('a fixture that adds a trusted key in nix.extraOptions fails the extraOptions assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.extraOptions = "trusted-public-keys = ${privateTrustedPublicKey}";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: nix.extraOptions must stay empty`));
  assert.ok(
    stderr.includes(privateTrustedPublicKey),
    `the failure must name the extra cache key, got: ${stderr}`,
  );
});

test('a fixture that includes another nix.conf through nix.extraOptions fails the extraOptions assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.extraOptions = "!include /etc/nix/private-cache.conf";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: nix.extraOptions must stay empty`));
  assert.ok(
    stderr.includes('!include /etc/nix/private-cache.conf'),
    `the failure must name the include directive, got: ${stderr}`,
  );
});

test('a fixture that adds a post-build-hook through nix.extraOptions fails the extraOptions assertion', () => {
  const stderr = fixtureAssertionFailure(`{
    nix.extraOptions = "post-build-hook = /usr/local/bin/publish-darwin-output";
  }`);

  assert.match(stderr, new RegExp(`${cachePolicyMarker}: nix.extraOptions must stay empty`));
  assert.ok(
    stderr.includes('/usr/local/bin/publish-darwin-output'),
    `the failure must name the publication hook, got: ${stderr}`,
  );
});

test('a fixture that sets a private cache through a legacy alias fails the alias assertion', () => {
  for (const alias of legacyCacheAliases) {
    const value = alias === 'binary-cache-public-keys'
      ? `[ ${JSON.stringify(privateTrustedPublicKey)} ]`
      : `[ ${JSON.stringify(privateSubstituter)} ]`;
    // `extra-binary-caches` is the sharpest case: nix-darwin writes it after
    // the modern `substituters`, so Nix appends it to the effective cache list
    // even though `substituters` and `trusted-public-keys` stay exact.
    const stderr = fixtureAssertionFailure(`{
      nix.settings.${JSON.stringify(alias)} = ${value};
    }`);

    assert.match(
      stderr,
      new RegExp(`${cachePolicyMarker}: nix.settings must not use legacy cache aliases`),
      `the ${alias} alias must fail the policy assertion, got: ${stderr}`,
    );
    assert.ok(
      stderr.includes(alias),
      `the failure must name the ${alias} alias, got: ${stderr}`,
    );
  }
});

test('a fixture whose nix.extraOptions only holds comments and blank lines still passes', () => {
  const report = fixtureReport(`{
    nix.extraOptions = ''
      # the public cache policy is fixed

    '';
  }`);

  assert.deepStrictEqual(uniqueSorted(report.substituters), uniqueSorted(publicSubstituters));
  assert.deepStrictEqual(uniqueSorted(report.trustedPublicKeys), uniqueSorted(publicTrustedPublicKeys));
});
