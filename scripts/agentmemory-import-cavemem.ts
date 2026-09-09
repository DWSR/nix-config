#!/usr/bin/env node

/*
 * Best-effort cavemem history import for the AgentMemory migration.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

type SourceTable = 'sessions' | 'observations' | 'summaries';
type RecordTable = 'observations' | 'summaries';
type CountSet = Record<SourceTable, number>;
type ProgressReporter = (message: string) => void;

const AGENTMEMORY_IMPORT_VERSION = '0.9.29';
const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
const DEFAULT_IMPORT_URL = 'http://127.0.0.1:3111';

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
  selectedSessions: SessionInfo[];
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

interface ParsedMetadata {
  metadata: Record<string, unknown>;
  malformed: boolean;
}

interface SessionInfo {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  skipReason: string | null;
}

interface CliOptions {
  sourcePath: string | null;
  json: boolean;
  dryRun: boolean;
  url: string | null;
  maxBatchBytes: number;
  help: boolean;
}

interface AgentMemorySession {
  id: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt?: string;
  status: 'active' | 'completed';
  observationCount: number;
  tags: string[];
}

type StandardObservationType =
  | 'file_read'
  | 'file_write'
  | 'file_edit'
  | 'command_run'
  | 'search'
  | 'web_fetch'
  | 'conversation'
  | 'error'
  | 'decision'
  | 'discovery'
  | 'subagent'
  | 'notification'
  | 'task'
  | 'image'
  | 'other';

interface AgentMemoryObservation {
  id: string;
  sessionId: string;
  timestamp: string;
  type: StandardObservationType;
  title: string;
  facts: string[];
  narrative: string;
  concepts: string[];
  files: string[];
  importance: number;
  origin: LegacyImportRecord['origin'];
}

interface AgentMemorySourceSummary {
  id: string;
  timestamp: string;
  narrative: string;
}

interface AgentMemorySummary {
  id: string;
  sessionId: string;
  project: string;
  createdAt: string;
  title: string;
  narrative: string;
  keyDecisions: string[];
  filesModified: string[];
  concepts: string[];
  observationCount: number;
  origin: LegacyImportRecord['origin'];
  sourceSummaryIds: string[];
  sourceSummaries: AgentMemorySourceSummary[];
}

type ImportPayload = {
  exportData: {
    version: string;
    exportedAt: string;
    sessions: AgentMemorySession[];
    observations: Record<string, AgentMemoryObservation[]>;
    memories: [];
    summaries: AgentMemorySummary[];
  };
  strategy: 'skip';
};

interface ImportBatch {
  type: SourceTable;
  records: string[];
  payload: ImportPayload;
  bytes: number;
}

interface ImportReport {
  sourcePath: string;
  dryRun: false;
  selected: CountSet;
  target: CountSet;
  imported: CountSet;
  existing: CountSet;
  skipped: CountSet;
  malformed: CountSet;
  failed: CountSet;
  skippedByReason: Record<SourceTable, Record<string, number>>;
  batches: {
    submitted: number;
    succeeded: number;
    failed: number;
    oversized: number;
    sizes: number[];
    failedBatches: Array<{ type: SourceTable; records: string[]; error: string }>;
  };
  sessions: SnapshotReport['sessions'];
}

const IMPORTER_IDES = new Set([
  'agentmemory-import',
  'cavemem-import',
  'cavemem-importer',
  'import',
  'importer',
]);

const STANDARD_OBSERVATION_TYPES = new Set<StandardObservationType>([
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

const OBSERVATION_TYPE_ALIASES: Record<string, StandardObservationType> = {
  prompt: 'conversation',
  response: 'conversation',
  user: 'conversation',
  assistant: 'conversation',
  message: 'conversation',
  tool: 'command_run',
  tool_call: 'command_run',
  tool_use: 'command_run',
  tool_result: 'command_run',
  pre_tool_use: 'command_run',
  post_tool_use: 'command_run',
  tool_error: 'error',
  post_tool_failure: 'error',
};

function standardObservationType(sourceType: string): StandardObservationType {
  const normalized = sourceType.trim().toLowerCase();
  const alias = OBSERVATION_TYPE_ALIASES[normalized];
  if (alias) return alias;
  return STANDARD_OBSERVATION_TYPES.has(normalized as StandardObservationType)
    ? normalized as StandardObservationType
    : 'other';
}

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
): ParsedMetadata {
  if (value === null || value === undefined || value === '') {
    return { metadata: {}, malformed: false };
  }
  if (typeof value !== 'string') {
    return { metadata: {}, malformed: true };
  }

  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('metadata is not a JSON object');
    }
    return { metadata: parsed as Record<string, unknown>, malformed: false };
  } catch {
    return { metadata: {}, malformed: true };
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
    id: `cavemem:${table}:${session.id}:${id}`,
    sessionId: session.id,
    project: session.project,
    timestamp,
    narrative: content,
    type,
    origin: {
      channel: 'import',
      detail: `cavemem ${table} row ${id} from session ${session.id}; source kind ${type}`,
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

  const parsedMetadata = parseObjectMetadata(row.metadata);
  const metadata = parsedMetadata.metadata;
  const endedAt = row.ended_at === null || row.ended_at === undefined
    ? undefined
    : timestampValue(row.ended_at);
  if (
    parsedMetadata.malformed
    || (row.ended_at !== null && row.ended_at !== undefined && endedAt === null)
  ) {
    increment(malformed, 'sessions');
  }
  return {
    id,
    project: projectValue(row.cwd, metadata),
    cwd: typeof row.cwd === 'string' && row.cwd.trim() !== '' ? row.cwd : 'unknown',
    startedAt,
    ...(endedAt ? { endedAt } : {}),
    skipReason: classifySession(row.ide, metadata),
  };
}

function hasTable(db: InstanceType<typeof Database>, table: SourceTable): boolean {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
  ).get(table));
}

function closeDatabase(db: InstanceType<typeof Database>): void {
  db.close();
  // Finalize the native handle while Node's environment is still alive.
  if (typeof global.gc === 'function') global.gc();
}

function readFilteredSnapshot(
  db: InstanceType<typeof Database>,
  sourcePath: string,
  progress: ProgressReporter = () => {},
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
    selectedSessions: [],
    records: [],
  };

  const sessions = db.prepare(`
    SELECT id, ide, cwd, started_at, ended_at, metadata
    FROM sessions
    ORDER BY started_at, id
  `).iterate() as IterableIterator<SessionRow>;
  const sessionInfos = new Map<string, SessionInfo>();

  progress('scanning sessions');
  let sessionRows = 0;
  for (const row of sessions) {
    sessionRows += 1;
    if (sessionRows % 10_000 === 0) progress(`sessions: ${sessionRows} rows`);
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
      report.selectedSessions.push(session);
    }
  }
  progress(`sessions: ${sessionRows} rows total`);

  const observations = db.prepare(`
    SELECT id, session_id, kind, content, ts, metadata
    FROM observations
    ORDER BY id
  `).iterate() as IterableIterator<ObservationRow>;
  progress('scanning observations');
  let observationRows = 0;
  for (const row of observations) {
    observationRows += 1;
    if (observationRows % 10_000 === 0) progress(`observations: ${observationRows} rows`);
    const sessionId = rowId(row.session_id);
    const session = sessionId ? sessionInfos.get(sessionId) : undefined;
    const timestamp = timestampValue(row.ts);
    const parsedMetadata = parseObjectMetadata(row.metadata);
    const metadata = parsedMetadata.metadata;
    const structurallyInvalid = (
      !session
      || timestamp === null
      || !rowId(row.id)
      || !textValue(row.kind)
      || typeof row.content !== 'string'
    );
    if (parsedMetadata.malformed || structurallyInvalid) {
      increment(report.malformed, 'observations');
    }
    if (structurallyInvalid) {
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
  progress(`observations: ${observationRows} rows total`);

  const summaries = db.prepare(`
    SELECT id, session_id, scope, content, ts
    FROM summaries
    ORDER BY id
  `).iterate() as IterableIterator<SummaryRow>;
  progress('scanning summaries');
  let summaryRows = 0;
  for (const row of summaries) {
    summaryRows += 1;
    if (summaryRows % 10_000 === 0) progress(`summaries: ${summaryRows} rows`);
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
  progress(`summaries: ${summaryRows} rows total`);

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
    const backup = source.backup(snapshotPath);
    await backup;
    // The backup wrapper is otherwise finalized during later HTTP work.
    if (typeof global.gc === 'function') global.gc();
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  } finally {
    closeDatabase(source);
  }
}

async function readCavememSnapshot(
  sourcePath: string,
  progress: ProgressReporter = () => {},
): Promise<SnapshotReport> {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-cavemem-snapshot-'));
  const snapshotPath = path.join(temporaryDirectory, 'data.db');
  try {
    progress('creating read-only SQLite snapshot');
    await createSnapshot(sourcePath, snapshotPath);
    progress('SQLite snapshot created');
    const snapshot = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    try {
      return readFilteredSnapshot(snapshot, sourcePath, progress);
    } finally {
      closeDatabase(snapshot);
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function targetSessionId(sourceSessionId: string): string {
  return `cavemem:session:${sourceSessionId}`;
}

function targetSummaryId(sourceSessionId: string): string {
  return `cavemem:summary:${sourceSessionId}`;
}

function sourceTableForRecord(record: LegacyImportRecord): RecordTable {
  return record.id.startsWith('cavemem:summaries:') ? 'summaries' : 'observations';
}

function toAgentMemorySession(
  session: SessionInfo,
  observationCount: number,
): AgentMemorySession {
  return {
    id: targetSessionId(session.id),
    project: session.project,
    cwd: session.cwd,
    startedAt: session.startedAt,
    ...(session.endedAt ? { endedAt: session.endedAt } : {}),
    status: session.endedAt ? 'completed' : 'active',
    observationCount,
    tags: ['cavemem-import'],
  };
}

function toAgentMemoryObservation(record: LegacyImportRecord): AgentMemoryObservation {
  return {
    id: record.id,
    sessionId: targetSessionId(record.sessionId),
    timestamp: record.timestamp,
    type: standardObservationType(record.type),
    title: `cavemem ${record.type}`,
    facts: [record.narrative],
    narrative: record.narrative,
    concepts: [],
    files: [],
    importance: 0.5,
    origin: record.origin,
  };
}

function toAgentMemorySummary(
  records: LegacyImportRecord[],
  observationCount: number,
): AgentMemorySummary {
  const firstRecord = records[0];
  if (!firstRecord) throw new Error('cannot create a summary without source rows');
  const sourceSummaries = records.map(({ id, timestamp, narrative }) => ({
    id,
    timestamp,
    narrative,
  }));
  const sourceSummaryIds = sourceSummaries.map(({ id }) => id);
  const narrative = sourceSummaries
    .map(({ id, narrative: sourceNarrative }) => `[${id}]\n${sourceNarrative}`)
    .join('\n\n');
  return {
    id: targetSummaryId(firstRecord.sessionId),
    sessionId: targetSessionId(firstRecord.sessionId),
    project: firstRecord.project,
    createdAt: firstRecord.timestamp,
    title: 'cavemem session summaries',
    narrative,
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount,
    origin: {
      channel: 'import',
      detail: `cavemem summaries for session ${firstRecord.sessionId}; source rows ${sourceSummaryIds.join(', ')}`,
      capturedAt: firstRecord.timestamp,
    },
    sourceSummaryIds,
    sourceSummaries,
  };
}

interface PreparedImportRecords {
  sessions: Array<{ id: string; record: AgentMemorySession }>;
  observations: Array<{ id: string; record: AgentMemoryObservation }>;
  summaries: Array<{ id: string; record: AgentMemorySummary }>;
  target: CountSet;
  exportedAt: string;
}

type PreparedItem = {
  id: string;
  record: AgentMemorySession | AgentMemoryObservation | AgentMemorySummary;
};

function prepareImportRecords(
  snapshot: SnapshotReport,
  progress: ProgressReporter = () => {},
): PreparedImportRecords {
  const observationCounts = new Map<string, number>();
  const observations: PreparedImportRecords['observations'] = [];
  const summaryRecordsBySession = new Map<string, LegacyImportRecord[]>();
  let exportedAt = '1970-01-01T00:00:00.000Z';
  for (const session of snapshot.selectedSessions) {
    if (session.startedAt > exportedAt) exportedAt = session.startedAt;
  }

  progress(`record preparation: 0/${snapshot.records.length} records`);
  let processedRecords = 0;
  for (const record of snapshot.records) {
    processedRecords += 1;
    if (processedRecords % 10_000 === 0) {
      progress(`record preparation: ${processedRecords}/${snapshot.records.length} records`);
    }
    if (record.timestamp > exportedAt) exportedAt = record.timestamp;
    if (sourceTableForRecord(record) === 'observations') {
      observationCounts.set(
        record.sessionId,
        (observationCounts.get(record.sessionId) || 0) + 1,
      );
      observations.push({ id: record.id, record: toAgentMemoryObservation(record) });
    } else {
      const records = summaryRecordsBySession.get(record.sessionId) || [];
      records.push(record);
      summaryRecordsBySession.set(record.sessionId, records);
    }
  }
  progress(`record preparation: ${processedRecords}/${snapshot.records.length} records complete`);

  const sessions = snapshot.selectedSessions.map((session) => ({
    id: targetSessionId(session.id),
    record: toAgentMemorySession(session, observationCounts.get(session.id) || 0),
  }));
  const summaries = snapshot.selectedSessions.flatMap((session) => {
    const records = summaryRecordsBySession.get(session.id);
    if (!records || records.length === 0) return [];
    const record = toAgentMemorySummary(
      records,
      observationCounts.get(session.id) || 0,
    );
    return [{ id: record.id, record }];
  });

  return {
    sessions,
    observations,
    summaries,
    target: {
      sessions: sessions.length,
      observations: observations.length,
      summaries: summaries.length,
    },
    exportedAt,
  };
}

function createImportPayload(
  type: SourceTable,
  records: PreparedItem[],
  exportedAt: string,
): ImportPayload {
  const exportData: ImportPayload['exportData'] = {
    version: AGENTMEMORY_IMPORT_VERSION,
    exportedAt,
    sessions: [],
    observations: {},
    memories: [],
    summaries: [],
  };
  if (type === 'sessions') {
    exportData.sessions = records.map(({ record }) => record) as AgentMemorySession[];
  } else if (type === 'observations') {
    for (const { record } of records as PreparedImportRecords['observations']) {
      (exportData.observations[record.sessionId] ||= []).push(record);
    }
  } else {
    exportData.summaries = records.map(({ record }) => record) as AgentMemorySummary[];
  }
  return { exportData, strategy: 'skip' };
}

function payloadBytes(payload: ImportPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

interface BatchBuildResult {
  batches: ImportBatch[];
  oversized: Array<{ type: SourceTable; id: string }>;
  target: CountSet;
}

function buildImportBatches(
  snapshot: SnapshotReport,
  maxBytes = MAX_IMPORT_BYTES,
  progress: ProgressReporter = () => {},
): BatchBuildResult {
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_IMPORT_BYTES) {
    throw new Error(`batch size must be an integer between 1 and ${MAX_IMPORT_BYTES}`);
  }

  const prepared = prepareImportRecords(snapshot, progress);
  const batches: ImportBatch[] = [];
  const oversized: Array<{ type: SourceTable; id: string }> = [];
  const byType: Array<{
    type: SourceTable;
    records: PreparedItem[];
  }> = [
    { type: 'sessions', records: prepared.sessions },
    { type: 'observations', records: prepared.observations },
    { type: 'summaries', records: prepared.summaries },
  ];
  const totalRecords = byType.reduce((total, item) => total + item.records.length, 0);
  let processedRecords = 0;

  for (const { type, records } of byType) {
    let current: PreparedItem[] = [];
    const emptyPayloadBytes = payloadBytes(createImportPayload(type, [], prepared.exportedAt));
    let currentBytes = emptyPayloadBytes;
    const flush = () => {
      if (current.length === 0) return;
      const payload = createImportPayload(type, current, prepared.exportedAt);
      const bytes = payloadBytes(payload);
      if (bytes >= maxBytes) throw new Error(`internal batch sizing error for ${type}`);
      batches.push({
        type,
        records: current.map(({ id }) => id),
        payload,
        bytes,
      });
      current = [];
      currentBytes = emptyPayloadBytes;
    };

    for (const record of records) {
      processedRecords += 1;
      if (processedRecords % 10_000 === 0) {
        progress(`batch sizing: ${processedRecords}/${totalRecords} records`);
      }
      const recordBytes = Buffer.byteLength(JSON.stringify(record.record), 'utf8');
      const contribution = type === 'observations'
        ? recordBytes
          + Buffer.byteLength(JSON.stringify((record.record as AgentMemoryObservation).sessionId), 'utf8')
          + 4
        : recordBytes + 1;

      if (current.length > 0 && currentBytes + contribution >= maxBytes) flush();
      if (currentBytes + contribution < maxBytes) {
        current.push(record);
        currentBytes += contribution;
        continue;
      }

      const singlePayload = createImportPayload(type, [record], prepared.exportedAt);
      const singleBytes = payloadBytes(singlePayload);
      if (singleBytes < maxBytes) {
        current = [record];
        currentBytes = singleBytes;
      } else {
        oversized.push({ type, id: record.id });
      }
    }
    flush();
  }
  progress(`batch sizing: ${processedRecords}/${totalRecords} records complete`);

  return { batches, oversized, target: prepared.target };
}

function normalizeImportUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('AgentMemory URL must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AgentMemory URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('AgentMemory URL must not contain credentials');
  }
  if (!parsed.pathname.endsWith('/agentmemory/import')) {
    parsed.pathname = `${parsed.pathname.replace(/\/+$/, '')}/agentmemory/import`;
  }
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function submitImportBatch(
  endpoint: string,
  payload: ImportPayload,
  secret: string | undefined,
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (secret) headers.authorization = `Bearer ${secret}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`AgentMemory import returned HTTP ${response.status}`);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error('AgentMemory import returned invalid JSON');
  }
  if (!body || typeof body !== 'object' || (body as Record<string, unknown>).success !== true) {
    throw new Error('AgentMemory import rejected the batch');
  }
  return body as Record<string, unknown>;
}

function responseCount(body: Record<string, unknown>, key: SourceTable): number {
  const value = body[key];
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`AgentMemory import response omitted the ${key} count`);
  }
  return value as number;
}

function responseSkipped(body: Record<string, unknown>): number {
  const value = body.skipped;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error('AgentMemory import response omitted the skipped count');
  }
  return value as number;
}

async function importSnapshot(
  snapshot: SnapshotReport,
  endpoint: string,
  secret: string | undefined,
  maxBatchBytes = MAX_IMPORT_BYTES,
  progress: ProgressReporter = () => {},
): Promise<ImportReport> {
  progress('preparing import batches');
  const built = buildImportBatches(snapshot, maxBatchBytes, progress);
  progress(`prepared ${built.batches.length} batches; ${built.oversized.length} oversized records`);
  const importEndpoint = normalizeImportUrl(endpoint);
  const report: ImportReport = {
    sourcePath: snapshot.sourcePath,
    dryRun: false,
    selected: snapshot.selected,
    target: built.target,
    imported: emptyCounts(),
    existing: emptyCounts(),
    skipped: snapshot.skipped,
    malformed: snapshot.malformed,
    failed: emptyCounts(),
    skippedByReason: snapshot.skippedByReason,
    batches: {
      submitted: 0,
      succeeded: 0,
      failed: 0,
      oversized: built.oversized.length,
      sizes: [],
      failedBatches: [],
    },
    sessions: snapshot.sessions,
  };

  for (const item of built.oversized) {
    increment(report.failed, item.type);
    report.batches.failedBatches.push({
      type: item.type,
      records: [item.id],
      error: 'record cannot fit below the 8 MiB import limit',
    });
  }

  for (let index = 0; index < built.batches.length; index += 1) {
    const batch = built.batches[index];
    progress(
      `submitting batch ${index + 1}/${built.batches.length}: ${batch.type}, ${batch.records.length} records, ${batch.bytes} bytes`,
    );
    report.batches.submitted += 1;
    report.batches.sizes.push(batch.bytes);
    try {
      const body = await submitImportBatch(importEndpoint, batch.payload, secret);
      const imported = responseCount(body, batch.type);
      const existing = responseSkipped(body);
      if (imported + existing !== batch.records.length) {
        throw new Error(`AgentMemory import returned counts that do not cover the ${batch.type} batch`);
      }
      report.imported[batch.type] += imported;
      report.existing[batch.type] += existing;
      report.batches.succeeded += 1;
      progress(`batch ${index + 1}/${built.batches.length} succeeded`);
    } catch (error: unknown) {
      report.failed[batch.type] += batch.records.length;
      report.batches.failed += 1;
      report.batches.failedBatches.push({
        type: batch.type,
        records: batch.records,
        error: error instanceof Error ? error.message : String(error),
      });
      progress(`batch ${index + 1}/${built.batches.length} failed`);
    }
  }

  return report;
}

function parseArguments(argv: string[]): CliOptions {
  let sourcePath: string | null = process.env.CAVEMEM_DATA_DB || null;
  let json = false;
  let dryRun = false;
  let url: string | null = null;
  let maxBatchBytes = MAX_IMPORT_BYTES;
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
    } else if (argument === '--url' || argument === '--endpoint') {
      url = argv[index + 1] || null;
      index += 1;
    } else if (argument === '--batch-bytes') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1 || value > MAX_IMPORT_BYTES) {
        throw new Error(`batch size must be an integer between 1 and ${MAX_IMPORT_BYTES}`);
      }
      maxBatchBytes = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (sourcePath !== null && sourcePath.includes('\0')) {
    throw new Error('source path contains a NUL byte');
  }
  return {
    sourcePath: sourcePath ? path.resolve(sourcePath) : null,
    json,
    dryRun,
    url,
    maxBatchBytes,
    help,
  };
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
    '  --url URL       AgentMemory base URL (or AGENTMEMORY_URL)',
    '  --batch-bytes N lower the strict 8 MiB batch ceiling for testing',
    '  --json          emit deterministic JSON instead of the human report',
  ].join('\n') + '\n';
}

function humanReport(report: SnapshotReport | ImportReport): string {
  const lines = [
    `agentmemory-import-cavemem: ${report.dryRun ? 'dry-run' : 'import'}`,
    `source: ${report.sourcePath}`,
    'selected:',
    `  sessions: ${report.selected.sessions}`,
    `  observations: ${report.selected.observations}`,
    `  summaries: ${report.selected.summaries}`,
    'target:',
    `  sessions: ${report.dryRun ? report.selected.sessions : report.target.sessions}`,
    `  observations: ${report.dryRun ? report.selected.observations : report.target.observations}`,
    `  summaries: ${report.dryRun ? report.selected.summaries : report.target.summaries}`,
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
  if (!report.dryRun) {
    lines.push(
      'imported:',
      `  sessions: ${report.imported.sessions}`,
      `  observations: ${report.imported.observations}`,
      `  summaries: ${report.imported.summaries}`,
      'existing:',
      `  sessions: ${report.existing.sessions}`,
      `  observations: ${report.existing.observations}`,
      `  summaries: ${report.existing.summaries}`,
      'failed:',
      `  sessions: ${report.failed.sessions}`,
      `  observations: ${report.failed.observations}`,
      `  summaries: ${report.failed.summaries}`,
      `batches: ${report.batches.succeeded} succeeded, ${report.batches.failed} failed`,
    );
  }
  return lines.join('\n') + '\n';
}

function writeJsonReport(report: SnapshotReport | ImportReport): void {
  if (!report.dryRun) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const { records, ...header } = report;
  const headerJson = JSON.stringify(header, null, 2);
  fs.writeSync(process.stdout.fd, `${headerJson.slice(0, -2)},\n  "records": [`);
  for (let index = 0; index < records.length; index += 1) {
    const recordJson = JSON.stringify(records[index], null, 2).replace(/^/gm, '    ');
    fs.writeSync(process.stdout.fd, `${index === 0 ? '\n' : ',\n'}${recordJson}`);
  }
  fs.writeSync(process.stdout.fd, records.length === 0 ? ']\n}\n' : '\n  ]\n}\n');
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(helpText());
    return;
  }
  if (!options.sourcePath) throw new Error('a cavemem database is required via --source or CAVEMEM_DATA_DB');

  const progress: ProgressReporter = process.stderr.isTTY || process.env.AGENTMEMORY_IMPORT_PROGRESS === '1'
    ? (message) => process.stderr.write(`agentmemory-import-cavemem: ${message}\n`)
    : () => {};
  const snapshot = await readCavememSnapshot(options.sourcePath, progress);
  progress(
    `selected ${snapshot.selected.sessions} sessions, ${snapshot.selected.observations} observations, ${snapshot.selected.summaries} summaries`,
  );
  const report = options.dryRun
    ? snapshot
    : await importSnapshot(
      snapshot,
      normalizeImportUrl(options.url || process.env.AGENTMEMORY_URL || DEFAULT_IMPORT_URL),
      process.env.AGENTMEMORY_SECRET,
      options.maxBatchBytes,
      progress,
    );
  progress(options.json ? 'writing JSON report' : 'writing report');
  if (options.json) {
    writeJsonReport(report);
  } else {
    process.stdout.write(humanReport(report));
  }
  progress('complete');
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agentmemory-import-cavemem: ${message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  buildImportBatches,
  createSnapshot,
  explicitImporterMarker,
  importSnapshot,
  normalizeImportUrl,
  readCavememSnapshot,
  readFilteredSnapshot,
  targetSessionId,
};
