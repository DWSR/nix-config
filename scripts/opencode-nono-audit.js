/*
 * scripts/opencode-nono-audit.js — entry point for the
 * opencode-nono-audit CLI (opencode-nono-audit spec, Task 1.2,
 * Requirement 1.1).
 *
 * This is the SCAFFOLD stub. It supports the two short-circuit flags
 * required by the observable completion (`--help`, `--version`) and a
 * `require.main === module` script-vs-module guard so the file is
 * cleanly `require()`-able by the node:test suite without triggering
 * CLI side effects. Subsequent tasks fill in the audit / assess /
 * review business logic; there is intentionally none here yet.
 *
 * The `.nix` wrapper (scripts/opencode-nono-audit.nix) execs this
 * file via the repo nodejs, exporting NODE_PATH against the vendored
 * `opencode-cost-diagnosis-deps` tree and OPENCODE_NONO_COST_REPORT_LIB
 * pointing at the sibling cost-report library. The audit code below
 * does `require(process.env.OPENCODE_NONO_COST_REPORT_LIB)` for
 * SqliteReader at runtime, falling back to a relative require of the
 * sibling cost-report script (resolved from __dirname) when that env
 * var is unset — which is the case under `node --test`, where tests
 * pass fixture paths directly to runAudit().
 *
 * ─────────────────────────────────────────────────────────────────
 * Task 2.1 (Requirements 1.1, 1.3, 1.4, 1.5, 1.6) adds runAudit's
 * SOURCE-OPENING layer: open the OpenCode session DB read-only via the
 * reused SqliteReader, optionally open the cavemem data.db read-only as
 * a version-guarded secondary source, track per-source SourceStatus,
 * mark the report `partial` on any degraded source, and return an
 * error Result (no UsageAudit / no assessment) when no source is
 * readable at all (R1.5).
 *
 * ─────────────────────────────────────────────────────────────────
 * Task 2.2 (Requirements 1.2, 1.3) adds the OBSERVED-CAPABILITY MODEL:
 * while the session reader from 2.1 is open, iterate its tool parts
 * (root session + sub-agent descendant sessions) into
 * CapabilityRecord[]. Tool name + count + output are derived reliably
 * (high confidence). command/path/URL are derived best-effort from
 * STRUCTURED `state.input` keys only (high confidence); path-like or
 * URL-like substrings buried in command strings are NOT promoted.
 * ports/envVars are inference-only on the current DB shape, so their
 * arrays stay empty and the class is disclosed in unobservableClasses.
 * cavemem (R1.3) is a best-effort LOW-confidence secondary context
 * source — it never fabricates high-confidence capabilities. Raw
 * strings are extracted UNREDACTED here; redaction is applied at
 * serialization (task 5.1).
 * ─────────────────────────────────────────────────────────────────
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const VERSION = '0.0.0';

/**
 * Resolve and load the reused cost-report library (SqliteReader +
 * SchemaDriftError). The `.nix` wrapper exports
 * OPENCODE_NONO_COST_REPORT_LIB to the store path of
 * scripts/opencode-cost-report.js; under `node --test` that env var is
 * unset, so we fall back to the sibling script resolved from this
 * file's directory. Either way the reader opens sources read-only
 * (SqliteReader uses `{ readonly: true, fileMustExist: true }`).
 *
 * @returns {{ SqliteReader: Function, SchemaDriftError: Function }}
 */
function loadCostReportLib() {
  const fromEnv = process.env.OPENCODE_NONO_COST_REPORT_LIB;
  const libPath =
    fromEnv && fromEnv.length > 0
      ? fromEnv
      : path.resolve(__dirname, 'opencode-cost-report.js');
  return require(libPath);
}

/**
 * Resolve the default OpenCode session DB path when the caller gives
 * none: `OPENCODE_DB_PATH` else `${XDG_DATA_HOME:-~/.local/share}/
 * opencode/opencode-stable.db`.
 *
 * @returns {string}
 */
function defaultSessionDbPath() {
  if (process.env.OPENCODE_DB_PATH && process.env.OPENCODE_DB_PATH.length > 0) {
    return process.env.OPENCODE_DB_PATH;
  }
  const xdgData =
    process.env.XDG_DATA_HOME && process.env.XDG_DATA_HOME.length > 0
      ? process.env.XDG_DATA_HOME
      : path.join(process.env.HOME || '', '.local', 'share');
  return path.join(xdgData, 'opencode', 'opencode-stable.db');
}

