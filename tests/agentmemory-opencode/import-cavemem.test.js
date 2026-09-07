'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { createCavememImportFixture } = require('./fixtures/cavemem-import-fixture.js');

const repoRoot = path.resolve(__dirname, '../..');
const importerPath = path.join(repoRoot, 'scripts', 'agentmemory-import-cavemem.ts');
let cachedDependencyNodePath;

function dependencyNodePath() {
  if (cachedDependencyNodePath) return cachedDependencyNodePath;
  const configured = process.env.AGENTMEMORY_IMPORTER_NODE_PATH;
  const dependencyRoot = configured || execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '.#darwinConfigurations.ShopifyLaptop.pkgs.cavemem-importer-deps',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
  cachedDependencyNodePath = dependencyRoot.endsWith('/lib/node_modules')
    ? dependencyRoot
    : path.join(dependencyRoot, 'lib', 'node_modules');
  return cachedDependencyNodePath;
}

function runDryRun(sourcePath) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', importerPath, '--source', sourcePath, '--dry-run', '--json'],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_PATH: dependencyNodePath() },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function digestDirectory(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    return {
      name,
      digest: fs.statSync(filePath).isFile()
        ? crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
        : null,
    };
  });
}

test('dry-run snapshots cavemem, filters only positive provenance, and emits import records', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-import-test-'));
  const sourcePath = path.join(directory, 'data.db');
  createCavememImportFixture(sourcePath);
  const sourceBefore = fs.readFileSync(sourcePath);
  const directoryBefore = digestDirectory(directory);

  try {
    const result = runDryRun(sourcePath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    assert.equal(report.dryRun, true);
    assert.deepEqual(report.selected, { sessions: 4, observations: 5, summaries: 4 });
    assert.deepEqual(report.skipped, { sessions: 3, observations: 4, summaries: 3 });
    assert.deepEqual(report.malformed, { sessions: 1, observations: 1, summaries: 0 });
    assert.deepEqual(report.skippedByReason.sessions, {
      pi: 1,
      'obsidian-migration': 1,
      importer: 1,
    });
    assert.equal(report.skippedByReason.observations.importer, 2);
    assert.equal(report.records.length, 9);
    assert.ok(report.records.every((record) => record.origin.channel === 'import'));
    assert.ok(report.records.some((record) => (
      record.sessionId === 'unknown-session' && record.type === 'prompt'
    )));
    assert.ok(report.records.some((record) => (
      record.sessionId === 'ambiguous-session' && record.narrative.includes('Do not discard')
    )));
    assert.deepEqual(
      report.sessions.skipped.map(({ id, reason }) => [id, reason]),
      [
        ['pi-session', 'pi'],
        ['obsidian-session', 'obsidian-migration'],
        ['imported-session', 'importer'],
      ],
    );
    assert.deepEqual(fs.readFileSync(sourcePath), sourceBefore);
    assert.deepEqual(digestDirectory(directory), directoryBefore);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('dry-run JSON is deterministic and does not contact AgentMemory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-import-determinism-'));
  const sourcePath = path.join(directory, 'data.db');
  createCavememImportFixture(sourcePath);

  try {
    const first = runDryRun(sourcePath);
    const second = runDryRun(sourcePath);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
    assert.equal(first.stdout, second.stdout);
    assert.equal(first.stderr, '');
    assert.equal(second.stderr, '');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
