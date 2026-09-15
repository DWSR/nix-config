'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const importerPath = path.join(repoRoot, 'scripts', 'agentmemory-import-obsidian.ts');

function runDiscovery(vaultPath) {
  const script = `
    const { discoverSourceNotes } = require(${JSON.stringify(importerPath)});
    try {
      const result = discoverSourceNotes(${JSON.stringify(vaultPath)});
      process.stdout.write(JSON.stringify({
        sourcePath: result.sourcePath,
        discovered: result.discovered,
        notes: result.notes.map(({ relativePath, bytes, metadata }) => ({
          relativePath,
          bytes: bytes.toString('utf8'),
          metadata,
        })),
        skipped: result.skipped,
      }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    },
  );
}

function snapshotTree(root) {
  const entries = [];
  const visit = (currentPath) => {
    for (const name of fs.readdirSync(currentPath).sort()) {
      const entryPath = path.join(currentPath, name);
      const relativePath = path.relative(root, entryPath);
      const metadata = fs.lstatSync(entryPath);
      const entry = {
        relativePath,
        mode: metadata.mode,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        birthtimeMs: metadata.birthtimeMs,
        dev: metadata.dev,
        ino: metadata.ino,
        nlink: metadata.nlink,
      };
      if (metadata.isSymbolicLink()) {
        entry.link = fs.readlinkSync(entryPath);
      } else if (metadata.isDirectory()) {
        visit(entryPath);
      } else if (metadata.isFile()) {
        entry.digest = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
      }
      entries.push(entry);
    }
  };
  visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function snapshotEntry(entryPath) {
  const metadata = fs.lstatSync(entryPath);
  const entry = {
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    birthtimeMs: metadata.birthtimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
  };
  if (metadata.isSymbolicLink()) entry.link = fs.readlinkSync(entryPath);
  if (metadata.isFile()) {
    entry.digest = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
  }
  return entry;
}

function createVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-source-'));
  fs.mkdirSync(path.join(root, 'memories'));
  return root;
}

test('selects sorted direct Markdown children and excludes nested or unrelated files', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  fs.writeFileSync(path.join(memoriesPath, '2026-01-b.md'), '# B\n\nB body\n');
  fs.writeFileSync(path.join(memoriesPath, '2026-01-a.md'), '# A\n\nA body\n');
  fs.writeFileSync(path.join(memoriesPath, 'attachment.txt'), 'not a note\n');
  fs.mkdirSync(path.join(memoriesPath, 'nested'));
  fs.writeFileSync(path.join(memoriesPath, 'nested', '2026-01-nested.md'), '# Nested\n');
  const before = snapshotTree(vaultPath);

  try {
    const result = runDiscovery(vaultPath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.discovered, 2);
    assert.deepEqual(
      report.notes.map(({ relativePath }) => relativePath),
      ['memories/2026-01-a.md', 'memories/2026-01-b.md'],
    );
    assert.deepEqual(
      report.notes.map(({ bytes }) => bytes),
      ['# A\n\nA body\n', '# B\n\nB body\n'],
    );
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(snapshotTree(vaultPath), before);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('reports non-regular entries and in-tree or escaping symlinks without reading targets', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const outsidePath = path.join(path.dirname(vaultPath), 'agentmemory-obsidian-outside.md');
  fs.writeFileSync(path.join(memoriesPath, 'valid.md'), '# Valid\n');
  fs.writeFileSync(path.join(memoriesPath, 'inside-target.md'), '# Inside target\n');
  fs.mkdirSync(path.join(memoriesPath, 'directory.md'));
  fs.writeFileSync(path.join(memoriesPath, 'directory.md', 'nested.md'), '# Nested\n');
  fs.symlinkSync('inside-target.md', path.join(memoriesPath, 'inside-link.md'));
  fs.writeFileSync(outsidePath, '# Outside target\n');
  fs.symlinkSync(outsidePath, path.join(memoriesPath, 'escaping-link.md'));
  const before = snapshotTree(vaultPath);
  const outsideBefore = snapshotEntry(outsidePath);

  try {
    const result = runDiscovery(vaultPath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.notes.map(({ relativePath }) => relativePath),
      ['memories/inside-target.md', 'memories/valid.md'],
    );
    assert.deepEqual(
      report.skipped.map(({ relativePath }) => relativePath),
      ['memories/directory.md', 'memories/escaping-link.md', 'memories/inside-link.md'],
    );
    assert.equal(report.skipped.find(({ relativePath }) => relativePath.endsWith('directory.md')).reason, 'non-regular entry');
    assert.equal(report.skipped.find(({ relativePath }) => relativePath.endsWith('inside-link.md')).reason, 'symlink');
    assert.equal(
      report.skipped.find(({ relativePath }) => relativePath.endsWith('escaping-link.md')).reason,
      'path escapes memories directory',
    );
    assert.deepEqual(snapshotTree(vaultPath), before);
    assert.deepEqual(snapshotEntry(outsidePath), outsideBefore);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  }
});

test('rejects relative and missing roots before source or target access', () => {
  const relative = runDiscovery('relative-vault');
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /vault path must be absolute/);

  const missingPath = path.join(os.tmpdir(), `agentmemory-obsidian-missing-${process.pid}`);
  fs.rmSync(missingPath, { recursive: true, force: true });
  const missing = runDiscovery(missingPath);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /vault path does not exist/);

  const missingMemoriesVault = createVault();
  fs.rmSync(path.join(missingMemoriesVault, 'memories'), { recursive: true, force: true });
  try {
    const missingMemories = runDiscovery(missingMemoriesVault);
    assert.equal(missingMemories.status, 1);
    assert.match(missingMemories.stderr, /memories directory does not exist/);
  } finally {
    fs.rmSync(missingMemoriesVault, { recursive: true, force: true });
  }

  const unreadableVault = createVault();
  const unreadableSource = path.join(unreadableVault, 'memories', 'source.md');
  fs.writeFileSync(unreadableSource, '# Source\n');
  const sourceBefore = snapshotEntry(unreadableSource);
  const originalMode = fs.statSync(unreadableVault).mode;
  fs.chmodSync(unreadableVault, 0o000);
  try {
    const unreadable = runDiscovery(unreadableVault);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /vault path is not readable/);
  } finally {
    fs.chmodSync(unreadableVault, originalMode);
    assert.deepEqual(snapshotEntry(unreadableSource), sourceBefore);
    fs.rmSync(unreadableVault, { recursive: true, force: true });
  }
});

test('rejects an unreadable memories root without changing its metadata', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const sourcePath = path.join(memoriesPath, 'source.md');
  fs.writeFileSync(sourcePath, '# Source\n');
  const sourceBefore = snapshotEntry(sourcePath);
  const originalMode = fs.statSync(memoriesPath).mode;
  fs.chmodSync(memoriesPath, 0o000);
  const inaccessibleRootBefore = snapshotEntry(memoriesPath);

  try {
    let result;
    try {
      result = runDiscovery(vaultPath);
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /memories directory is not readable/);
      assert.deepEqual(snapshotEntry(memoriesPath), inaccessibleRootBefore);
    } finally {
      fs.chmodSync(memoriesPath, originalMode);
    }
    assert.deepEqual(snapshotEntry(sourcePath), sourceBefore);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