/**
 * The cavemem `data.db` schema version this audit understands. The
 * fixture (and the live cavemem store) is schema_version = 2; opening a
 * cavemem DB whose `schema_version.version` differs is treated as an
 * `incompatible` source (version guard, R1.3), never a crash.
 */
const SUPPORTED_CAVEMEM_SCHEMA_VERSION = 2;

/**
 * Open the OpenCode session DB read-only via the reused SqliteReader
 * and classify the result into a SourceStatus.
 *
 * - Success → `{ status: 'ok' }`, with the open reader returned so the
 *   capability parser (task 2.2) can iterate it. The caller owns
 *   closing the reader.
 * - SchemaDriftError (or any other open failure that is not a plain
 *   missing/unreadable file) → `{ status: 'incompatible' }`; NEVER
 *   crashes on drift (R1.4).
 * - Missing / unreadable file → `{ status: 'missing' }` (the reader
 *   wraps SQLITE_CANTOPEN / ENOENT and attaches `.dbPath`).
 *
 * @param {string} dbPath
 * @param {{ SqliteReader: Function, SchemaDriftError: Function }} lib
 * @returns {{ status: { source: 'opencode-sqlite', status: string, detail?: string }, reader: object|null }}
 */
function openSessionSource(dbPath, lib) {
  const { SqliteReader, SchemaDriftError } = lib;
  const reader = new SqliteReader();
  try {
    reader.open(dbPath);
    return {
      status: { source: 'opencode-sqlite', status: 'ok' },
      reader,
    };
  } catch (e) {
    // Best-effort: a failed open() already released its own handle, but
    // close defensively in case a future reader leaves one open.
    try {
      reader.close();
    } catch {
      /* reader never opened a handle; nothing to release */
    }

    if (e instanceof SchemaDriftError) {
      // Schema drift → incompatible source + partial; the reader cannot
      // be iterated. R1.4: degrade, never crash.
      const detail = `schema drift: detected [${(e.detectedMigrationSet || []).join(', ')}]`;
      return {
        status: { source: 'opencode-sqlite', status: 'incompatible', detail },
        reader: null,
      };
    }

    // Missing / unreadable file: the reader attaches `.dbPath` and a
    // descriptive message. We cannot distinguish ENOENT from EACCES
    // reliably across platforms, so a missing file existence check
    // disambiguates "missing" from "unreadable".
    const exists = fileExists(dbPath);
    const detail = e && e.message ? e.message : String(e);
    return {
      status: {
        source: 'opencode-sqlite',
        status: exists ? 'unreadable' : 'missing',
        detail,
      },
      reader: null,
    };
  }
}

/**
 * Open the cavemem `data.db` read-only as a best-effort SECONDARY
 * source, version-guarded on `schema_version.version` (R1.3).
 *
 * - Success at the supported schema version → `{ status: 'ok' }`.
 * - Wrong schema version → `{ status: 'incompatible' }`.
 * - Missing / unreadable file (or unexpected schema layout) →
 *   `{ status: 'missing' | 'unreadable' }`.
 *
 * The handle is opened `{ readonly: true, fileMustExist: true }` and is
 * closed before returning — task 2.1 only needs the version guard and
 * status; cavemem observation iteration is a task 2.2 concern.
 *
 * @param {string} cavememDbPath
 * @returns {{ source: 'cavemem', status: string, detail?: string }}
 */
function openCavememSource(cavememDbPath) {
  // better-sqlite3 is resolvable via NODE_PATH (wrapper) or the deps
  // tree the test node exports. Require lazily so a session-only audit
  // that never touches cavemem does not pay for it.
  const Database = require('better-sqlite3');

  let db = null;
  try {
    db = new Database(cavememDbPath, { readonly: true, fileMustExist: true });
    const row = db.prepare('SELECT version FROM schema_version').get();
    const version = row && typeof row.version !== 'undefined' ? row.version : null;
    if (version !== SUPPORTED_CAVEMEM_SCHEMA_VERSION) {
      return {
        source: 'cavemem',
        status: 'incompatible',
        detail: `unsupported cavemem schema_version ${String(version)} (expected ${SUPPORTED_CAVEMEM_SCHEMA_VERSION})`,
      };
    }
    return { source: 'cavemem', status: 'ok' };
  } catch (e) {
    const exists = fileExists(cavememDbPath);
    const detail = e && e.message ? e.message : String(e);
    return {
      source: 'cavemem',
      status: exists ? 'unreadable' : 'missing',
      detail,
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* best-effort handle release */
      }
    }
  }
}

