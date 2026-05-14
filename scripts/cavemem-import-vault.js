#!/usr/bin/env node
/*
 * cavemem-import-vault.js — one-shot importer for legacy Obsidian
 * transcription/summary notes into cavemem's SQLite store.
 *
 * Task 7.2 of .kiro/specs/cavemem-integration. Implements
 * Requirements 8.1–8.8.
 *
 * Inputs (env vars, baked at HM build time by the wrapping
 * `scripts/cavemem-import-vault.nix` writeShellApplication):
 *   - CAVEMEM_VAULT_PATH: absolute path to the Obsidian vault root.
 *     Walks `${vault}/conversations/transcriptions/*.md` and
 *     `${vault}/conversations/summaries/*.md`.
 *   - CAVEMEM_DATA_DIR: absolute path to cavemem's data directory.
 *     The SQLite database is opened at `${dataDir}/data.db` (cavemem
 *     v0.2.1 uses `data.db`, NOT `cavemem.db` as task notes state —
 *     verified against packages/hooks/src/runner.ts and
 *     packages/storage/src/storage.ts at v0.2.1).
 *
 * Resolved schema (verified against
 * github.com/JuliusBrussee/cavemem packages/storage/src/schema.ts at
 * v0.2.1):
 *   sessions    (id TEXT PK, ide TEXT NOT NULL, cwd TEXT,
 *                started_at INTEGER NOT NULL, ended_at INTEGER,
 *                metadata TEXT)
 *   observations(id INTEGER PK AUTOINCREMENT,
 *                session_id TEXT NOT NULL FK -> sessions(id),
 *                kind TEXT NOT NULL, content TEXT NOT NULL,
 *                compressed INTEGER NOT NULL DEFAULT 1,
 *                intensity TEXT, ts INTEGER NOT NULL, metadata TEXT)
 *   summaries   (id INTEGER PK AUTOINCREMENT,
 *                session_id TEXT NOT NULL FK -> sessions(id),
 *                scope TEXT NOT NULL CHECK(scope IN ('turn','session')),
 *                content TEXT NOT NULL,
 *                compressed INTEGER NOT NULL DEFAULT 1,
 *                intensity TEXT, ts INTEGER NOT NULL)
 *
 * Two notable schema realities the design.md did not anticipate:
 *
 * 1. `sessions.id` is TEXT (not INTEGER auto-increment). We synthesize
 *    a stable, deterministic id derived from the source file path so
 *    re-runs land on the same row.
 *
 * 2. `summaries` has NO `metadata` column. The
 *    "WHERE json_extract(metadata, '$.import_hash') = ?" idempotency
 *    contract from the task brief therefore cannot apply directly to
 *    summaries — we instead dedup summaries by
 *    `(session_id, scope, content)`, which is content-addressed and
 *    safe under re-runs.
 *
 * 3. `summaries.session_id` is NOT NULL with FK to sessions(id).
 *    The task brief permits "session_id NULL when no match" but the
 *    schema rejects it. We synthesize a placeholder session for
 *    orphan summaries (marked with metadata.summary_only=true) to
 *    satisfy both the FK constraint and Req 8.4's "INSERT one row
 *    per summary file" contract without losing data.
 *
 * Idempotency: per-table content-derived `import_hash` (sha256 of the
 * source file path + canonicalized payload). Sessions store the hash
 * in metadata.import_hash; observations carry their own per-row hash.
 * Summaries lack a metadata column and are deduped by
 * (session_id, scope, content) instead — same content-addressed
 * semantics, schema-compatible mechanism.
 *
 * Failure modes:
 *   - Missing env vars            → exit 2 with stderr message.
 *   - Missing ${dataDir}/data.db  → exit 1 with bootstrap instructions
 *                                   (Req 8.7, task pre-flight).
 *   - YAML parse / read error     → log to stderr, skip the file,
 *                                   continue (no crash).
 *
 * Final stdout line reports per-table inserted/skipped counts (Req 8.8).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Database = require('better-sqlite3');
const yaml = require('js-yaml');

function err(msg) {
  process.stderr.write(msg.endsWith('\n') ? msg : msg + '\n');
}

function die(msg, code) {
  err(msg);
  process.exit(code);
}

const VAULT = process.env.CAVEMEM_VAULT_PATH;
const DATA_DIR = process.env.CAVEMEM_DATA_DIR;

if (!VAULT || VAULT.trim() === '') {
  die('cavemem-import-vault: CAVEMEM_VAULT_PATH env var must be set to an absolute vault path', 2);
}
if (!DATA_DIR || DATA_DIR.trim() === '') {
  die('cavemem-import-vault: CAVEMEM_DATA_DIR env var must be set to an absolute cavemem dataDir', 2);
}

const dbPath = path.join(DATA_DIR, 'data.db');
if (!fs.existsSync(dbPath)) {
  die(
    `cavemem-import-vault: ${dbPath} not found.\n` +
      'Run `cavemem` once first to bootstrap the cavemem schema before importing the vault.\n' +
      "  e.g.: echo '{\"session_id\":\"bootstrap\",\"cwd\":\"/tmp\"}' | cavemem hook run session-start",
    1,
  );
}

function splitFrontmatter(text) {
  // Accept LF and CRLF leading delimiters; the second --- can sit on
  // its own line at any column 0 boundary.
  const head = text.slice(0, 4);
  if (head !== '---\n' && head !== '---\r') {
    return { fm: null, body: text };
  }
  const after = head === '---\n' ? 4 : 5; // '---\r\n' is 5 bytes
  const re = /\r?\n---\r?\n/;
  re.lastIndex = after;
  const tail = text.slice(after);
  const m = tail.match(re);
  if (!m) return { fm: null, body: text };
  const fmEnd = after + m.index;
  const bodyStart = fmEnd + m[0].length;
  return { fm: text.slice(after, fmEnd), body: text.slice(bodyStart) };
}

function parseDateMs(d) {
  if (typeof d === 'string') {
    const t = Date.parse(`${d}T00:00:00Z`);
    if (!Number.isNaN(t)) return t;
  }
  if (d instanceof Date) return d.getTime();
  return null;
}

function parseSessionMarker(marker, fallbackDate) {
  // Expected: 2026-05-13T143022 (YYYY-MM-DDThhmmss, no separators in
  // the time half); fall back to the frontmatter date or "now" if
  // the marker is unrecognizable.
  if (typeof marker === 'string') {
    const compact = marker.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})$/);
    if (compact) {
      const t = Date.parse(`${compact[1]}T${compact[2]}:${compact[3]}:${compact[4]}Z`);
      if (!Number.isNaN(t)) return t;
    }
    const iso = Date.parse(marker);
    if (!Number.isNaN(iso)) return iso;
  }
  return parseDateMs(fallbackDate) ?? Date.now();
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function makeSessionId(prefix, key) {
  // Deterministic, stable across re-runs; collision-resistant within
  // the migration namespace (prefix + 16 hex chars = 64 bits of
  // entropy is fine for ~hundreds of rows).
  return `${prefix}-${sha256(key).slice(0, 16)}`;
}

function listMd(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.md'))
    .map((f) => path.join(dir, f))
    .sort();
}

function parseExchanges(body) {
  // Find every "## Exchange N" header at column 0; the body of an
  // exchange runs from the end of its header to the start of the next
  // (or EOF). Within each block, split on the literal markers
  // "**User:**" and "**Assistant:**".
  const headerRe = /^## Exchange (\d+)\s*$/gm;
  const headers = [];
  let m;
  while ((m = headerRe.exec(body)) !== null) {
    headers.push({ idx: m.index, end: headerRe.lastIndex, num: parseInt(m[1], 10) });
  }
  const out = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i].end;
    const stop = i + 1 < headers.length ? headers[i + 1].idx : body.length;
    const block = body.slice(start, stop).trim();
    const userIdx = block.indexOf('**User:**');
    const asstIdx = block.indexOf('**Assistant:**');
    let user = '';
    let assistant = '';
    if (userIdx !== -1) {
      const userStop = asstIdx !== -1 && asstIdx > userIdx ? asstIdx : block.length;
      user = block.slice(userIdx + '**User:**'.length, userStop).trim();
    }
    if (asstIdx !== -1) {
      assistant = block.slice(asstIdx + '**Assistant:**'.length).trim();
    }
    out.push({ num: headers[i].num, user, assistant });
  }
  return out;
}

const db = new Database(dbPath);
// Foreign keys are not on by default per-connection; the schema's
// PRAGMA only fires when cavemem itself opens the file. We enforce
// here so observations.session_id / summaries.session_id FKs behave
// as cavemem expects at insert time.
db.pragma('foreign_keys = ON');

const stmts = {
  checkSessionByHash: db.prepare(
    "SELECT id FROM sessions WHERE json_extract(metadata, '$.import_hash') = ? LIMIT 1",
  ),
  findSessionByMarker: db.prepare(
    "SELECT id FROM sessions WHERE json_extract(metadata, '$.session_marker') = ? LIMIT 1",
  ),
  insertSession: db.prepare(
    'INSERT INTO sessions(id, ide, cwd, started_at, ended_at, metadata) VALUES (?, ?, ?, ?, ?, ?)',
  ),
  insertObservation: db.prepare(
    'INSERT INTO observations(session_id, kind, content, compressed, intensity, ts, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ),
  // summaries lacks metadata; dedup by content fingerprint scoped to
  // its (synthesised or matched) session_id.
  checkSummary: db.prepare(
    'SELECT id FROM summaries WHERE session_id = ? AND scope = ? AND content = ? LIMIT 1',
  ),
  insertSummary: db.prepare(
    'INSERT INTO summaries(session_id, scope, content, compressed, intensity, ts) VALUES (?, ?, ?, ?, ?, ?)',
  ),
};

const stats = {
  sessionsInserted: 0,
  sessionsSkipped: 0,
  observationsInserted: 0,
  observationsSkipped: 0,
  summariesInserted: 0,
  summariesSkipped: 0,
  fileErrors: 0,
};

function readVaultFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    err(`cavemem-import-vault: failed to read ${filePath}: ${e.message}; skipping`);
    stats.fileErrors++;
    return null;
  }
  const { fm, body } = splitFrontmatter(raw);
  if (fm === null) {
    err(`cavemem-import-vault: no YAML frontmatter in ${filePath}; skipping`);
    stats.fileErrors++;
    return null;
  }
  let frontmatter;
  try {
    frontmatter = yaml.load(fm);
  } catch (e) {
    err(`cavemem-import-vault: yaml parse error in ${filePath}: ${e.message}; skipping`);
    stats.fileErrors++;
    return null;
  }
  if (!frontmatter || typeof frontmatter !== 'object') {
    err(`cavemem-import-vault: empty or non-object frontmatter in ${filePath}; skipping`);
    stats.fileErrors++;
    return null;
  }
  return { raw, body, frontmatter };
}

const transcriptionsDir = path.join(VAULT, 'conversations', 'transcriptions');
const summariesDir = path.join(VAULT, 'conversations', 'summaries');

// --- Transcriptions ---
for (const filePath of listMd(transcriptionsDir)) {
  const parsed = readVaultFile(filePath);
  if (!parsed) continue;

  const { raw, body, frontmatter } = parsed;
  const sessionMarker = typeof frontmatter.session === 'string' ? frontmatter.session : '';
  const project = typeof frontmatter.project === 'string' ? frontmatter.project : 'unknown';
  const startedAt = parseSessionMarker(sessionMarker, frontmatter.date);
  const importHash = sha256(`transcription:${path.relative(VAULT, filePath)}:${raw}`);

  if (stmts.checkSessionByHash.get(importHash)) {
    stats.sessionsSkipped++;
    // Account for the observations we would have inserted if this
    // session were new — keeps the final skip count operator-readable
    // (otherwise "0 observations skipped" against a fully-imported
    // vault could mislead an operator into thinking the session-level
    // skip didn't propagate).
    for (const ex of parseExchanges(body)) {
      if (ex.user) stats.observationsSkipped++;
      if (ex.assistant) stats.observationsSkipped++;
    }
    continue;
  }

  const sessionId = makeSessionId('migrated', `transcription:${path.relative(VAULT, filePath)}`);
  const sessionMetadata = JSON.stringify({
    migrated: true,
    import_hash: importHash,
    source_path: path.relative(VAULT, filePath),
    project,
    session_marker: sessionMarker,
  });

  // One transaction per file: either the session and ALL its
  // observations land, or nothing does. Cleaner partial-failure
  // semantics than per-row commits and lets the next re-run pick up
  // a clean slate.
  const tx = db.transaction(() => {
    stmts.insertSession.run(
      sessionId,
      'obsidian-migration',
      `/migrated/${project}`,
      startedAt,
      null,
      sessionMetadata,
    );
    stats.sessionsInserted++;
    const exchanges = parseExchanges(body);
    for (const ex of exchanges) {
      // Offset each observation a tiny bit so timeline ordering is
      // stable even though all observations share the same source date.
      const baseTs = startedAt + ex.num * 2;
      if (ex.user) {
        const obsHash = sha256(`${importHash}:obs:${ex.num}:prompt`);
        stmts.insertObservation.run(
          sessionId,
          'prompt',
          ex.user,
          0,
          null,
          baseTs,
          JSON.stringify({
            migrated: true,
            exchange_index: ex.num,
            import_hash: obsHash,
            parent_import_hash: importHash,
          }),
        );
        stats.observationsInserted++;
      }
      if (ex.assistant) {
        const obsHash = sha256(`${importHash}:obs:${ex.num}:response`);
        stmts.insertObservation.run(
          sessionId,
          'response',
          ex.assistant,
          0,
          null,
          baseTs + 1,
          JSON.stringify({
            migrated: true,
            exchange_index: ex.num,
            import_hash: obsHash,
            parent_import_hash: importHash,
          }),
        );
        stats.observationsInserted++;
      }
    }
  });
  tx();
}

// --- Summaries ---
for (const filePath of listMd(summariesDir)) {
  const parsed = readVaultFile(filePath);
  if (!parsed) continue;

  const { body, frontmatter } = parsed;
  const sessionMarker = typeof frontmatter.session === 'string' ? frontmatter.session : '';
  const project = typeof frontmatter.project === 'string' ? frontmatter.project : 'unknown';
  const ts = parseSessionMarker(sessionMarker, frontmatter.date);
  const content = body.trim();

  // Resolve session_id by matching session_marker against migrated
  // sessions. If no match, synthesise a placeholder session — the
  // schema enforces summaries.session_id NOT NULL, so the task
  // brief's "or NULL" branch isn't reachable. The placeholder is
  // marked with metadata.summary_only=true so a future operator
  // can distinguish it from real migrated sessions.
  let sessionId = null;
  if (sessionMarker) {
    const matched = stmts.findSessionByMarker.get(sessionMarker);
    if (matched) sessionId = matched.id;
  }
  if (!sessionId) {
    const placeholderHash = sha256(`summary-only:${path.relative(VAULT, filePath)}`);
    const existing = stmts.checkSessionByHash.get(placeholderHash);
    if (existing) {
      sessionId = existing.id;
    } else {
      sessionId = makeSessionId('migrated-summary', path.relative(VAULT, filePath));
      stmts.insertSession.run(
        sessionId,
        'obsidian-migration',
        `/migrated/${project}/summary-only`,
        ts,
        null,
        JSON.stringify({
          migrated: true,
          summary_only: true,
          import_hash: placeholderHash,
          source_path: path.relative(VAULT, filePath),
          project,
          session_marker: sessionMarker,
        }),
      );
      stats.sessionsInserted++;
    }
  }

  if (stmts.checkSummary.get(sessionId, 'session', content)) {
    stats.summariesSkipped++;
    continue;
  }

  stmts.insertSummary.run(sessionId, 'session', content, 0, null, ts);
  stats.summariesInserted++;
}

db.close();

process.stdout.write(
  `cavemem-import-vault: imported ${stats.sessionsInserted} sessions, ` +
    `${stats.observationsInserted} observations, ${stats.summariesInserted} summaries ` +
    `(skipped: ${stats.sessionsSkipped} sessions, ` +
    `${stats.observationsSkipped} observations, ${stats.summariesSkipped} summaries; ` +
    `${stats.fileErrors} file errors)\n`,
);
