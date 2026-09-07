'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

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

function runImporter(sourcePath, args = []) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--expose-gc', importerPath, '--source', sourcePath, '--json', ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_PATH: dependencyNodePath() },
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    },
  );
}

function runDryRun(sourcePath) {
  return runImporter(sourcePath, ['--dry-run']);
}

function runImporterAsync(sourcePath, args = []) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', '--expose-gc', importerPath, '--source', sourcePath, '--json', ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, NODE_PATH: dependencyNodePath() },
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function startMockAgentMemory({ failOnce = false } = {}) {
  const requests = [];
  const stored = {
    sessions: new Map(),
    observations: new Map(),
    summaries: new Map(),
  };
  let failed = false;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks);
      let payload;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }

      const exportData = payload.exportData;
      const observations = Object.values(exportData.observations || {}).flat();
      const records = [
        ...exportData.sessions.map((record) => ({ type: 'sessions', record })),
        ...observations.map((record) => ({ type: 'observations', record })),
        ...exportData.summaries.map((record) => ({ type: 'summaries', record })),
      ];
      requests.push({ raw, payload, records });

      if (
        failOnce
        && !failed
        && records.some(({ record }) => record.narrative === 'This batch must fail once.')
      ) {
        failed = true;
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture batch failure' }));
        return;
      }

      const counts = { sessions: 0, observations: 0, summaries: 0, skipped: 0 };
      for (const { type, record } of records) {
        const store = stored[type];
        const key = type === 'summaries'
          ? record.sessionId
          : type === 'observations'
            ? `${record.sessionId}:${record.id}`
            : record.id;
        if (store.has(key)) {
          counts.skipped += 1;
        } else {
          store.set(key, record);
          counts[type] += 1;
        }
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ success: true, strategy: 'skip', ...counts }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stored,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
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