/** True iff `p` names an existing path on disk. */
function fileExists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * R1.5's hard-fail discriminator: the audit returns an error Result
 * (no UsageAudit, no assessment) only when NO source was even openable
 * — i.e., every recorded source is `missing` or `unreadable`. An
 * `incompatible` source (schema drift / wrong cavemem version) IS a
 * source that was found and inspected; it degrades the report to
 * `partial` but the audit still proceeds and reports it. This matches
 * the task observable completion: the drift fixture produces
 * `incompatible` + partial (an ok Result), while the truly-empty
 * (missing/unreadable everything) case exits nonzero.
 *
 * @param {{ status: string }} status
 * @returns {boolean} true when this source can anchor a report.
 */
function isReportable(status) {
  return status.status === 'ok' || status.status === 'incompatible';
}

/**
 * Capability classes that are NOT derivable from the current OpenCode
 * session DB / cavemem shapes (Phase 0 source-fidelity decision,
 * tests/opencode-nono-audit/fixtures/phase0-source-fidelity-decision.md).
 * Disclosed in `UsageAudit.unobservableClasses` so the report states its
 * coverage gaps explicitly rather than implying full coverage. Sorted
 * and frozen for determinism (later 5.1/6.1 determinism assertions).
 *
 * @type {readonly string[]}
 */
const UNOBSERVABLE_CLASSES = Object.freeze([
  'device',
  'env-var',
  'ipc',
  'port',
  'process-signal',
  'unix-socket',
]);

/**
 * Structured `state.input` keys that yield a HIGH-confidence
 * filesystem-path. Only direct path keys count; path-like substrings
 * inside command strings are low-confidence hints and are NOT promoted
 * here (Phase 0 invariant: unmappable fields are omitted, not guessed).
 *
 * @type {readonly string[]}
 */
const STRUCTURED_PATH_KEYS = Object.freeze(['filePath', 'path']);

/**
 * Structured `state.input` keys that yield a HIGH-confidence
 * network-endpoint. URL-like substrings inside command strings are
 * low-confidence hints and are NOT promoted.
 *
 * @type {readonly string[]}
 */
const STRUCTURED_URL_KEYS = Object.freeze(['url']);

/**
 * Push `value` onto `arr` iff it is a non-empty string not already
 * present. Keeps derived arrays free of duplicates and empty entries
 * without reordering (insertion order preserved for determinism, since
 * parts iterate in a deterministic time_created/id order).
 *
 * @param {string[]} arr
 * @param {unknown} value
 */
function pushUniqueString(arr, value) {
  if (typeof value === 'string' && value.length > 0 && !arr.includes(value)) {
    arr.push(value);
  }
}

/**
 * Parse a part-row's `data` JSON defensively. Returns the parsed object
 * or null for malformed JSON (the reader already synthesizes
 * `part.type`, but we re-parse to read the tool name + state, mirroring
 * the cost-report consumer pattern).
 *
 * @param {{ data: string }} part
 * @returns {object|null}
 */
