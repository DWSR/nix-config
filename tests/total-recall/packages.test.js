'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const overlayPath = path.join(repoRoot, 'overlays/total-recall.nix');

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600_000,
    },
  ));
}

const packagesExpr = `
  let
    flake = builtins.getFlake (toString ${repoRoot});
    pkgs = flake.nixosConfigurations.fabro-vm.pkgs;
    upstream = flake.inputs.total-recall.packages.aarch64-linux;
    # Keep the evaluation total so a missing overlay surfaces as a failed
    # assertion naming the missing attribute instead of an evaluation error.
    get = name: if builtins.hasAttr name pkgs then builtins.getAttr name pkgs else null;
    pin = drv:
      if drv == null then null
      else {
        name = drv.name or "";
        pname = drv.pname or "";
        version = drv.version or "";
        mainProgram = drv.meta.mainProgram or "";
        srcUrl = drv.src.url or "";
        srcHash = drv.src.outputHash or "";
      };
    aliasMatches = local: remote:
      local != null
      && builtins.hasAttr remote upstream
      && local.drvPath == (builtins.getAttr remote upstream).drvPath;
  in
  {
    iii = pin (get "total-recall-iii");
    database = pin (get "total-recall-database");
    queue = pin (get "total-recall-queue");
    cron = pin (get "total-recall-cron");
    aliases = {
      harness-ingestion =
        aliasMatches (get "total-recall-harness-ingestion") "harness-ingestion";
      harness-event-persistence =
        aliasMatches (get "total-recall-harness-event-persistence") "harness-event-persistence";
      session-post-processing =
        aliasMatches (get "total-recall-session-post-processing") "session-post-processing";
      opencode-plugin =
        aliasMatches (get "total-recall-opencode-plugin") "opencode-harness-events";
      pi-extension =
        aliasMatches (get "total-recall-pi-extension") "pi-harness-events";
      mcp-worker =
        aliasMatches (get "total-recall-mcp-worker") "mcp-worker";
    };
  }
`;

const packages = nixEvalJson(packagesExpr);

const expectedPackages = [
  { key: 'iii', pname: 'total-recall-iii', version: '0.24.0', mainProgram: 'iii' },
  { key: 'database', pname: 'total-recall-database', version: '0.5.26', mainProgram: 'database' },
  { key: 'queue', pname: 'total-recall-queue', version: '0.21.26', mainProgram: 'queue' },
  { key: 'cron', pname: 'total-recall-cron', version: '0.21.28', mainProgram: 'cron' },
];

const expectedSources = {
  iii: {
    url: 'https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz',
    hash: 'sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=',
  },
  database: {
    url: 'https://cdn.iii.cloud/workers/database/0.5.26/database-aarch64-unknown-linux-gnu.tar.gz',
    hashPattern: /^sha256-[A-Za-z0-9+/]+=*$/,
  },
  queue: {
    url: 'https://cdn.iii.cloud/workers/queue/0.21.26/queue-aarch64-unknown-linux-gnu.tar.gz',
    hashPattern: /^sha256-[A-Za-z0-9+/]+=*$/,
  },
  cron: {
    url: 'https://cdn.iii.cloud/workers/cron/0.21.28/cron-aarch64-unknown-linux-gnu.tar.gz',
    hashPattern: /^sha256-[A-Za-z0-9+/]+=*$/,
  },
};

test('pins the iii runtime and registry worker versions from research.md', () => {
  const mismatches = [];

  for (const { key, pname, version, mainProgram } of expectedPackages) {
    const actual = packages[key];
    if (!actual) {
      mismatches.push(
        `${key}: expected ${pname}@${version} (mainProgram ${mainProgram}), but the package is missing`,
      );
      continue;
    }
    if (actual.pname !== pname) {
      mismatches.push(`${key}.pname: expected ${pname}, got ${actual.pname}`);
    }
    if (actual.version !== version) {
      mismatches.push(`${key}.version: expected ${version}, got ${actual.version}`);
    }
    if (actual.mainProgram !== mainProgram) {
      mismatches.push(`${key}.mainProgram: expected ${mainProgram}, got ${actual.mainProgram}`);
    }
  }

  assert.deepEqual(mismatches, []);
});

test('fetches every prebuilt artifact from a fixed-hash archive URL', () => {
  const mismatches = [];

  for (const [key, expected] of Object.entries(expectedSources)) {
    const actual = packages[key];
    if (!actual) {
      mismatches.push(`${key}: expected fixed-hash source ${expected.url}, but the package is missing`);
      continue;
    }
    if (actual.srcUrl !== expected.url) {
      mismatches.push(`${key}.srcUrl: expected ${expected.url}, got ${actual.srcUrl}`);
    }
    if (expected.hash) {
      if (actual.srcHash !== expected.hash) {
        mismatches.push(`${key}.srcHash: expected ${expected.hash}, got ${actual.srcHash}`);
      }
    } else if (!expected.hashPattern.test(actual.srcHash)) {
      mismatches.push(`${key}.srcHash: ${actual.srcHash} is not a fixed sha256 hash`);
    }
  }

  assert.deepEqual(mismatches, []);
});

test('re-exports the upstream workers and adapters under the C1 names', () => {
  const mismatches = Object.entries(packages.aliases)
    .filter(([, matches]) => matches !== true)
    .map(([name]) => `total-recall-${name} must resolve to the upstream package`);

  assert.deepEqual(mismatches, []);
});

test('uses fixed-hash fetchurl sources with no build-time registry or fallback lookup', () => {
  assert.ok(
    fs.existsSync(overlayPath),
    'overlays/total-recall.nix must declare the pinned package overlay',
  );
  const overlay = fs.readFileSync(overlayPath, 'utf8');

  assert.match(overlay, /final\.fetchurl/);
  assert.equal((overlay.match(/\bhash = "sha256-/g) ?? []).length, 5);
  assert.doesNotMatch(overlay, /\bfetchTarball\b/);
  assert.doesNotMatch(overlay, /\bbuiltins\.fetch(Url|Git|Tarball)\b/);
  assert.doesNotMatch(overlay, /workers\.iii\.dev\/api/);
});
