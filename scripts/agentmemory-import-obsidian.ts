#!/usr/bin/env node

'use strict';

const nodeFs = require('node:fs');
const nodeCrypto = require('node:crypto');
const nodePath = require('node:path');

type FileStats = {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
};

type SourceMetadata = {
  mode: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
};

type SourceNote = {
  absolutePath: string;
  relativePath: string;
  bytes: Buffer;
  metadata: SourceMetadata;
};

type SourceIssue = {
  relativePath: string;
  reason: string;
};

type SourceDiscovery = {
  sourcePath: string;
  memoriesPath: string;
  discovered: number;
  notes: SourceNote[];
  skipped: SourceIssue[];
};

type MemoryType =
  | 'pattern'
  | 'preference'
  | 'architecture'
  | 'bug'
  | 'workflow'
  | 'fact';

type ImportedMemory = {
  id: string;
  createdAt: string;
  updatedAt: string;
  type: MemoryType;
  title: string;
  content: string;
  concepts: string[];
  files: string[];
  sessionIds: string[];
  strength: number;
  version: number;
  isLatest: boolean;
  project?: string;
  origin: {
    channel: 'import';
    detail: string;
    capturedAt: string;
  };
};

type ImportExportData = {
  version: '0.9.29';
  exportedAt: string;
  sessions: [];
  observations: Record<string, never[]>;
  memories: ImportedMemory[];
  summaries: [];
};

type ImportRequest = {
  exportData: ImportExportData;
  strategy: 'skip';
};

type ImportSuccess = {
  success: true;
  strategy: 'skip';
  sessions: number;
  observations: number;
  memories: number;
  summaries: number;
  skipped: number;
};

type ImportLogicalFailure = {
  success: false;
  error: string;
};

type ImportResponse = ImportSuccess | ImportLogicalFailure;

type MemoryImportBatch = {
  request: ImportRequest;
  records: ImportedMemory[];
  body: string;
  bytes: number;
};

type ImportBatchIssue = {
  relativePath: string;
  reason: string;
};

type MemoryBatchBuildResult = {
  batches: MemoryImportBatch[];
  oversized: ImportBatchIssue[];
};

type NoteOutcome =
  | { kind: 'prepared'; relativePath: string; memory: ImportedMemory }
  | { kind: 'skipped'; relativePath: string; reason: string };

type Frontmatter = Record<string, unknown>;

type SourceOptions = {
  vaultPath: string;
};

type ImportMode =
  | { kind: 'dry-run' }
  | { kind: 'live'; endpoint: string; bearer: string };

type ImportCounts = {
  discovered: number;
  eligible: number;
  imported: number;
  alreadyPresent: number;
  skipped: number;
  failed: number;
};

type ImportIssue = {
  relativePath: string;
  reason: string;
};

type ObsidianImportReport = {
  sourcePath: string;
  dryRun: boolean;
  counts: ImportCounts;
  batches: {
    submitted: number;
    succeeded: number;
    failed: number;
  };
  skipped: ImportIssue[];
  failures: ImportIssue[];
};

type PreparedSource = {
  sourcePath: string;
  discovered: number;
  capturedAt: string;
  outcomes: NoteOutcome[];
  memories: ImportedMemory[];
};

type FrontmatterResult =
  | { frontmatter: Frontmatter; body: string }
  | { error: string };

type YamlModule = {
  load(value: string, options?: { schema?: unknown }): unknown;
  JSON_SCHEMA?: unknown;
};

const MEMORY_TYPES = new Set<string>([
  'pattern',
  'preference',
  'architecture',
  'bug',
  'workflow',
  'fact',
]);

const OBSIDIAN_IMPORT_VERSION = '0.9.29';
const OBSIDIAN_MAX_IMPORT_MEMORIES = 10_000;
const OBSIDIAN_MAX_IMPORT_BYTES = 8 * 1024 * 1024;

function fail(message: string): never {
  throw new Error(`agentmemory-import-obsidian: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function isContained(candidatePath: string, rootPath: string): boolean {
  const relativePath = nodePath.relative(rootPath, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${nodePath.sep}`)
    && !nodePath.isAbsolute(relativePath);
}

function relativeSourcePath(name: string): string {
  return nodePath.posix.join('memories', name);
}

function issueForSymlink(
  entryPath: string,
  relativePath: string,
  memoriesPath: string,
): SourceIssue {
  try {
    const linkTarget = nodeFs.readlinkSync(entryPath);
    const resolvedTarget = nodePath.isAbsolute(linkTarget)
      ? nodePath.normalize(linkTarget)
      : nodePath.resolve(memoriesPath, linkTarget);
    if (!isContained(resolvedTarget, memoriesPath)) {
      return { relativePath, reason: 'path escapes memories directory' };
    }
  } catch {
    // The entry is already known to be a symlink. Do not resolve or read it.
  }
  return { relativePath, reason: 'symlink' };
}

function sourceMetadata(stat: FileStats): SourceMetadata {
  return {
    mode: stat.mode,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    birthtimeMs: stat.birthtimeMs,
  };
}

