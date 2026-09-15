'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const importerPath = path.join(repoRoot, 'scripts', 'agentmemory-import-obsidian.ts');
let cachedDependencyNodePath;
let cachedImporterNodeBin;

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

function importerEnvironment() {
  const nodePaths = [
    process.env.NODE_PATH,
    process.env.AGENTMEMORY_IMPORTER_NODE_PATH,
    dependencyNodePath(),
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(path.delimiter));
  return nodePaths.length > 0
    ? { ...process.env, NODE_PATH: [...new Set(nodePaths)].join(path.delimiter) }
    : process.env;
}

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

function importerNodeBin() {
  if (cachedImporterNodeBin) return cachedImporterNodeBin;
  const configured = process.env.AGENTMEMORY_IMPORTER_NODE_BIN;
  if (configured) {
    cachedImporterNodeBin = configured;
    return cachedImporterNodeBin;
  }
  const nodePackage = execFileSync(
    'nix',
    ['eval', '--raw', '.#darwinConfigurations.ShopifyLaptop.pkgs.nodejs_22'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  cachedImporterNodeBin = path.join(nodePackage, 'bin', 'node');
  return cachedImporterNodeBin;
}

function runMapping(vaultPath, capturedAt = '2026-09-15T01:00:00.000Z') {
  const script = `
    const { discoverSourceNotes, mapSourceNotes } = require(${JSON.stringify(importerPath)});
    try {
      const discovery = discoverSourceNotes(${JSON.stringify(vaultPath)});
      const outcomes = mapSourceNotes(discovery.notes, ${JSON.stringify(capturedAt)});
      process.stdout.write(JSON.stringify({ outcomes }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(
    importerNodeBin(),
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: importerEnvironment(),
      encoding: 'utf8',
    },
  );
}

function readMapping(vaultPath) {
  const result = runMapping(vaultPath);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function assertRuntimeMemory(memory) {
  assert.equal(typeof memory.id, 'string');
  assert.match(memory.id, /^mem_obsidian_[0-9a-f]{64}$/);
  assert.match(memory.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(memory.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof memory.type, 'string');
  assert.equal(typeof memory.title, 'string');
  assert.equal(typeof memory.content, 'string');
  assert.ok(Array.isArray(memory.concepts));
  assert.ok(Array.isArray(memory.files));
  assert.ok(Array.isArray(memory.sessionIds));
  assert.equal(memory.strength, 1);
  assert.equal(memory.version, 1);
  assert.equal(memory.isLatest, true);
  assert.equal(memory.origin.channel, 'import');
  assert.equal(typeof memory.origin.detail, 'string');
  assert.match(memory.origin.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
}

function validateMemory(memory) {
  const script = `
    const { isImportedMemory } = require(${JSON.stringify(importerPath)});
    const memory = ${JSON.stringify(memory)};
    process.stdout.write(JSON.stringify({ valid: isImportedMemory(memory) }));
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

test('maps canonical notes to complete memories with searchable provenance and exact bodies', () => {
  const vaultPath = createVault();
  const notePath = path.join(vaultPath, 'memories', '2026-05-13-canonical.md');
  const body = '# Canonical migration memory\n\nCurated credential: keep-this-body\n';
  fs.writeFileSync(notePath, [
    '---',
    'date: 2026-05-13',
    'project: agentmemory-enhancements',
    'tags:',
    '  - memory',
    '  - architecture',
    '  - agentmemory-enhancements',
    '  - architecture',
    'sessions:',
    '  - 2026-05-13T143022',
    '  - legacy-session-2',
    'ignored: true',
    '---',
    body,
  ].join('\n'));

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].kind, 'prepared');
    const memory = report.outcomes[0].memory;
    assertRuntimeMemory(memory);

    const sourcePath = 'memories/2026-05-13-canonical.md';
    const expectedId = `mem_obsidian_${crypto.createHash('sha256').update(sourcePath).digest('hex')}`;
    assert.equal(memory.id, expectedId);
    assert.equal(memory.createdAt, '2026-05-13T00:00:00.000Z');
    assert.equal(memory.updatedAt, memory.createdAt);
    assert.equal(memory.type, 'architecture');
    assert.equal(memory.title, 'Canonical migration memory');
    assert.equal(memory.content, body);
    assert.deepEqual(memory.concepts, [
      'architecture',
      'obsidian-source:memories/2026-05-13-canonical.md',
    ]);
    assert.deepEqual(memory.files, [sourcePath]);
    assert.deepEqual(memory.sessionIds, []);
    assert.equal(memory.project, 'agentmemory-enhancements');
    assert.equal(memory.origin.capturedAt, '2026-09-15T01:00:00.000Z');
    assert.deepEqual(JSON.parse(memory.origin.detail), {
      sourcePath,
      tags: ['memory', 'architecture', 'agentmemory-enhancements', 'architecture'],
      sessions: ['2026-05-13T143022', 'legacy-session-2'],
    });
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('maps frontmatter-free notes through filename and mtime fallbacks without changing body bytes', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const filenameDatePath = path.join(memoriesPath, '2026-06-07-fallback.md');
  const filenameDateBody = 'plain body with CRLF\r\n\r\nbody with CRLF\r\n';
  fs.writeFileSync(filenameDatePath, filenameDateBody);
  const mtimePath = path.join(memoriesPath, 'legacy-note.md');
  const mtimeBody = 'plain legacy body\n';
  fs.writeFileSync(mtimePath, mtimeBody);
  const expectedMtime = new Date('2024-02-03T04:05:06.000Z');
  fs.utimesSync(mtimePath, expectedMtime, expectedMtime);

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, 2);
    const byPath = new Map(report.outcomes.map((outcome) => [outcome.relativePath, outcome]));
    const filenameDate = byPath.get('memories/2026-06-07-fallback.md');
    const mtime = byPath.get('memories/legacy-note.md');
    assert.equal(filenameDate.kind, 'prepared');
    assert.equal(mtime.kind, 'prepared');
    assertRuntimeMemory(filenameDate.memory);
    assertRuntimeMemory(mtime.memory);

    assert.equal(filenameDate.memory.title, '2026-06-07-fallback');
    assert.equal(filenameDate.memory.createdAt, '2026-06-07T00:00:00.000Z');
    assert.equal(filenameDate.memory.type, 'fact');
    assert.equal(filenameDate.memory.content, filenameDateBody);
    assert.deepEqual(filenameDate.memory.concepts, [
      'obsidian-source:memories/2026-06-07-fallback.md',
    ]);
    assert.equal(filenameDate.memory.project, undefined);

    assert.equal(mtime.memory.title, 'legacy-note');
    assert.equal(mtime.memory.createdAt, expectedMtime.toISOString());
    assert.equal(mtime.memory.updatedAt, expectedMtime.toISOString());
    assert.equal(mtime.memory.content, mtimeBody);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('strictly validates timestamp components while accepting valid ISO forms', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const fixtures = {
    'quoted-invalid-timestamp.md': '2026-02-29T00:00:00Z',
    'invalid-time-timestamp.md': '2026-05-13T24:00:00Z',
    'invalid-minute-timestamp.md': '2026-05-13T23:60:00Z',
    'valid-z-timestamp.md': '2026-05-13T14:30:22Z',
    'valid-offset-timestamp.md': '2026-05-13T14:30:22.123-04:00',
    'valid-minute-timestamp.md': '2026-05-13T14:30Z',
  };
  for (const [name, timestamp] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(memoriesPath, name), [
      '---',
      `date: ${JSON.stringify(timestamp)}`,
      '---',
      `# ${name}`,
      '',
      'timestamp body',
      '',
    ].join('\n'));
  }

  try {
    const report = readMapping(vaultPath);
    const byPath = new Map(report.outcomes.map((outcome) => [outcome.relativePath, outcome]));
    for (const name of [
      'quoted-invalid-timestamp.md',
      'invalid-time-timestamp.md',
      'invalid-minute-timestamp.md',
    ]) {
      const outcome = byPath.get(`memories/${name}`);
      assert.equal(outcome.kind, 'skipped', name);
      assert.match(outcome.reason, /date/i, name);
    }

    const expectedTimestamps = {
      'valid-z-timestamp.md': '2026-05-13T14:30:22.000Z',
      'valid-offset-timestamp.md': '2026-05-13T18:30:22.123Z',
      'valid-minute-timestamp.md': '2026-05-13T14:30:00.000Z',
    };
    for (const [name, expectedTimestamp] of Object.entries(expectedTimestamps)) {
      const outcome = byPath.get(`memories/${name}`);
      assert.equal(outcome.kind, 'prepared', name);
      assertRuntimeMemory(outcome.memory);
      assert.equal(outcome.memory.createdAt, expectedTimestamp, name);
      assert.equal(outcome.memory.updatedAt, expectedTimestamp, name);
    }
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('reports malformed frontmatter types, delimiters, and empty bodies as mapping skips', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const fixtures = {
    'broken-delimiter.md': '---\nproject: example\n# missing closing delimiter\n',
    'invalid-yaml.md': '---\ntags: [unclosed\n---\nbody\n',
    'invalid-date.md': '---\ndate: 42\n---\nbody\n',
    'invalid-calendar-date.md': '---\ndate: 2026-02-29\n---\nbody\n',
    'invalid-project.md': '---\nproject:\n  - example\n---\nbody\n',
    'invalid-tags.md': '---\ntags: architecture\n---\nbody\n',
    'invalid-sessions.md': '---\nsessions: legacy-session\n---\nbody\n',
    'null-frontmatter.md': '---\nnull\n---\nbody\n',
    'empty-frontmatter.md': '---\n---\nbody\n',
    'scalar-frontmatter.md': '---\nplain scalar\n---\nbody\n',
    'empty-body.md': '---\nproject: example\n---\n \n\t\n',
  };
  for (const [name, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(memoriesPath, name), content);
  }

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, Object.keys(fixtures).length);
    const skipped = new Map(
      report.outcomes.map((outcome) => [outcome.relativePath, outcome]),
    );
    for (const name of Object.keys(fixtures)) {
      const outcome = skipped.get(`memories/${name}`);
      assert.equal(outcome.kind, 'skipped', name);
      assert.equal(outcome.relativePath, `memories/${name}`, name);
      assert.equal(typeof outcome.reason, 'string', name);
      assert.notEqual(outcome.reason.length, 0, name);
    }
    assert.match(skipped.get('memories/broken-delimiter.md').reason, /closing delimiter/i);
    assert.match(skipped.get('memories/invalid-yaml.md').reason, /yaml/i);
    assert.match(skipped.get('memories/invalid-date.md').reason, /date/i);
    assert.match(skipped.get('memories/invalid-calendar-date.md').reason, /date/i);
    assert.match(skipped.get('memories/invalid-project.md').reason, /project/i);
    assert.match(skipped.get('memories/invalid-tags.md').reason, /tags/i);
    assert.match(skipped.get('memories/invalid-sessions.md').reason, /sessions/i);
    assert.match(skipped.get('memories/null-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/empty-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/scalar-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/empty-body.md').reason, /empty body/i);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('runtime validation rejects records that violate importer invariants', () => {
  const vaultPath = createVault();
  const notePath = path.join(vaultPath, 'memories', 'guard.md');
  fs.writeFileSync(notePath, '# Guard\n\nValid body\n');

  try {
    const memory = readMapping(vaultPath).outcomes[0].memory;
    assertRuntimeMemory(memory);
    const validResult = validateMemory(memory);
    assert.equal(validResult.status, 0, `${validResult.stderr}\n${validResult.stdout}`);
    assert.deepEqual(JSON.parse(validResult.stdout), { valid: true });

    const mutations = {
      'non-normalized source path': (candidate) => {
        candidate.files[0] = 'memories/./guard.md';
        candidate.id = `mem_obsidian_${crypto.createHash('sha256').update(candidate.files[0]).digest('hex')}`;
        candidate.concepts = candidate.concepts.map(
          (concept) => concept.startsWith('obsidian-source:')
            ? `obsidian-source:${candidate.files[0]}`
            : concept,
        );
        const detail = JSON.parse(candidate.origin.detail);
        detail.sourcePath = candidate.files[0];
        candidate.origin.detail = JSON.stringify(detail);
      },
      'source identity mismatch': (candidate) => {
        candidate.id = `mem_obsidian_${'0'.repeat(64)}`;
      },
      'empty content': (candidate) => {
        candidate.content = ' \n\t';
      },
      'missing provenance concept': (candidate) => {
        candidate.concepts = candidate.concepts.filter(
          (concept) => !concept.startsWith('obsidian-source:'),
        );
      },
      'updated timestamp mismatch': (candidate) => {
        candidate.updatedAt = new Date(Date.parse(candidate.createdAt) + 1000).toISOString();
      },
    };

    for (const [label, mutate] of Object.entries(mutations)) {
      const candidate = JSON.parse(JSON.stringify(memory));
      mutate(candidate);
      const result = validateMemory(candidate);
      assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout), { valid: false }, label);
    }
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('keeps same-path identities across content changes and changes identity after rename', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const originalPath = path.join(memoriesPath, 'stable-path.md');
  fs.writeFileSync(originalPath, '# First body\n');

  try {
    const first = readMapping(vaultPath).outcomes[0].memory;
    fs.writeFileSync(originalPath, '# Changed body\n');
    const changed = readMapping(vaultPath).outcomes[0].memory;
    assert.equal(changed.id, first.id);
    assert.notEqual(changed.content, first.content);

    const renamedPath = path.join(memoriesPath, 'renamed-path.md');
    fs.renameSync(originalPath, renamedPath);
    const renamed = readMapping(vaultPath).outcomes[0].memory;
    assert.notEqual(renamed.id, changed.id);
    assert.deepEqual(renamed.files, ['memories/renamed-path.md']);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});
