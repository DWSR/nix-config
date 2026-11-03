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
    pin = name: drv: {
      name = drv.name or "";
      pname = drv.pname or "";
      version = drv.version or "";
      mainProgram = drv.meta.mainProgram or "";
      srcUrl = drv.src.url or "";
      srcHash = drv.src.outputHash or "";
    };
  in
  {
    iii = pin "iii" pkgs.total-recall-iii;
    database = pin "database" pkgs.total-recall-database;
    queue = pin "queue" pkgs.total-recall-queue;
    cron = pin "cron" pkgs.total-recall-cron;
    aliases = {
      harness-ingestion =
        pkgs.total-recall-harness-ingestion.drvPath
        == upstream.harness-ingestion.drvPath;
      harness-event-persistence =
        pkgs.total-recall-harness-event-persistence.drvPath
        == upstream.harness-event-persistence.drvPath;
      session-post-processing =
        pkgs.total-recall-session-post-processing.drvPath
        == upstream.session-post-processing.drvPath;
      opencode-plugin =
        pkgs.total-recall-opencode-plugin.drvPath
        == upstream.opencode-harness-events.drvPath;
      pi-extension =
        pkgs.total-recall-pi-extension.drvPath
        == upstream.pi-harness-events.drvPath;
      mcp-worker =
        pkgs.total-recall-mcp-worker.drvPath
        == upstream.mcp-worker.drvPath;
    };
  }
`;

const packages = nixEvalJson(packagesExpr);

test('pins the iii runtime and registry worker versions from research.md', () => {
  assert.equal(packages.iii.pname, 'total-recall-iii');
  assert.equal(packages.iii.version, '0.24.0');
  assert.equal(packages.iii.mainProgram, 'iii');

  assert.equal(packages.database.pname, 'total-recall-database');
  assert.equal(packages.database.version, '0.5.26');
  assert.equal(packages.database.mainProgram, 'database');

  assert.equal(packages.queue.pname, 'total-recall-queue');
  assert.equal(packages.queue.version, '0.21.26');
  assert.equal(packages.queue.mainProgram, 'queue');

  assert.equal(packages.cron.pname, 'total-recall-cron');
  assert.equal(packages.cron.version, '0.21.28');
  assert.equal(packages.cron.mainProgram, 'cron');
});

test('fetches every prebuilt artifact from a fixed-hash archive URL', () => {
  assert.equal(
    packages.iii.srcUrl,
    'https://github.com/iii-hq/iii/releases/download/iii%2Fv0.24.0/iii-aarch64-unknown-linux-gnu.tar.gz',
  );
  assert.equal(
    packages.iii.srcHash,
    'sha256-YI8a0WM0jngYpV94ShHi7+KwPYE1MquWokMhHEJ57zA=',
  );

  for (const [name, version] of [
    ['database', '0.5.26'],
    ['queue', '0.21.26'],
    ['cron', '0.21.28'],
  ]) {
    assert.equal(
      packages[name].srcUrl,
      `https://cdn.iii.cloud/workers/${name}/${version}/${name}-aarch64-unknown-linux-gnu.tar.gz`,
    );
    assert.match(packages[name].srcHash, /^sha256-[A-Za-z0-9+/]+=*$/);
  }
});

test('re-exports the upstream workers and adapters under the C1 names', () => {
  for (const [name, matches] of Object.entries(packages.aliases)) {
    assert.equal(matches, true, `total-recall-${name} must resolve to the upstream package`);
  }
});

test('uses fixed-hash fetchurl sources with no build-time registry or fallback lookup', () => {
  const overlay = fs.readFileSync(overlayPath, 'utf8');

  assert.match(overlay, /final\.fetchurl/);
  assert.equal((overlay.match(/\bhash = "sha256-/g) ?? []).length, 5);
  assert.doesNotMatch(overlay, /\bfetchTarball\b/);
  assert.doesNotMatch(overlay, /\bbuiltins\.fetch(Url|Git|Tarball)\b/);
  assert.doesNotMatch(overlay, /workers\.iii\.dev\/api/);
});