function parsePartData(part) {
  try {
    const parsed = JSON.parse(part.data);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Derive the high-confidence, structured fields of a single tool part
 * into the accumulating CapabilityRecord `rec`. Only STRUCTURED
 * `state.input` keys contribute; nothing is inferred from free text.
 *
 * - bash `state.input.command` → commands (external-command, high).
 * - structured path keys (filePath, path) → paths (filesystem-path, high).
 * - structured url keys (url) → endpoints (network-endpoint, high).
 * - ports / envVars: inference-only → never populated (disclosed in
 *   unobservableClasses instead).
 *
 * @param {{ commands: string[], paths: string[], endpoints: string[] }} rec
 * @param {object} data parsed part.data
 */
function deriveStructuredFields(rec, data) {
  const input =
    data && data.state && data.state.input && typeof data.state.input === 'object'
      ? data.state.input
      : null;
  if (!input) return;

  // External command (bash and any tool exposing a structured `command`).
  pushUniqueString(rec.commands, input.command);

  // Filesystem paths from structured path keys only.
  for (const key of STRUCTURED_PATH_KEYS) {
    pushUniqueString(rec.paths, input[key]);
  }

  // Network endpoints from structured URL keys only.
  for (const key of STRUCTURED_URL_KEYS) {
    pushUniqueString(rec.endpoints, input[key]);
  }
}

/**
 * Iterate every tool part across the readable session source — the root
 * sessions and their sub-agent descendant sessions — and fold them into
 * one CapabilityRecord per tool name. The reader MUST be open; the
 * caller owns closing it.
 *
 * Reliable derivations (high confidence): tool name (`data.tool ||
 * data.name`) and count (number of tool parts for that tool).
 * Best-effort structured derivations: command/path/URL via
 * {@link deriveStructuredFields}. A record's confidence is `high` when
 * it carries any structured derivation; `medium` when it has a name +
 * count but no structured args (still reliably observed, but its
 * capability surface could not be derived); records are tagged
 * `opencode-sqlite` as their source.
 *
 * Records are returned sorted by tool name for deterministic output.
 *
 * @param {object} reader an open SqliteReader
 * @returns {object[]} CapabilityRecord[]
 */
function extractCapabilities(reader) {
  /** @type {Map<string, object>} */
  const byTool = new Map();

  const recordPart = (data) => {
    const tool = data && (data.tool || data.name);
    if (typeof tool !== 'string' || tool.length === 0) return;

    let rec = byTool.get(tool);
    if (!rec) {
      rec = {
        tool,
        count: 0,
        commands: [],
        paths: [],
        endpoints: [],
        ports: [], // inference-only on the current DB shape → empty
        envVars: [], // inference-only on the current DB shape → empty
        confidence: 'high',
        sources: ['opencode-sqlite'],
      };
      byTool.set(tool, rec);
    }
    rec.count += 1;
    deriveStructuredFields(rec, data);
  };

  const collectParts = (sessionId) => {
    for (const part of reader.partsOfSession(sessionId)) {
      // Only tool parts carry a capability surface; skip text/etc.
      if (part.type && part.type !== 'tool') continue;
      const data = parsePartData(part);
      if (!data) continue; // malformed JSON → skip defensively
      if (!data.tool && !data.name) continue; // not a tool part
      recordPart(data);
    }
  };

  for (const root of reader.rootSessionsMatching({})) {
    collectParts(root.id);
    for (const desc of reader.descendantSessionsOf(root.id)) {
      collectParts(desc.id);
    }
  }

  // A record with a name + count but NO structured arguments was
  // reliably observed, but its capability surface could not be derived
  // from structured evidence. Downgrade its confidence to `medium` so
  // the report does not overclaim high-confidence coverage for it.
  for (const rec of byTool.values()) {
    const hasStructured =
      rec.commands.length > 0 || rec.paths.length > 0 || rec.endpoints.length > 0;
    if (!hasStructured) rec.confidence = 'medium';
  }

  // Deterministic ordering: sort by tool name.
  return [...byTool.values()].sort((a, b) => (a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0));
}

/**
 * Collect best-effort LOW-confidence context from the cavemem
 * `data.db`, opened read-only (R1.3). cavemem content is prose
 * prompt/response text, never structured tool calls (Phase 0), so it
 * NEVER fabricates high-confidence capabilities. We surface a small,
 * bounded set of session-context records (id + cwd) so the audit
 * genuinely uses cavemem as an additional source when available without
 * over-claiming. Each context entry is tagged `source: 'cavemem'`.
 *
 * Returns an empty array on any read failure — cavemem is best-effort
 * and its degraded status is already recorded as a SourceStatus by
 * {@link openCavememSource}.
 *
 * @param {string} cavememDbPath
 * @returns {Array<{ source: 'cavemem', sessionId: string, cwd: string|null, confidence: 'low' }>}
 */
function collectCavememContext(cavememDbPath) {
  const Database = require('better-sqlite3');
  let db = null;
  try {
    db = new Database(cavememDbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare('SELECT id, cwd FROM sessions ORDER BY id ASC')
      .all();
    return rows.map((r) => ({
      source: 'cavemem',
      sessionId: String(r.id),
      cwd: typeof r.cwd === 'string' ? r.cwd : null,
      confidence: 'low',
    }));
  } catch {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        /* best-effort handle release */
      }
    }
  }
}

/**
 * @typedef {object} AuditOptions
 * @property {string} [sessionDbPath] Override the OpenCode session DB
 *   path. Defaults to {@link defaultSessionDbPath}.
 * @property {string} [cavememDbPath] Optional cavemem data.db path. When
 *   omitted, cavemem is treated as not-configured (its absence is NOT a
 *   degradation and does NOT mark the report partial — R1.3).
 */

/**
 * runAudit — the read-only audit entry point. Task 2.1 implements the
 * source-opening layer only.
 *
 * Opens the OpenCode session DB read-only (R1.1) and, when configured,
 * the cavemem data.db read-only as a version-guarded secondary source
 * (R1.3). Records a SourceStatus per source; a degraded source marks
 * the report `partial` and is named in `sources[]` (R1.4). Never
 * mutates any source (R1.6: SqliteReader opens `{ readonly: true }`,
 * cavemem opens `{ readonly: true, fileMustExist: true }`). When NO
 * source is readable, returns an error Result with no UsageAudit and no
 * assessment (R1.5).
 *
 * @param {AuditOptions} [opts]
 * @returns {{ ok: true, value: object } | { ok: false, error: object }}
 *   On success, `value` is a UsageAudit
 *   ({ schemaVersion, generatedAt, partial, sources, capabilities,
 *   unobservableClasses }).
 */
function runAudit(opts) {
  const options = opts || {};
  const sessionDbPath = options.sessionDbPath || defaultSessionDbPath();
  const cavememConfigured =
    typeof options.cavememDbPath === 'string' && options.cavememDbPath.length > 0;

  const lib = loadCostReportLib();

  /** @type {Array<{ source: string, status: string, detail?: string }>} */
  const sources = [];

  // Primary source: OpenCode session DB (R1.1).
  const session = openSessionSource(sessionDbPath, lib);
  sources.push(session.status);

  // Capability extraction (task 2.2, R1.2) runs WHILE the reader is open,
  // then the handle is released. The audit stays strictly read-only
  // (SqliteReader opened `{ readonly: true }`) with no lingering handle.
  /** @type {object[]} */
  let capabilities = [];
  if (session.reader) {
    try {
      capabilities = extractCapabilities(session.reader);
    } finally {
      try {
        session.reader.close();
      } catch {
        /* best-effort handle release */
      }
    }
  }

  // Secondary source: cavemem data.db (R1.3), version-guarded and
  // optional. Only recorded when a path was configured; an unconfigured
  // optional source is not a degradation.
  /** @type {Array<object>} */
  let cavememContext = [];
  if (cavememConfigured) {
    const cavememStatus = openCavememSource(options.cavememDbPath);
    sources.push(cavememStatus);
    // R1.3: when cavemem is readable, use it as a best-effort LOW-confidence
    // secondary context source. It never fabricates high-confidence
    // capabilities (Phase 0); we record bounded session context only.
    if (cavememStatus.status === 'ok') {
      cavememContext = collectCavememContext(options.cavememDbPath);
    }
  }

  // R1.5: no source readable at all → error Result, no UsageAudit, no
  // assessment. "No source readable" means nothing was even openable
  // (every source missing/unreadable); an `incompatible` source is
  // still reportable (drift → partial report, not hard fail). The
  // actual process.exit mapping is wired in task 5.3; here we surface
  // the error envelope and name the inspected sources.
  if (!sources.some(isReportable)) {
    return {
      ok: false,
      error: {
        kind: 'no-readable-source',
        detail: 'no audit source was readable; cannot produce an assessment',
        sources,
      },
    };
  }

  return { ok: true, value: buildAudit(sources, capabilities, cavememContext) };
}

/**
 * Assemble a UsageAudit from the opened sources. A report is `partial`
 * when ANY recorded source is degraded (status !== 'ok'); an
 * unconfigured optional source is simply absent from `sources` and so
 * does not count toward partiality (R1.4).
 *
 * Capability extraction (task 2.2, R1.2): `capabilities` is the
 * CapabilityRecord[] derived from the readable session source by
 * {@link extractCapabilities}, and `unobservableClasses` always
 * discloses the structurally-unobservable capability classes
 * ({@link UNOBSERVABLE_CLASSES}) so the report states its coverage gaps
 * explicitly — even when `capabilities` is empty, an empty capability
 * set must NOT imply full coverage. `cavememContext` carries any
 * best-effort LOW-confidence cavemem session context (R1.3); it is
 * omitted from the report when empty.
 *
 * @param {Array<{ source: string, status: string, detail?: string }>} sources
 * @param {object[]} [capabilities] CapabilityRecord[] from the session source
 * @param {object[]} [cavememContext] low-confidence cavemem context (R1.3)
 * @returns {object} UsageAudit
 */
function buildAudit(sources, capabilities, cavememContext) {
  const partial = sources.some((s) => s.status !== 'ok');
  /** @type {object} */
  const audit = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    partial,
    sources,
    capabilities: Array.isArray(capabilities) ? capabilities : [],
    // Always disclose coverage gaps; an empty capabilities array must
    // never be read as "full coverage observed".
    unobservableClasses: [...UNOBSERVABLE_CLASSES],
  };
  // R1.3: surface cavemem-derived low-confidence context only when it
  // genuinely contributed (omit the key entirely otherwise).
  if (Array.isArray(cavememContext) && cavememContext.length > 0) {
    audit.cavememContext = cavememContext;
  }
  return audit;
}