test('reports one malformed observation when multiple fields in one row are invalid', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-import-malformed-row-'));
  const sourcePath = path.join(directory, 'data.db');
  createCavememImportFixture(sourcePath);
  execFileSync('sqlite3', [sourcePath], {
    input: `
      INSERT INTO observations (session_id, kind, content, compressed, intensity, ts, metadata)
      VALUES ('opencode-session', 'response', 'Multiple malformed fields.', 0, NULL,
        'not-a-timestamp', '{"broken":true');
    `,
  });

  try {
    const result = runDryRun(sourcePath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    assert.equal(report.malformed.observations, 2);
    assert.equal(report.selected.observations, 5);
    assert.ok(!report.records.some((record) => record.narrative === 'Multiple malformed fields.'));
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

test('imports deterministic standard batches, reports failures, and continues', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-import-http-'));
  const sourcePath = path.join(directory, 'data.db');
  createCavememImportFixture(sourcePath, { extended: true });
  const mock = await startMockAgentMemory({ failOnce: true });

  try {
    const result = await runImporterAsync(sourcePath, [
      '--url',
      mock.url,
      '--batch-bytes',
      '1000',
    ]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    assert.equal(report.dryRun, false);
    assert.deepEqual(report.selected, { sessions: 4, observations: 7, summaries: 4 });
    assert.deepEqual(report.target, { sessions: 4, observations: 7, summaries: 4 });
    assert.deepEqual(report.imported, { sessions: 4, observations: 6, summaries: 4 });
    assert.deepEqual(report.existing, { sessions: 0, observations: 0, summaries: 0 });
    assert.deepEqual(report.skipped, { sessions: 3, observations: 4, summaries: 3 });
    assert.deepEqual(report.malformed, { sessions: 1, observations: 2, summaries: 0 });
    assert.deepEqual(report.failed, { sessions: 0, observations: 1, summaries: 0 });
    assert.equal(report.batches.failed, 1);
    assert.ok(report.batches.submitted > report.batches.failed);
    assert.ok(report.batches.sizes.every((size) => size < 8 * 1024 * 1024));
    assert.ok(mock.requests.some(({ payload }) => payload.strategy === 'skip'));
    assert.ok(mock.requests.every(({ payload }) => payload.exportData.version === '0.9.29'));
    assert.ok(mock.requests.every(({ records }) => records.length > 0));
    assert.ok(mock.requests.some(({ records }) => records.some(({ record }) => record.narrative === 'This row follows the failed batch.')));
    assert.ok(mock.requests.every(({ records }) => records.every(({ type }) => type === records[0].type)));
    assert.deepEqual(
      mock.requests.map(({ raw }) => raw.byteLength),
      report.batches.sizes,
    );
    const importedObservations = mock.requests
      .flatMap(({ records }) => records)
      .filter(({ type }) => type === 'observations');
    const standardObservationTypes = new Set([
      'file_read',
      'file_write',
      'file_edit',
      'command_run',
      'search',
      'web_fetch',
      'conversation',
      'error',
      'decision',
      'discovery',
      'subagent',
      'notification',
      'task',
      'image',
      'other',
    ]);
    assert.ok(importedObservations.every(({ record }) => standardObservationTypes.has(record.type)));
    const importedPrompt = importedObservations.find(({ record }) => (
      record.narrative === 'Inspect the unknown session.'
    ));
    assert.equal(importedPrompt.record.type, 'conversation');
    assert.match(importedPrompt.record.origin.detail, /source kind prompt/);
    assert.ok(importedObservations.every(({ record }) => record.origin.channel === 'import'));
    const importedSummaries = mock.requests
      .flatMap(({ records }) => records)
      .filter(({ type }) => type === 'summaries');
    assert.equal(importedSummaries.length, 4);
    assert.ok(importedSummaries.every(({ record }) => record.origin.channel === 'import'));
    assert.ok(mock.requests.every(({ raw }) => raw.byteLength < 8 * 1024 * 1024));

    const dryRun = JSON.parse(runDryRun(sourcePath).stdout);
    const ids = dryRun.records.map((record) => record.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.deepEqual(ids, JSON.parse(runDryRun(sourcePath).stdout).records.map((record) => record.id));
    assert.ok(ids.every((id) => id.startsWith('cavemem:')));

    const rerun = await runImporterAsync(sourcePath, [
      '--url',
      mock.url,
      '--batch-bytes',
      '1000',
    ]);
    assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
    const rerunReport = JSON.parse(rerun.stdout);
    assert.deepEqual(rerunReport.imported, { sessions: 0, observations: 1, summaries: 0 });
    assert.deepEqual(rerunReport.existing, { sessions: 4, observations: 6, summaries: 4 });
    assert.deepEqual(rerunReport.failed, { sessions: 0, observations: 0, summaries: 0 });
  } finally {
    await mock.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('merges source summaries into one deterministic target per session', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-import-summary-'));
  const sourcePath = path.join(directory, 'data.db');
  createCavememImportFixture(sourcePath, { duplicateSummary: true });
  const mock = await startMockAgentMemory();

  try {
    const result = await runImporterAsync(sourcePath, ['--url', mock.url]);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);

    assert.equal(report.selected.summaries, 5);
    assert.deepEqual(report.target, { sessions: 4, observations: 5, summaries: 4 });
    assert.equal(report.imported.summaries, 4);
    assert.equal(report.existing.summaries, 0);
    const summaries = mock.requests
      .flatMap(({ records }) => records)
      .filter(({ type }) => type === 'summaries')
      .map(({ record }) => record);
    assert.equal(summaries.length, 4);
    assert.ok(summaries.every((record) => (
      record.sessionId.startsWith('cavemem:session:')
      && record.origin.channel === 'import'
    )));
    assert.deepEqual(
      summaries.flatMap((record) => record.sourceSummaryIds).sort(),
      [
        'cavemem:summaries:ambiguous-session:4',
        'cavemem:summaries:malformed-session:3',
        'cavemem:summaries:opencode-session:1',
        'cavemem:summaries:unknown-session:2',
        'cavemem:summaries:unknown-session:8',
      ],
    );
    const unknownSummary = summaries.find((record) => (
      record.sessionId === 'cavemem:session:unknown-session'
    ));
    assert.deepEqual(unknownSummary.sourceSummaryIds, [
      'cavemem:summaries:unknown-session:2',
      'cavemem:summaries:unknown-session:8',
    ]);
    assert.deepEqual(unknownSummary.sourceSummaries.map(({ id, narrative }) => ({ id, narrative })), [
      {
        id: 'cavemem:summaries:unknown-session:2',
        narrative: 'Mystery session summary.',
      },
      {
        id: 'cavemem:summaries:unknown-session:8',
        narrative: 'Mystery turn summary.',
      },
    ]);
    assert.deepEqual(
      summaries.flatMap((record) => record.sourceSummaries.map(({ narrative }) => narrative)).sort(),
      [
        'Alpha session summary.',
        'Ambiguous session summary.',
        'Broken session summary.',
        'Mystery session summary.',
        'Mystery turn summary.',
      ],
    );
    assert.equal(mock.stored.summaries.size, 4);
    assert.equal(
      mock.stored.summaries.get('cavemem:session:unknown-session').id,
      'cavemem:summary:unknown-session',
    );

    const rerun = await runImporterAsync(sourcePath, ['--url', mock.url]);
    assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
    const rerunReport = JSON.parse(rerun.stdout);
    assert.deepEqual(rerunReport.target, { sessions: 4, observations: 5, summaries: 4 });
    assert.equal(rerunReport.imported.summaries, 0);
    assert.equal(rerunReport.existing.summaries, 4);
  } finally {
    await mock.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