function readRegularSource(
  entryPath: string,
  relativePath: string,
  realMemoriesPath: string,
): SourceNote | SourceIssue {
  let entryStat: FileStats;
  try {
    entryStat = nodeFs.lstatSync(entryPath);
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot inspect source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (entryStat.isSymbolicLink()) {
    return issueForSymlink(entryPath, relativePath, realMemoriesPath);
  }
  if (!entryStat.isFile()) {
    return { relativePath, reason: 'non-regular entry' };
  }

  let realPath: string;
  try {
    realPath = nodeFs.realpathSync(entryPath);
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot resolve source path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!isContained(realPath, realMemoriesPath)) {
    return { relativePath, reason: 'path escapes memories directory' };
  }

  try {
    const currentEntryStat = nodeFs.lstatSync(entryPath);
    if (currentEntryStat.isSymbolicLink()) {
      return issueForSymlink(entryPath, relativePath, realMemoriesPath);
    }
    if (!currentEntryStat.isFile()) {
      return { relativePath, reason: 'non-regular entry' };
    }

    const openFlags = nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NOFOLLOW || 0);
    const descriptor = nodeFs.openSync(realPath, openFlags);
    try {
      const openedStat = nodeFs.fstatSync(descriptor);
      if (!openedStat.isFile()) {
        return { relativePath, reason: 'non-regular entry' };
      }
      const bytes = nodeFs.readFileSync(descriptor);
      return {
        absolutePath: realPath,
        relativePath,
        bytes,
        metadata: sourceMetadata(openedStat),
      };
    } finally {
      nodeFs.closeSync(descriptor);
    }
  } catch (error: unknown) {
    return {
      relativePath,
      reason: `cannot read source: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function requireReadableDirectory(directoryPath: string, label: string): void {
  try {
    nodeFs.accessSync(directoryPath, nodeFs.constants.R_OK | nodeFs.constants.X_OK);
  } catch {
    fail(`${label} is not readable: ${directoryPath}`);
  }
}

function realDirectory(directoryPath: string, label: string): string {
  let stat: FileStats;
  try {
    stat = nodeFs.statSync(directoryPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail(`${label} does not exist: ${directoryPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`${label} is not readable: ${directoryPath}`);
    }
    fail(`cannot inspect ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!stat.isDirectory()) fail(`${label} is not a directory: ${directoryPath}`);
  requireReadableDirectory(directoryPath, label);

  try {
    return nodeFs.realpathSync(directoryPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      fail(`${label} does not exist: ${directoryPath}`);
    }
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`${label} is not readable: ${directoryPath}`);
    }
    fail(`cannot resolve ${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateVaultRoot(vaultPath: string): string {
  if (typeof vaultPath !== 'string' || !nodePath.isAbsolute(vaultPath)) {
    fail('vault path must be absolute');
  }
  if (vaultPath.includes('\0')) fail('vault path contains a NUL byte');

  let rootStat: FileStats;
  try {
    rootStat = nodeFs.lstatSync(vaultPath);
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'ENOENT' || code === 'ENOTDIR') fail(`vault path does not exist: ${vaultPath}`);
    if (code === 'EACCES' || code === 'EPERM') fail(`vault path is not readable: ${vaultPath}`);
    fail(`cannot inspect vault path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) {
    fail(`vault path is not a directory: ${vaultPath}`);
  }
  return realDirectory(vaultPath, 'vault path');
}

function listDirectMarkdownChildren(memoriesPath: string): string[] {
  try {
    return nodeFs.readdirSync(memoriesPath)
      .filter((name: string) => name.toLowerCase().endsWith('.md'))
      .sort();
  } catch (error: unknown) {
    const code = errorCode(error);
    if (code === 'EACCES' || code === 'EPERM') {
      fail(`memories directory is not readable: ${memoriesPath}`);
    }
    fail(`cannot read memories directory: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isYamlModule(value: unknown): value is YamlModule {
  return isObject(value) && typeof value.load === 'function';
}

function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === 'string' && MEMORY_TYPES.has(value);
}

function parseFrontmatter(text: string): FrontmatterResult {
  const opening = text.startsWith('---\r\n')
    ? 5
    : text.startsWith('---\n')
      ? 4
      : null;
  if (opening === null) return { frontmatter: {}, body: text };

  const remainder = text.slice(opening);
  const closing = /(?:^|\r?\n)---(?:\r?\n|$)/.exec(remainder);
  if (!closing || closing.index === undefined) {
    return { error: 'malformed frontmatter: missing closing delimiter' };
  }

  const delimiterOffset = closing[0].startsWith('\r\n')
    ? 2
    : closing[0].startsWith('\n')
      ? 1
      : 0;
  const frontmatterText = remainder.slice(0, closing.index + delimiterOffset);
  const bodyStart = opening + closing.index + closing[0].length;
  let loaded: unknown;
  try {
    const yamlModule: unknown = require('js-yaml');
    if (!isYamlModule(yamlModule)) {
      return { error: 'malformed frontmatter: js-yaml loader is unavailable' };
    }
    if (!yamlModule.JSON_SCHEMA) {
      return { error: 'malformed frontmatter: js-yaml JSON schema is unavailable' };
    }
    loaded = yamlModule.load(frontmatterText, { schema: yamlModule.JSON_SCHEMA });
  } catch (error: unknown) {
    return {
      error: `malformed frontmatter: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!isObject(loaded)) {
    return { error: 'malformed frontmatter: expected a YAML mapping' };
  }
  return { frontmatter: loaded, body: text.slice(bodyStart) };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function parseStringList(
  frontmatter: Frontmatter,
  field: 'tags' | 'sessions',
): { values: string[]; error?: string } {
  const value = frontmatter[field];
  if (value === undefined) return { values: [] };
  if (!Array.isArray(value) || !value.every(nonEmptyString)) {
    return { values: [], error: `malformed frontmatter: ${field} must be an array of non-empty strings` };
  }
  return { values: [...value] };
}

function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function dateOnlyTimestamp(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!isValidCalendarDate(year, month, day)) return null;
  const parsed = new Date(`${value.trim()}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime())
    || parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() + 1 !== month
    || parsed.getUTCDate() !== day
  ) return null;
  return parsed.toISOString();
}

function isoTimestamp(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value);
  if (!match) return null;
  if (!match[4]) return dateOnlyTimestamp(value);

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined
    ? 0
    : Number(match[7].slice(0, 3).padEnd(3, '0'));
  if (
    !isValidCalendarDate(year, month, day)
    || hour > 23
    || minute > 59
    || second > 59
  ) return null;

  const timezone = match[8];
  let offsetMinutes: number | undefined;
  if (timezone === 'Z') {
    offsetMinutes = 0;
  } else if (timezone !== undefined) {
    const offset = /^([+-])(\d{2}):?(\d{2})$/.exec(timezone);
    if (!offset) return null;
    const offsetHour = Number(offset[2]);
    const offsetMinute = Number(offset[3]);
    if (offsetHour > 23 || offsetMinute > 59) return null;
    offsetMinutes = (offset[1] === '-' ? -1 : 1) * (offsetHour * 60 + offsetMinute);
  }

  const milliseconds = Date.parse(value);
  if (Number.isNaN(milliseconds)) return null;
  const parsed = new Date(milliseconds);
  const components = offsetMinutes === undefined
    ? {
        year: parsed.getFullYear(),
        month: parsed.getMonth() + 1,
        day: parsed.getDate(),
        hour: parsed.getHours(),
        minute: parsed.getMinutes(),
        second: parsed.getSeconds(),
        millisecond: parsed.getMilliseconds(),
      }
    : (() => {
        const local = new Date(milliseconds + offsetMinutes * 60 * 1000);
        return {
          year: local.getUTCFullYear(),
          month: local.getUTCMonth() + 1,
          day: local.getUTCDate(),
          hour: local.getUTCHours(),
          minute: local.getUTCMinutes(),
          second: local.getUTCSeconds(),
          millisecond: local.getUTCMilliseconds(),
        };
      })();
  if (
    components.year !== year
    || components.month !== month
    || components.day !== day
    || components.hour !== hour
    || components.minute !== minute
    || components.second !== second
    || components.millisecond !== millisecond
  ) return null;
  return parsed.toISOString();
}

function timestampValue(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  return isoTimestamp(value.trim());
}

function normalizeSourcePath(relativePath: string): string {
  const normalized = nodePath.posix.normalize(relativePath.replaceAll(nodePath.sep, '/'));
  if (
    normalized === 'memories'
    || nodePath.posix.dirname(normalized) !== 'memories'
    || !normalized.toLowerCase().endsWith('.md')
  ) {
    throw new Error('source path must be a direct Markdown child of memories');
  }
  return normalized;
}

function filenameStem(relativePath: string): string {
  const filename = nodePath.posix.basename(relativePath);
  return filename.slice(0, -3);
}

function titleFromBody(body: string, fallback: string): string {
  for (const line of body.split(/\r?\n/)) {
    const match = /^#(?!#)[ \t]+(.+?)[ \t]*$/.exec(line);
    if (!match) continue;
    const title = match[1].replace(/[ \t]+#+[ \t]*$/, '').trim();
    if (title !== '') return title;
  }
  return fallback;
}

function timestampForNote(
  frontmatter: Frontmatter,
  relativePath: string,
  metadata: SourceMetadata,
): { timestamp: string } | { error: string } {
  if (Object.prototype.hasOwnProperty.call(frontmatter, 'date')) {
    const timestamp = timestampValue(frontmatter.date);
    if (!timestamp) return { error: 'malformed frontmatter: date must be a valid date' };
    return { timestamp };
  }

  const filenameDate = /^(\d{4}-\d{2}-\d{2})(?:-|$)/.exec(filenameStem(relativePath));
  if (filenameDate) {
    const timestamp = dateOnlyTimestamp(filenameDate[1]);
    if (timestamp) return { timestamp };
  }

  if (typeof metadata.mtimeMs !== 'number' || !Number.isFinite(metadata.mtimeMs)) {
    return { error: 'invalid source mtime' };
  }
  const timestamp = new Date(metadata.mtimeMs);
  if (Number.isNaN(timestamp.getTime())) return { error: 'invalid source mtime' };
  return { timestamp: timestamp.toISOString() };
}

function parseNoteFields(
  frontmatter: Frontmatter,
): { project?: string; tags: string[]; sessions: string[] } | { error: string } {
  let project: string | undefined;
  if (frontmatter.project !== undefined) {
    if (typeof frontmatter.project !== 'string') {
      return { error: 'malformed frontmatter: project must be a string' };
    }
    if (frontmatter.project.trim() !== '') project = frontmatter.project;
  }

  const tags = parseStringList(frontmatter, 'tags');
  if (tags.error) return { error: tags.error };
  const sessions = parseStringList(frontmatter, 'sessions');
  if (sessions.error) return { error: sessions.error };
  return { project, tags: tags.values, sessions: sessions.values };
}

function sourceIdentity(relativePath: string): string {
  return `mem_obsidian_${nodeCrypto.createHash('sha256').update(relativePath, 'utf8').digest('hex')}`;
}

function validStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === 'string' && timestampValue(value) === value;
}

function isImportedMemory(value: unknown): value is ImportedMemory {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== 'string'
    || !/^mem_obsidian_[0-9a-f]{64}$/.test(value.id)
    || !isIsoTimestamp(value.createdAt)
    || !isIsoTimestamp(value.updatedAt)
    || !isMemoryType(value.type)
    || typeof value.title !== 'string'
    || value.title.trim() === ''
    || typeof value.content !== 'string'
    || !validStringArray(value.concepts)
    || new Set(value.concepts).size !== value.concepts.length
    || !validStringArray(value.files)
    || value.files.length !== 1
    || !validStringArray(value.sessionIds)
    || value.sessionIds.length !== 0
    || value.strength !== 1
    || value.version !== 1
    || value.isLatest !== true
    || !isObject(value.origin)
    || value.origin.channel !== 'import'
    || typeof value.origin.detail !== 'string'
    || !isIsoTimestamp(value.origin.capturedAt)
  ) return false;
  if (value.project !== undefined && !nonEmptyString(value.project)) {
    return false;
  }
  const sourcePath = value.files[0];
  let normalizedSourcePath: string;
  try {
    normalizedSourcePath = normalizeSourcePath(sourcePath);
  } catch {
    return false;
  }
  if (
    normalizedSourcePath !== sourcePath
    || value.id !== sourceIdentity(sourcePath)
    || value.content.trim() === ''
    || value.updatedAt !== value.createdAt
    || !value.concepts.includes(`obsidian-source:${sourcePath}`)
  ) return false;
  try {
    const detail: unknown = JSON.parse(value.origin.detail);
    if (
      !isObject(detail)
      || detail.sourcePath !== value.files[0]
      || !validStringArray(detail.tags)
      || !validStringArray(detail.sessions)
    ) return false;
  } catch {
    return false;
  }
  return true;
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return actualKeys.length === sortedExpectedKeys.length
    && actualKeys.every((key, index) => key === sortedExpectedKeys[index]);
}

function isEmptyObject(value: unknown): value is Record<string, never[]> {
  return isObject(value) && Object.keys(value).length === 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isImportRequest(value: unknown): value is ImportRequest {
  if (!isObject(value) || !hasExactKeys(value, ['exportData', 'strategy'])) return false;
  if (value.strategy !== 'skip' || !isObject(value.exportData)) return false;

  const exportData = value.exportData;
  if (!hasExactKeys(exportData, [
    'version',
    'exportedAt',
    'sessions',
    'observations',
    'memories',
    'summaries',
  ])) return false;

  return exportData.version === OBSIDIAN_IMPORT_VERSION
    && isIsoTimestamp(exportData.exportedAt)
    && Array.isArray(exportData.sessions)
    && exportData.sessions.length === 0
    && isEmptyObject(exportData.observations)
    && Array.isArray(exportData.memories)
    && exportData.memories.length <= OBSIDIAN_MAX_IMPORT_MEMORIES
    && exportData.memories.every(isImportedMemory)
    && Array.isArray(exportData.summaries)
    && exportData.summaries.length === 0;
}

function isImportSuccess(value: unknown, submittedMemoryCount: number): value is ImportSuccess {
  if (!isObject(value) || !Number.isSafeInteger(submittedMemoryCount) || submittedMemoryCount < 0) {
    return false;
  }
  if (!hasExactKeys(value, [
    'success',
    'strategy',
    'sessions',
    'observations',
    'memories',
    'summaries',
    'skipped',
  ])) return false;
  if (value.success !== true || value.strategy !== 'skip') return false;

  const sessions = value.sessions;
  const observations = value.observations;
  const memories = value.memories;
  const summaries = value.summaries;
  const skipped = value.skipped;
  if (
    !isNonNegativeSafeInteger(sessions)
    || !isNonNegativeSafeInteger(observations)
    || !isNonNegativeSafeInteger(memories)
    || !isNonNegativeSafeInteger(summaries)
    || !isNonNegativeSafeInteger(skipped)
  ) return false;

  return sessions === 0
    && observations === 0
    && summaries === 0
    && memories + skipped === submittedMemoryCount;
}

function isImportResponse(value: unknown, submittedMemoryCount: number): value is ImportResponse {
  if (!isObject(value)) return false;
  if (value.success === false) {
    return hasExactKeys(value, ['success', 'error']) && typeof value.error === 'string';
  }
  return isImportSuccess(value, submittedMemoryCount);
}

function createImportRequest(
  memories: readonly ImportedMemory[],
  exportedAt: string,
): ImportRequest {
  if (!Array.isArray(memories)) fail('import memories must be an array');
  const request: ImportRequest = {
    exportData: {
      version: OBSIDIAN_IMPORT_VERSION,
      exportedAt,
      sessions: [],
      observations: {},
      memories: [...memories],
      summaries: [],
    },
    strategy: 'skip',
  };
  if (!isImportRequest(request)) fail('constructed import request failed runtime validation');
  return request;
}

function serializeImportRequest(request: ImportRequest): { body: string; bytes: number } {
  if (!isImportRequest(request)) fail('import request failed runtime validation');
  let body: string | undefined;
  try {
    body = JSON.stringify(request);
  } catch (error: unknown) {
    fail(`cannot serialize import request: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (body === undefined) fail('cannot serialize import request');
  return { body, bytes: Buffer.byteLength(body, 'utf8') };
}

function serializedMemory(memory: ImportedMemory): { memory: ImportedMemory; bytes: number } {
  let body: string | undefined;
  try {
    body = JSON.stringify(memory);
  } catch (error: unknown) {
    fail(`cannot serialize memory ${memory.files[0]}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (body === undefined) fail(`cannot serialize memory ${memory.files[0]}`);
  return { memory, bytes: Buffer.byteLength(body, 'utf8') };
}

function importBodyEnvelope(exportedAt: string): { prefix: string; suffix: string; bytes: number } {
  const version = JSON.stringify(OBSIDIAN_IMPORT_VERSION);
  const timestamp = JSON.stringify(exportedAt);
  if (version === undefined || timestamp === undefined) fail('cannot serialize import envelope');
  const prefix = `{"exportData":{"version":${version},"exportedAt":${timestamp},"sessions":[],"observations":{},"memories":[`;
  const suffix = `],"summaries":[]},"strategy":"skip"}`;
  return {
    prefix,
    suffix,
    bytes: Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(suffix, 'utf8'),
  };
}

function buildImportBatches(
  memories: readonly ImportedMemory[],
  exportedAt: string,
): MemoryBatchBuildResult {
  if (!Array.isArray(memories)) fail('import memories must be an array');
  if (!isIsoTimestamp(exportedAt)) fail('import exportedAt failed runtime validation');

  const sortedMemories = [...memories];
  for (let index = 0; index < sortedMemories.length; index += 1) {
    if (!isImportedMemory(sortedMemories[index])) {
      fail(`memory at index ${index} failed runtime validation`);
    }
  }
  sortedMemories.sort((left, right) => {
    const leftPath = left.files[0];
    const rightPath = right.files[0];
    if (leftPath === rightPath) return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    return leftPath < rightPath ? -1 : 1;
  });

  const serializedRecords = sortedMemories.map(serializedMemory);
  const envelope = importBodyEnvelope(exportedAt);
  const batches: MemoryImportBatch[] = [];
  const oversized: ImportBatchIssue[] = [];
  let currentRecords: ImportedMemory[] = [];
  let currentBytes = envelope.bytes;

  const flush = (): void => {
    if (currentRecords.length === 0) return;
    const request = createImportRequest(currentRecords, exportedAt);
    const serialized = serializeImportRequest(request);
    if (serialized.bytes >= OBSIDIAN_MAX_IMPORT_BYTES) {
      fail('internal batch sizing error produced a request at or above the 8 MiB limit');
    }
    batches.push({
      request,
      records: [...currentRecords],
      body: serialized.body,
      bytes: serialized.bytes,
    });
    currentRecords = [];
    currentBytes = envelope.bytes;
  };

  for (const item of serializedRecords) {
    const contribution = item.bytes + (currentRecords.length === 0 ? 0 : 1);
    if (
      currentRecords.length > 0
      && (
        currentRecords.length >= OBSIDIAN_MAX_IMPORT_MEMORIES
        || currentBytes + contribution >= OBSIDIAN_MAX_IMPORT_BYTES
      )
    ) flush();

    const nextContribution = item.bytes + (currentRecords.length === 0 ? 0 : 1);
    if (currentBytes + nextContribution < OBSIDIAN_MAX_IMPORT_BYTES) {
      currentRecords.push(item.memory);
      currentBytes += nextContribution;
      continue;
    }

    const singleRequest = createImportRequest([item.memory], exportedAt);
    const single = serializeImportRequest(singleRequest);
    if (single.bytes < OBSIDIAN_MAX_IMPORT_BYTES) {
      currentRecords.push(item.memory);
      currentBytes += item.bytes;
    } else {
      oversized.push({
        relativePath: item.memory.files[0],
        reason: 'record cannot fit below the 8 MiB import limit',
      });
    }
  }
  flush();

  return { batches, oversized };
}

function mapSourceNote(
  note: SourceNote,
  capturedAt = new Date().toISOString(),
): NoteOutcome {
  const relativePath = typeof note?.relativePath === 'string' ? note.relativePath : 'unknown';
  let normalizedPath: string;
  try {
    normalizedPath = normalizeSourcePath(relativePath);
  } catch (error: unknown) {
    return {
      kind: 'skipped',
      relativePath,
      reason: `invalid source path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (!Buffer.isBuffer(note.bytes)) {
    return { kind: 'skipped', relativePath: normalizedPath, reason: 'source bytes are not a Buffer' };
  }
  const decoded = note.bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(note.bytes)) {
    return { kind: 'skipped', relativePath: normalizedPath, reason: 'source is not valid UTF-8' };
  }
  const parsed = parseFrontmatter(decoded);
  if ('error' in parsed) return { kind: 'skipped', relativePath: normalizedPath, reason: parsed.error };
  if (parsed.body.trim() === '') {
    return { kind: 'skipped', relativePath: normalizedPath, reason: 'empty body' };
  }

  const fields = parseNoteFields(parsed.frontmatter);
  if ('error' in fields) return { kind: 'skipped', relativePath: normalizedPath, reason: fields.error };
  const timestamp = timestampForNote(parsed.frontmatter, normalizedPath, note.metadata);
  if ('error' in timestamp) {
    return { kind: 'skipped', relativePath: normalizedPath, reason: timestamp.error };
  }
  const runTimestamp = timestampValue(capturedAt);
  if (!runTimestamp) {
    return { kind: 'skipped', relativePath: normalizedPath, reason: 'invalid import timestamp' };
  }

  const type = fields.tags.find(isMemoryType) || 'fact';
  const concepts: string[] = [];
  const conceptSet = new Set<string>();
  for (const tag of fields.tags) {
    if (tag === 'memory' || tag === fields.project || conceptSet.has(tag)) continue;
    conceptSet.add(tag);
    concepts.push(tag);
  }
  const sourceConcept = `obsidian-source:${normalizedPath}`;
  if (!conceptSet.has(sourceConcept)) concepts.push(sourceConcept);

  const memory: ImportedMemory = {
    id: sourceIdentity(normalizedPath),
    createdAt: timestamp.timestamp,
    updatedAt: timestamp.timestamp,
    type,
    title: titleFromBody(parsed.body, filenameStem(normalizedPath)),
    content: parsed.body,
    concepts,
    files: [normalizedPath],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    ...(fields.project ? { project: fields.project } : {}),
    origin: {
      channel: 'import',
      detail: JSON.stringify({
        sourcePath: normalizedPath,
        tags: fields.tags,
        sessions: fields.sessions,
      }),
      capturedAt: runTimestamp,
    },
  };

  if (!isImportedMemory(memory)) {
    return { kind: 'skipped', relativePath: normalizedPath, reason: 'record failed runtime validation' };
  }
  return { kind: 'prepared', relativePath: normalizedPath, memory };
}

function mapSourceNotes(
  notes: readonly SourceNote[],
  capturedAt = new Date().toISOString(),
): NoteOutcome[] {
  return notes.map((note) => mapSourceNote(note, capturedAt));
}

function discoverSourceNotes(vaultPath: string): SourceDiscovery {
  const realVaultPath = validateVaultRoot(vaultPath);
  const requestedMemoriesPath = nodePath.join(realVaultPath, 'memories');
  const realMemoriesPath = realDirectory(requestedMemoriesPath, 'memories directory');
  if (!isContained(realMemoriesPath, realVaultPath)) {
    fail(`memories directory escapes vault path: ${requestedMemoriesPath}`);
  }

  const names = listDirectMarkdownChildren(realMemoriesPath);
  const notes: SourceNote[] = [];
  const skipped: SourceIssue[] = [];
  for (const name of names) {
    const relativePath = relativeSourcePath(name);
    const result = readRegularSource(
      nodePath.join(realMemoriesPath, name),
      relativePath,
      realMemoriesPath,
    );
    if ('bytes' in result) notes.push(result);
    else skipped.push(result);
  }

  return {
    sourcePath: realVaultPath,
    memoriesPath: realMemoriesPath,
    discovered: names.length,
    notes,
    skipped,
  };
}

function prepareSource(options: SourceOptions): PreparedSource {
  const capturedAt = new Date().toISOString();
  const discovery = discoverSourceNotes(options.vaultPath);
  const mapped = mapSourceNotes(discovery.notes, capturedAt);
  const outcomes: NoteOutcome[] = [
    ...discovery.skipped.map((issue) => ({ kind: 'skipped' as const, ...issue })),
    ...mapped,
  ];
  outcomes.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const memories = outcomes.flatMap((outcome) => (
    outcome.kind === 'prepared' ? [outcome.memory] : []
  ));
  return {
    sourcePath: discovery.sourcePath,
    discovered: discovery.discovered,
    capturedAt,
    outcomes,
    memories,
  };
}

function prepare(options: SourceOptions): readonly NoteOutcome[] {
  return prepareSource(options).outcomes;
}

function normalizeObsidianImportUrl(rawUrl: string): string {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('AgentMemory endpoint is required');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('AgentMemory endpoint must be a valid absolute URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('AgentMemory endpoint must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw new Error('AgentMemory endpoint must not contain credentials');
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = pathname.endsWith('/agentmemory/import')
    ? pathname
    : `${pathname}/agentmemory/import`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

type ImportSubmissionErrorCode =
  | 'invalid submitted memory count'
  | 'transport failure'
  | 'unreadable response'
  | 'authentication rejection'
  | 'http failure'
  | 'invalid JSON'
  | 'invalid response counts'
  | 'logical rejection';

function submissionErrorMessage(
  code: ImportSubmissionErrorCode,
  status?: number,
): string {
  if (code === 'http failure') {
    return typeof status === 'number'
      && Number.isSafeInteger(status)
      && status >= 100
      && status <= 599
      ? `AgentMemory import returned HTTP ${status}`
      : 'AgentMemory import returned an HTTP error';
  }
  switch (code) {
    case 'invalid submitted memory count':
      return 'invalid submitted memory count';
    case 'transport failure':
      return 'transport failure';
    case 'unreadable response':
      return 'AgentMemory import returned an unreadable response';
    case 'authentication rejection':
      return 'authentication rejected by AgentMemory';
    case 'invalid JSON':
      return 'AgentMemory import returned invalid JSON';
    case 'invalid response counts':
      return 'AgentMemory import returned invalid response counts';
    case 'logical rejection':
      return 'AgentMemory import rejected the batch';
  }
}

class ImportSubmissionError extends Error {
  code: ImportSubmissionErrorCode;
  status?: number;
  terminalAuthentication: boolean;

  constructor(code: ImportSubmissionErrorCode, status?: number) {
    super(submissionErrorMessage(code, status));
    this.name = 'ImportSubmissionError';
    this.code = code;
    this.status = status;
    this.terminalAuthentication = code === 'authentication rejection';
  }
}

function isAuthenticationRejection(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return /\b(?:auth|authentication|authorization|unauthorized|forbidden)\b/i.test(value)
    || /\b(?:access\s+denied|authentication\s+failed)\b/i.test(value)
    || /\b(?:invalid|missing|expired)\s+(?:bearer|token|credential|api\s*key)s?\b/i.test(value);
}

function responseSignalsAuthentication(responseText: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    return false;
  }
  if (!isObject(parsed)) return false;
  return ['error', 'message', 'reason'].some((key) => isAuthenticationRejection(parsed[key]));
}

function safeSubmissionMessage(error: unknown): string {
  if (!(error instanceof ImportSubmissionError)) return 'transport failure';
  switch (error.code) {
    case 'invalid submitted memory count':
    case 'transport failure':
    case 'unreadable response':
    case 'authentication rejection':
    case 'http failure':
    case 'invalid JSON':
    case 'invalid response counts':
    case 'logical rejection':
      return submissionErrorMessage(error.code, error.status);
    default:
      return 'transport failure';
  }
}

async function submitObsidianImportBatch(
  endpoint: string,
  requestBody: string,
  bearer: string,
  submittedMemoryCount: number,
): Promise<ImportSuccess> {
  if (!Number.isSafeInteger(submittedMemoryCount) || submittedMemoryCount < 0) {
    throw new ImportSubmissionError('invalid submitted memory count');
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
      },
      body: requestBody,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new ImportSubmissionError('transport failure');
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch {
    throw new ImportSubmissionError('unreadable response');
  }

  if (response.status === 401 || response.status === 403) {
    throw new ImportSubmissionError('authentication rejection', response.status);
  }
  if (!response.ok) {
    if (responseSignalsAuthentication(responseText)) {
      throw new ImportSubmissionError('authentication rejection');
    }
    throw new ImportSubmissionError('http failure', response.status);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new ImportSubmissionError('invalid JSON');
  }
  if (
    isObject(parsed)
    && ['error', 'message', 'reason'].some((key) => isAuthenticationRejection(parsed[key]))
  ) {
    throw new ImportSubmissionError('authentication rejection');
  }
  if (!isImportResponse(parsed, submittedMemoryCount)) {
    throw new ImportSubmissionError('invalid response counts');
  }
  if (parsed.success === false) {
    throw new ImportSubmissionError('logical rejection');
  }
  return parsed;
}

function baseImportReport(source: PreparedSource, dryRun: boolean): ObsidianImportReport {
  const skipped = source.outcomes.flatMap((outcome) => (
    outcome.kind === 'skipped'
      ? [{ relativePath: outcome.relativePath, reason: outcome.reason }]
      : []
  ));
  return {
    sourcePath: source.sourcePath,
    dryRun,
    counts: {
      discovered: source.discovered,
      eligible: source.memories.length,
      imported: 0,
      alreadyPresent: 0,
      skipped: skipped.length,
      failed: 0,
    },
    batches: { submitted: 0, succeeded: 0, failed: 0 },
    skipped,
    failures: [],
  };
}

function addFailure(
  report: ObsidianImportReport,
  seen: Set<string>,
  relativePath: string,
  reason: string,
): void {
  if (seen.has(relativePath)) return;
  seen.add(relativePath);
  report.failures.push({ relativePath, reason });
  report.counts.failed += 1;
}

async function execute(
  options: SourceOptions,
  mode: ImportMode,
): Promise<ObsidianImportReport> {
  const source = prepareSource(options);
  const report = baseImportReport(source, mode.kind === 'dry-run');
  const built = buildImportBatches(source.memories, source.capturedAt);
  const failedPaths = new Set<string>();

  for (const oversized of built.oversized) {
    addFailure(report, failedPaths, oversized.relativePath, oversized.reason);
  }

  if (mode.kind === 'dry-run') return report;
  if (
    mode.kind !== 'live'
    || typeof mode.endpoint !== 'string'
    || mode.endpoint.trim() === ''
    || typeof mode.bearer !== 'string'
    || mode.bearer === ''
  ) {
    throw new Error('live mode requires a non-empty endpoint and bearer');
  }

  const endpoint = normalizeObsidianImportUrl(mode.endpoint);
  for (let index = 0; index < built.batches.length; index += 1) {
    const batch = built.batches[index];
    report.batches.submitted += 1;
    try {
      const response = await submitObsidianImportBatch(
        endpoint,
        batch.body,
        mode.bearer,
        batch.records.length,
      );
      report.counts.imported += response.memories;
      report.counts.alreadyPresent += response.skipped;
      report.batches.succeeded += 1;
    } catch (error: unknown) {
      const terminalAuthentication = error instanceof ImportSubmissionError
        && error.terminalAuthentication;
      const reason = terminalAuthentication
        ? 'authentication rejected by AgentMemory'
        : safeSubmissionMessage(error);
      report.batches.failed += 1;
      for (const record of batch.records) {
        addFailure(report, failedPaths, record.files[0], reason);
      }
      if (terminalAuthentication) {
        for (let remainingIndex = index + 1; remainingIndex < built.batches.length; remainingIndex += 1) {
          for (const record of built.batches[remainingIndex].records) {
            addFailure(
              report,
              failedPaths,
              record.files[0],
              'authentication rejected before this batch was submitted',
            );
          }
        }
        break;
      }
    }
  }

  return report;
}

type ObsidianCliOptions = {
  vaultPath: string | null;
  dryRun: boolean;
  endpoint: string | null;
  help: boolean;
};

function parseObsidianArguments(argv: string[]): ObsidianCliOptions {
  let vaultPath: string | null = null;
  let dryRun = false;
  let endpoint: string | null = null;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      help = true;
    } else if (argument === '--dry-run') {
      dryRun = true;
    } else if (argument === '--json') {
      // JSON is the only report format; keep the flag compatible with import scripts.
    } else if (argument === '--endpoint' || argument === '--url') {
      endpoint = argv[index + 1] || null;
      index += 1;
      if (!endpoint) throw new Error('an endpoint is required after --endpoint');
    } else if (argument.startsWith('-')) {
      throw new Error(`unknown argument: ${argument}`);
    } else if (vaultPath === null) {
      vaultPath = argument;
    } else {
      throw new Error('only one vault path may be supplied');
    }
  }

  if (!help && vaultPath === null) throw new Error('an absolute vault path is required');
  if (vaultPath?.includes('\0')) throw new Error('vault path contains a NUL byte');
  return { vaultPath, dryRun, endpoint, help };
}

function obsidianHelpText(): string {
  return [
    'Usage: agentmemory-import-obsidian <absolute-vault-path> [--dry-run]',
    '',
    'Import direct Markdown memory notes from an Obsidian vault into AgentMemory.',
    'Live imports use AGENTMEMORY_URL and AGENTMEMORY_SECRET without printing the bearer.',
    '',
    'Options:',
    '  --dry-run       validate and report notes without contacting AgentMemory',
    '  --help          show this help text',
  ].join('\n') + '\n';
}

async function obsidianMain(argv: string[] = process.argv.slice(2)): Promise<ObsidianImportReport | undefined> {
  const options = parseObsidianArguments(argv);
  if (options.help) {
    process.stdout.write(obsidianHelpText());
    return undefined;
  }
  if (options.vaultPath === null) throw new Error('an absolute vault path is required');

  const mode: ImportMode = options.dryRun
    ? { kind: 'dry-run' }
    : {
        kind: 'live',
        endpoint: options.endpoint
          || process.env.AGENTMEMORY_URL
          || process.env.AGENTMEMORY_IMPORT_ENDPOINT
          || '',
        bearer: process.env.AGENTMEMORY_SECRET || process.env.AGENTMEMORY_BEARER || '',
      };
  const report = await execute({ vaultPath: options.vaultPath }, mode);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.counts.failed > 0) process.exitCode = 1;
  return report;
}

module.exports = {
  MAX_IMPORT_BYTES: OBSIDIAN_MAX_IMPORT_BYTES,
  MAX_IMPORT_MEMORIES: OBSIDIAN_MAX_IMPORT_MEMORIES,
  buildImportBatches,
  createImportRequest,
  discoverSourceNotes,
  execute,
  main: obsidianMain,
  normalizeImportUrl: normalizeObsidianImportUrl,
  parseArguments: parseObsidianArguments,
  prepare,
  submitImportBatch: submitObsidianImportBatch,
  isContained,
  isImportRequest,
  isImportResponse,
  isImportSuccess,
  isImportedMemory,
  mapSourceNote,
  mapSourceNotes,
  serializeImportRequest,
};

if (require.main === module) {
  obsidianMain()
    .then(() => {
      if (process.exitCode === undefined) process.exitCode = 0;
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`agentmemory-import-obsidian: ${message}\n`);
      process.exitCode = 1;
    });
}