// ────────────────────────────────────────────────────────────────────
// Task 2.3 (Requirement 1.7): the secret redactor.
//
// `redact(value)` masks secrets in a single string across the four
// design-specified classes (design.md:248): URL credentials, KEY=VALUE
// env secrets, known token shapes (GitHub / OpenAI / AWS / Slack /
// Google / Bearer), and token-bearing query parameters. It is:
//   - defensive: non-string input is returned as-is (never throws);
//   - idempotent: the mask token contains no secret-shaped substring,
//     so redact(redact(s)) === redact(s);
//   - conservative on ordinary text: PATH=/HOME=/--flag/clean-URL/file
//     paths are NOT masked.
//
// 2.3 ONLY delivers and exports this function. Applying it to every
// serialized command/path/endpoint/env string ("on by default") is the
// Reporter's responsibility (task 5.1); nothing here wires redaction
// into runAudit / buildAudit / serialization.
//
// All patterns are linear-time (anchored prefixes + bounded or simple
// single-pass quantifiers, no nested unbounded quantifiers) to avoid
// catastrophic backtracking (ReDoS).
// ────────────────────────────────────────────────────────────────────

/** The single, consistent mask token used for every redaction. */
const REDACTION_MASK = '***';

/**
 * Substrings of secret-bearing env KEYs (case-insensitive). When the
 * KEY on the left of `KEY=VALUE` contains any of these, the VALUE is
 * masked while the KEY is preserved. Plain `KEY` is included so e.g.
 * `API_KEY=` / `SECRET_KEY=` match, but a bare `PATH=` / `HOME=` /
 * `FORMAT=` does not.
 *
 * @type {readonly string[]}
 */
