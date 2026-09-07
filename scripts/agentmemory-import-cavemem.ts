#!/usr/bin/env node

/*
 * Read-only cavemem history inspection for the AgentMemory migration.
 *
 * This task deliberately stops before AgentMemory submission. The records in
 * the report are the handoff shape used by the later batching/import task.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

type SourceTable = 'sessions' | 'observations' | 'summaries';
type RecordTable = 'observations' | 'summaries';
type CountSet = Record<SourceTable, number>;

interface LegacyImportRecord {
  id: string;
  sessionId: string;
  project: string;
  timestamp: string;
  narrative: string;
  type: string;
  origin: { channel: 'import'; detail: string; capturedAt: string };
}

interface SnapshotReport {
  sourcePath: string;
  dryRun: true;
  selected: CountSet;
  skipped: CountSet;
  malformed: CountSet;
  skippedByReason: Record<SourceTable, Record<string, number>>;
  sessions: {
    selected: string[];
    skipped: Array<{ id: string; reason: string }>;
  };
  records: LegacyImportRecord[];
}

interface SessionRow {
  id: unknown;
  ide: unknown;
  cwd: unknown;
  started_at: unknown;
  ended_at: unknown;
  metadata: unknown;
}

interface ObservationRow {
  id: unknown;
  session_id: unknown;
  kind: unknown;
  content: unknown;
  ts: unknown;
  metadata: unknown;
}

interface SummaryRow {
  id: unknown;
  session_id: unknown;
  scope: unknown;
  content: unknown;
  ts: unknown;
}

interface SessionInfo {
  id: string;
  project: string;
  skipReason: string | null;
}

interface CliOptions {
  sourcePath: string | null;
  json: boolean;
  dryRun: boolean;
  help: boolean;
}

const IMPORTER_IDES = new Set([
  'agentmemory-import',
  'cavemem-import',
  'cavemem-importer',
  'import',
  'importer',
]);

function emptyCounts(): CountSet {
  return { sessions: 0, observations: 0, summaries: 0 };
}

function emptyReasons(): Record<SourceTable, Record<string, number>> {
  return { sessions: {}, observations: {}, summaries: {} };
}

function increment(counts: CountSet, table: SourceTable): void {
  counts[table] += 1;
}

function incrementReason(
  reasons: Record<SourceTable, Record<string, number>>,
  table: SourceTable,
  reason: string,
): void {
  reasons[table][reason] = (reasons[table][reason] || 0) + 1;
}

function parseObjectMetadata(
  value: unknown,
  table: SourceTable,
  malformed: CountSet,
): Record<string, unknown> {
  if (value === null || value === undefined || value === '') return {};
  if (typeof value !== 'string') {
    increment(malformed, table);
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('metadata is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch {
    increment(malformed, table);
    return {};
  }
}

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function timestampValue(value: unknown): string | null {
  const numberValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(numberValue) || numberValue < 0) {
    return null;
  }

  const timestamp = new Date(numberValue);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }
  return timestamp.toISOString();
}

function explicitImporterMarker(metadata: Record<string, unknown>): boolean {
  const markerKeys = [
    'importer',
    'imported',
    'imported_by',
    'importedBy',
    'importer_marker',
    'import_marker',
  ];
  for (const key of markerKeys) {
    const marker = metadata[key];
    if (
      marker === true
      || (
        typeof marker === 'string'
        && marker.trim() !== ''
        && !['0', 'false', 'no', 'none'].includes(marker.trim().toLowerCase())
      )
    ) return true;
  }

  const origin = metadata.origin;
  if (origin === 'import') return true;
  if (origin && typeof origin === 'object' && !Array.isArray(origin)) {
    const channel = (origin as Record<string, unknown>).channel;
    if (channel === 'import') return true;
  }

  // This is the metadata pair emitted by the existing vault importer. An
  // import hash alone is not enough because it is not source-identifying.
  return (
    typeof metadata.import_hash === 'string'
    && metadata.import_hash.trim() !== ''
    && typeof metadata.source_path === 'string'
    && metadata.source_path.trim() !== ''
  );
}

function classifySession(
  ide: unknown,
  metadata: Record<string, unknown>,
): string | null {
  const normalizedIde = typeof ide === 'string' ? ide.trim().toLowerCase() : '';
  if (normalizedIde === 'pi' || normalizedIde === 'pi-agent') return 'pi';
  if (normalizedIde === 'obsidian-migration') return 'obsidian-migration';
  if (IMPORTER_IDES.has(normalizedIde) || explicitImporterMarker(metadata)) return 'importer';
  return null;
}

function projectValue(cwd: unknown, metadata: Record<string, unknown>): string {
  if (typeof metadata.project === 'string' && metadata.project.trim() !== '') {
    return metadata.project;
  }
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    return path.basename(cwd) || 'unknown';
  }
  return 'unknown';
}

function rowId(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function sourceRecord(
  table: RecordTable,
  row: ObservationRow | SummaryRow,
  session: SessionInfo,
  timestamp: string,
): LegacyImportRecord | null {
  const id = rowId(row.id);
  const content = textValue(row.content);
  if (!id || !content) return null;

  const type = table === 'observations'
    ? textValue((row as ObservationRow).kind)
    : 'summary';
  if (!type) return null;

  return {
    id: `cavemem:${table}:${id}`,
    sessionId: session.id,
    project: session.project,
    timestamp,
    narrative: content,
    type,
    origin: {
      channel: 'import',
      detail: `cavemem ${table} row ${id} from session ${session.id}`,
      capturedAt: timestamp,
    },
  };
}

function requiredSessionInfo(
  row: SessionRow,
  malformed: CountSet,
): SessionInfo | null {
  const id = rowId(row.id);
  const startedAt = timestampValue(row.started_at);
  if (!id || startedAt === null || typeof row.ide !== 'string') {
    increment(malformed, 'sessions');
    return null;
  }

  const metadata = parseObjectMetadata(row.metadata, 'sessions', malformed);
  return {
    id,
    project: projectValue(row.cwd, metadata),
    skipReason: classifySession(row.ide, metadata),
  };
}

function hasTable(db: InstanceType<typeof Database>, table: SourceTable): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table));
}

function readFilteredSnapshot(
  db: InstanceType<typeof Database>,
  sourcePath: string,
): SnapshotReport {
  for (const table of ['sessions', 'observations', 'summaries'] as SourceTable[]) {
    if (!hasTable(db, table)) throw new Error(`cavemem snapshot is missing table: ${table}`);
  }

  const report: SnapshotReport = {
    sourcePath,
    dryRun: true,
    selected: emptyCounts(),
    skipped: emptyCounts(),
    malformed: emptyCounts(),
    skippedByReason: emptyReasons(),
    sessions: { selected: [], skipped: [] },
    records: [],
  };

  const sessions = db.prepare(`
    SELECT id, ide, cwd, started_at, ended_at, metadata
    FROM sessions
    ORDER BY started_at, id
  `).all() as SessionRow[];
  const sessionInfos = new Map<string, SessionInfo>();

  for (const row of sessions) {
    const session = requiredSessionInfo(row, report.malformed);
    if (!session) continue;
    sessionInfos.set(session.id, session);
    if (session.skipReason) {
      increment(report.skipped, 'sessions');
      incrementReason(report.skippedByReason, 'sessions', session.skipReason);
      report.sessions.skipped.push({ id: session.id, reason: session.skipReason });
    } else {
      increment(report.selected, 'sessions');
      report.sessions.selected.push(session.id);
    }
  }

  const observations = db.prepare(`
    SELECT id, session_id, kind, content, ts, metadata
    FROM observations
    ORDER BY id
  `).all() as ObservationRow[];
  for (const row of observations) {
    const sessionId = rowId(row.session_id);
    const session = sessionId ? sessionInfos.get(sessionId) : undefined;
    const timestamp = timestampValue(row.ts);
    const metadata = parseObjectMetadata(row.metadata, 'observations', report.malformed);
    if (
      !session
      || timestamp === null
      || !rowId(row.id)
      || !textValue(row.kind)
      || typeof row.content !== 'string'
    ) {
      increment(report.malformed, 'observations');
      continue;
    }

    const rowReason = session.skipReason || (explicitImporterMarker(metadata) ? 'importer' : null);
    if (rowReason) {
      increment(report.skipped, 'observations');
      incrementReason(report.skippedByReason, 'observations', rowReason);
      continue;
    }

    const record = sourceRecord('observations', row, session, timestamp);
    if (!record) {
      increment(report.malformed, 'observations');
      continue;
    }
    increment(report.selected, 'observations');
    report.records.push(record);
  }

  const summaries = db.prepare(`
    SELECT id, session_id, scope, content, ts
    FROM summaries
    ORDER BY id
  `).all() as SummaryRow[];
  for (const row of summaries) {
    const sessionId = rowId(row.session_id);
    const session = sessionId ? sessionInfos.get(sessionId) : undefined;
    const timestamp = timestampValue(row.ts);
    if (
      !session
      || timestamp === null
      || !rowId(row.id)
      || (row.scope !== 'turn' && row.scope !== 'session')
      || typeof row.content !== 'string'
    ) {
      increment(report.malformed, 'summaries');
      continue;
    }

    if (session.skipReason) {
      increment(report.skipped, 'summaries');
      incrementReason(report.skippedByReason, 'summaries', session.skipReason);
      continue;
    }

    const record = sourceRecord('summaries', row, session, timestamp);
    if (!record) {
      increment(report.malformed, 'summaries');
      continue;
    }
    increment(report.selected, 'summaries');
    report.records.push(record);
  }

  report.records.sort((left, right) => {
    const timestampOrder = left.timestamp.localeCompare(right.timestamp);
    return timestampOrder || left.id.localeCompare(right.id);
  });
  return report;
}

async function createSnapshot(sourcePath: string, snapshotPath: string): Promise<void> {
  if (path.resolve(sourcePath) === path.resolve(snapshotPath)) {
    throw new Error('snapshot path must differ from the cavemem source path');
  }
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  try {
    await source.backup(snapshotPath);
  } finally {
    source.close();
  }
}

async function readCavememSnapshot(sourcePath: string): Promise<SnapshotReport> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-snapshot-'));
  const snapshotPath = path.join(temporaryDirectory, 'data.db');
  try {
    await createSnapshot(sourcePath, snapshotPath);
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      return readFilteredSnapshot(snapshot, sourcePath);
    } finally {
      snapshot.close();
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseArguments(argv: string[]): CliOptions {
  let sourcePath: string | null = process.env.CAVEMEM_DATA_DB || null;
  let json = false;
  let dryRun = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--json') {
      json = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--source' || argument === '--data-db') {
      sourcePath = argv[index + 1] || null;
      index += 1;
    } else if (argument === '--data-dir') {
      const dataDirectory = argv[index + 1];
      sourcePath = dataDirectory ? path.join(dataDirectory, 'data.db') : null;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (sourcePath !== null && sourcePath.includes('\0')) {
    throw new Error('source path contains a NUL byte');
  }
  return { sourcePath: sourcePath ? path.resolve(sourcePath) : null, json, dryRun, help };
}

function helpText(): string {
  return [
    'Usage: agentmemory-import-cavemem --source PATH [--dry-run] [--json]',
    '',
    'Read a SQLite Online Backup snapshot of cavemem and report OpenCode history.',
    'The source database is opened read-only and is never used as the read target.',
    '',
    'Options:',
    '  --source PATH   cavemem data.db path',
    '  --data-db PATH  alias for --source',
    '  --data-dir PATH use PATH/data.db',
    '  --dry-run       report only; no AgentMemory request is made',
    '  --json          emit deterministic JSON instead of the human report',
  ].join('\n') + '\n';
}

function humanReport(report: SnapshotReport): string {
  const lines = [
    'agentmemory-import-cavemem: dry-run',
    `source: ${report.sourcePath}`,
    'selected:',
    `  sessions: ${report.selected.sessions}`,
    `  observations: ${report.selected.observations}`,
    `  summaries: ${report.selected.summaries}`,
    'skipped:',
    `  sessions: ${report.skipped.sessions}`,
    `  observations: ${report.skipped.observations}`,
    `  summaries: ${report.skipped.summaries}`,
    'malformed:',
    `  sessions: ${report.malformed.sessions}`,
    `  observations: ${report.malformed.observations}`,
    `  summaries: ${report.malformed.summaries}`,
    'sessions:',
    `  selected: ${report.sessions.selected.join(', ') || '(none)'}`,
    '  skipped:',
  ];
  for (const session of report.sessions.skipped) {
    lines.push(`    ${session.id}: ${session.reason}`);
  }
  return lines.join('\n') + '\n';
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (!options.sourcePath) throw new Error('a cavemem database is required via --source or CAVEMEM_DATA_DB');
  if (!options.dryRun) {
    // This task owns no submission path. Requiring the flag prevents an
    // operator from mistaking this read-only phase for the later importer.
    throw new Error('only --dry-run is supported by this task');
  }

  const report = await readCavememSnapshot(options.sourcePath);
  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : humanReport(report));
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`agentmemory-import-cavemem: ${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  createSnapshot,
  explicitImporterMarker,
  readCavememSnapshot,
  readFilteredSnapshot,
};