const SECRET_KEY_SUBSTRINGS = Object.freeze([
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'apikey',
  'api_key',
  'access_key',
  'access_token',
  'auth',
  'credential',
  'bearer',
  'key',
]);

/**
 * Known high-confidence token SHAPES, anchored on stable prefixes and a
 * minimum length so ordinary words are not over-masked. Each pattern is
 * linear-time (a prefix followed by a single bounded/greedy character
 * class, no nested quantifiers). Applied with the global flag.
 *
 * @type {readonly RegExp[]}
 */
const TOKEN_SHAPE_PATTERNS = Object.freeze([
  // GitHub personal-access / OAuth / server / refresh tokens, and the
  // newer fine-grained `github_pat_` form.
  /\bghp_[A-Za-z0-9]{16,}\b/g,
  /\bgho_[A-Za-z0-9]{16,}\b/g,
  /\bghs_[A-Za-z0-9]{16,}\b/g,
  /\bghr_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  // OpenAI secret keys: `sk-` + a long body.
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  // AWS access key IDs: AKIA/ASIA + exactly 16 uppercase-alnum chars.
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  // Slack tokens: xoxb-/xoxa-/xoxp-/xoxr-/xoxs- + body.
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Google API keys: `AIza` + 35 url-safe chars.
  /\bAIza[A-Za-z0-9_-]{35}\b/g,
]);

/**
 * Query-string parameter names whose VALUE is a secret. Matched
 * case-insensitively as `?name=...` / `&name=...`, masking only the
 * value up to the next `&`/`#`/end.
 *
 * @type {RegExp}
 */
const SECRET_QUERY_PARAM =
  /([?&](?:api_key|apikey|access_token|access_key|token|auth|secret|password|key|bearer|credential)=)[^&#\s]+/gi;

/**
 * Mask the userinfo (`user:password@` or `user@`) of any URL with a
 * scheme. We replace the whole userinfo run with the mask, preserving
 * scheme + host + path. Linear-time: `[^/@\s]+` is a single run bounded
 * by the literal `@`.
 *
 * @type {RegExp}
 */
const URL_USERINFO =
  /([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/**
 * `Bearer <token>` in an Authorization-style context: mask the token
 * regardless of its shape (any non-space run after `Bearer `). The
 * token-shape patterns above also catch known prefixes, but this
 * guarantees opaque bearer tokens are masked too.
 *
 * @type {RegExp}
 */
const BEARER_TOKEN = /\bBearer\s+[^\s'"]+/g;

/**
 * `redact(value)` — mask secrets in a single string. Defensive on
 * non-string input (returns it unchanged) and idempotent (the mask
 * token contains no secret-shaped substring, and already-masked spans
 * have nothing left to match). See the module section header for the
 * full contract (Task 2.3, Requirement 1.7).
 *
 * @param {unknown} value
 * @returns {*} the masked string, or `value` unchanged when not a string.
 */
function redact(value) {
  // Defensive: only strings carry secrets here; anything else (null /
  // undefined / number / object) is returned as-is, never throwing.
  if (typeof value !== 'string') return value;
  if (value.length === 0) return value;

  let out = value;

  // 1. URL userinfo credentials → scheme://***@host (mask user:pass).
  out = out.replace(URL_USERINFO, `$1${REDACTION_MASK}@`);

  // 2. Token-bearing query parameters → name=*** (preserve the name).
  out = out.replace(SECRET_QUERY_PARAM, `$1${REDACTION_MASK}`);

  // 3. KEY=VALUE env secrets → KEY=*** (preserve the key) when the key
  //    looks secret-bearing. A single anchored pass over each
  //    KEY=VALUE token; the value run is bounded by whitespace.
  out = out.replace(
    /(^|[\s'"])([A-Za-z_][A-Za-z0-9_]*)=([^\s'"]+)/g,
    (match, lead, key, val) => {
      const lower = key.toLowerCase();
      const isSecretKey = SECRET_KEY_SUBSTRINGS.some((s) => lower.includes(s));
      if (!isSecretKey) return match;
      if (val === REDACTION_MASK) return match; // already masked (idempotent)
      return `${lead}${key}=${REDACTION_MASK}`;
    },
  );

  // 4. Bearer tokens (any opaque token after `Bearer `).
  out = out.replace(BEARER_TOKEN, `Bearer ${REDACTION_MASK}`);

  // 5. Known token shapes anywhere in the string.
  for (const pattern of TOKEN_SHAPE_PATTERNS) {
    out = out.replace(pattern, REDACTION_MASK);
  }

  return out;
}

const USAGE = `opencode-nono-audit — read-only OpenCode tool-usage audit

Usage:
  opencode-nono-audit [options]

Options:
  -h, --help       Print this usage text and exit.
  -v, --version    Print the version and exit.
`;

/**
 * CLI entry point.
 *
 * @param {string[]} argv - Arguments after `node script.js` (i.e.
 *   `process.argv.slice(2)`).
 * @returns {number} Process exit code.
 */
function main(argv) {
  const args = Array.isArray(argv) ? argv : [];

  if (args.includes('-h') || args.includes('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  if (args.includes('-v') || args.includes('--version')) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // No business logic yet (scaffold). Print usage to stderr and signal
  // "not implemented" so an accidental bare invocation is obvious
  // rather than silently succeeding.
  process.stderr.write(USAGE);
  return 2;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  main,
  VERSION,
  USAGE,
  // Task 2.1: source-opening layer. runAudit is the public entry point;
  // the helpers are exported for unit-test reach. Capability extraction
  // (task 2.2) consumes runAudit's readable session source.
  runAudit,
  defaultSessionDbPath,
  SUPPORTED_CAVEMEM_SCHEMA_VERSION,
  // Task 2.2: observed-capability model. Exported for unit-test reach.
  extractCapabilities,
  UNOBSERVABLE_CLASSES,
  // Task 2.3: secret redactor. Exported for unit-test reach and for the
  // Reporter (task 5.1) to apply at serialization time.
  redact,
};
