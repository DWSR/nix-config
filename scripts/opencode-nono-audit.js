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
const os = require('node:os');
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

// ────────────────────────────────────────────────────────────────────
// Task 3.1 (Requirement 2.1): the Compatibility Assessor's grant INGEST
// layer.
//
// `ingestProfileGrants(profileName, opts)` runs the READ-ONLY
// `nono profile show <name> --json` shell-out and defensively parses the
// resolved grants the eventual `assess()` (task 3.2) will consume. It
// returns a discriminated result:
//
//   { assessment: 'available', grants: <normalized grants> }
//   { assessment: 'skipped', reason: <string>, grants: null }
//
// Skip cases (NEVER crash, NEVER fabricate a false "available"):
//   - nono absent (spawn ENOENT / exit 127 / command-not-found) →
//     reason 'nono unavailable' (matches design's `assessment: skipped
//     (nono unavailable)` wording).
//   - nono present but unparseable / unexpected-shape JSON → DEFENSIVE
//     skip with a descriptive reason (the `profile show --json` shape is
//     UNVERIFIED upstream per Phase 0).
//
// This task delivers ONLY ingestion. CLASSIFICATION of usage against the
// grants (compatible/warning/blocker/unknown Findings) is task 3.2 and
// is intentionally NOT implemented here.
//
// The shell-out is strictly read-only: `profile show ... --json` is a
// read, never a mutating nono subcommand. Arguments are passed as an
// argv array to spawnSync (no shell, no string interpolation of the
// profile name) so the profile name cannot inject shell syntax.
// ────────────────────────────────────────────────────────────────────

const { spawnSync } = require('node:child_process');

/** The literal skip reason when nono cannot be invoked at all. */
const NONO_UNAVAILABLE_REASON = 'nono unavailable';

/**
 * Obtain the raw `nono profile show <name> --json` stdout text, or a
 * skip signal when nono is unavailable. A testability seam: when
 * `opts.grantsJson` is supplied, it is returned verbatim WITHOUT any
 * shell-out (tests feed the synthetic grants fixture this way, and the
 * real absent-binary path is exercised by omitting it).
 *
 * - `opts.grantsJson` → `{ ok: true, text: <injected JSON> }`.
 * - real shell-out succeeds (exit 0) → `{ ok: true, text: <stdout> }`.
 * - nono absent (spawn error / ENOENT) or any non-zero exit (e.g. 127
 *   command-not-found) → `{ ok: false }` (caller maps to the
 *   'nono unavailable' skip).
 *
 * @param {string} profileName
 * @param {{ grantsJson?: string, nonoBin?: string }} opts
 * @returns {{ ok: true, text: string } | { ok: false }}
 */
function readProfileShowJson(profileName, opts) {
  if (typeof opts.grantsJson === 'string') {
    return { ok: true, text: opts.grantsJson };
  }

  const bin = typeof opts.nonoBin === 'string' && opts.nonoBin.length > 0 ? opts.nonoBin : 'nono';
  // Read-only subcommand; argv array (no shell) so the profile name is a
  // single literal argument and cannot inject shell syntax.
  const result = spawnSync(bin, ['profile', 'show', String(profileName), '--json'], {
    encoding: 'utf8',
    // Never inherit a shell; spawnSync with shell:false is the default,
    // stated here for intent. timeout guards a hung binary.
    shell: false,
    timeout: 15000,
  });

  // spawn-level failure (ENOENT for an absent binary, EACCES, timeout) →
  // result.error is set; treat as unavailable.
  if (result.error) {
    return { ok: false };
  }
  // Non-zero exit (e.g. 127 command-not-found surfaced via a shell, or a
  // nono error) → unavailable; do not parse partial output.
  if (typeof result.status === 'number' && result.status !== 0) {
    return { ok: false };
  }
  // A null status with no error is anomalous (e.g. killed by signal);
  // treat conservatively as unavailable rather than parsing stdout.
  if (result.status === null) {
    return { ok: false };
  }
  return { ok: true, text: typeof result.stdout === 'string' ? result.stdout : '' };
}

/**
 * Normalize one grant entry defensively. A grant value is expected to be
 * an object carrying a `mode` plus an `allow`/`deny` string array. Any
 * unexpected shape yields a conservative normalized form rather than a
 * throw, so an unverified upstream shape never crashes the assessor and
 * never silently widens permissions. Returns null when the entry is not
 * even an object (so the caller can decide whether the overall payload
 * is usable).
 *
 * @param {unknown} value
 * @returns {{ mode: string|null, allow: string[], deny: string[] }|null}
 */
function normalizeGrant(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = typeof value.mode === 'string' ? value.mode : null;
  const allow = Array.isArray(value.allow)
    ? value.allow.filter((v) => typeof v === 'string')
    : [];
  const deny = Array.isArray(value.deny) ? value.deny.filter((v) => typeof v === 'string') : [];
  return { mode, allow, deny };
}

/**
 * Defensively parse the `nono profile show --json` stdout into a
 * normalized grants map. The shape is UNVERIFIED upstream (Phase 0), so:
 *   - non-JSON text → null (caller skips).
 *   - JSON that is not an object, or lacks a `grants` OBJECT → null
 *     (caller skips; never fabricate an empty "available" payload).
 *   - a `grants` object → a normalized map { <class>: {mode,allow,deny} }.
 *     Entries whose value is not an object are dropped defensively; if
 *     NO entry normalizes, the payload is treated as unusable (null).
 *
 * @param {string} text
 * @returns {{ [capabilityClass: string]: { mode: string|null, allow: string[], deny: string[] } }|null}
 */
function parseGrants(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null; // malformed JSON → defensive skip
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const grantsObj = parsed.grants;
  if (!grantsObj || typeof grantsObj !== 'object' || Array.isArray(grantsObj)) return null;

  /** @type {Record<string, { mode: string|null, allow: string[], deny: string[] }>} */
  const normalized = {};
  let count = 0;
  for (const key of Object.keys(grantsObj)) {
    const g = normalizeGrant(grantsObj[key]);
    if (g) {
      normalized[key] = g;
      count += 1;
    }
  }
  // A grants object that yielded zero usable entries is an unexpected
  // shape; skip rather than report an empty "available" payload that
  // 3.2 could misread as "no grants, therefore nothing blocks".
  if (count === 0) return null;
  return normalized;
}

/**
 * Ingest the resolved grants for one profile (Task 3.1, Requirement
 * 2.1). See the section header for the full contract. NEVER throws on a
 * bad shape or an absent binary, and NEVER fabricates an `available`
 * result from an assumed/empty grant shape.
 *
 * @param {string} profileName
 * @param {{ grantsJson?: string, nonoBin?: string }} [opts]
 * @returns {{ assessment: 'available', grants: object }
 *          | { assessment: 'skipped', reason: string, grants: null }}
 */
function ingestProfileGrants(profileName, opts) {
  const options = opts || {};

  const read = readProfileShowJson(profileName, options);
  if (!read.ok) {
    // nono is unavailable on this host (absent binary / non-zero exit).
    return { assessment: 'skipped', reason: NONO_UNAVAILABLE_REASON, grants: null };
  }

  const grants = parseGrants(read.text);
  if (grants === null) {
    // Present but unparseable / unexpected shape → defensive skip; never
    // a fabricated "available".
    return { assessment: 'skipped', reason: 'nono unparseable grants', grants: null };
  }

  return { assessment: 'available', grants };
}

// ────────────────────────────────────────────────────────────────────
// Task 3.2 (Requirements 2.2, 2.3, 2.4): the Compatibility Assessor's
// CLASSIFICATION layer.
//
// `assess(audit, profiles, opts)` classifies each observed capability
// (from runAudit's UsageAudit) against the resolved grants of each
// selected profile into a Finding:
//
//   Finding = { profile, classification, capability,
//               sessionContext?, missingCapability? }
//   classification ∈ "compatible" | "warning" | "blocker" | "unknown"
//
// Invariants (mandatory):
//   - UNMAPPABLE observation (no derivable sandbox capability class —
//     e.g. an MCP tool exposing only a name/count, or an inference-only
//     class like port/env) → `unknown`, NEVER `compatible` (R2.4).
//   - Every observation maps to EXACTLY ONE classification (design
//     postcondition); a multi-command bash record yields one finding per
//     command, never zero.
//   - For blockers/warnings: record `profile`, the observed `capability`
//     (raw usage string), `sessionContext` when available, and
//     `missingCapability` when available (R2.3).
//   - If nono is unavailable for every profile → SKIP (no Findings, no
//     fabricated compatible), distinct from classification. Reuses 3.1's
//     ingest, so the live (absent-nono) host skips; classification is
//     exercised in tests via INJECTED synthetic grants.
//
// Redaction is NOT applied here. `Finding.capability` carries the RAW
// usage string; redaction is the single serialization-time pass in task
// 5.1 (consistent with the raw capability strings from 2.2). Do NOT call
// redact() in this layer.
//
// Findings are emitted in a STABLE, deterministic order (classification
// rank, then profile, then capability) so later determinism assertions
// (5.1 / 6.1) hold regardless of map/iteration nondeterminism.
// ────────────────────────────────────────────────────────────────────

/** Deterministic sort rank for classifications (most severe first). */
const CLASSIFICATION_RANK = Object.freeze({
  blocker: 0,
  warning: 1,
  unknown: 2,
  compatible: 3,
});

/**
 * The first whitespace-delimited token of a command is its program. Used
 * to match an `external-command` usage against the program allow/deny
 * grant (e.g. `npm install` → `npm`). Leading env-var assignments
 * (`KEY=value cmd ...`) are skipped so the program, not the assignment,
 * is matched. Returns null when no program token is derivable.
 *
 * @param {string} command
 * @returns {string|null}
 */
function commandProgram(command) {
  if (typeof command !== 'string') return null;
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  for (const tok of tokens) {
    // `KEY=value` prefix assignments are not the program; skip them.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tok)) continue;
    return tok;
  }
  return null;
}

/**
 * Classify a single external-command program against the grant.
 *
 * - allowlist: program in `allow` ⇒ compatible; else ⇒ blocker
 *   (missingCapability `external-command:<program>`).
 * - denylist: program in `deny` ⇒ blocker; else ⇒ compatible.
 * - any other / missing mode ⇒ unknown (the grant shape is unverified
 *   upstream; an unrecognized mode is not assumed permissive — R2.4).
 *
 * @param {string} program
 * @param {{ mode: string|null, allow: string[], deny: string[] }|undefined} grant
 * @returns {{ classification: string, missingCapability?: string }}
 */
function classifyCommand(program, grant) {
  if (!grant) {
    // No external-command grant resolved → cannot confirm; unmappable to a
    // known grant ⇒ unknown (never compatible).
    return { classification: 'unknown' };
  }
  if (grant.mode === 'allowlist') {
    if (grant.allow.includes(program)) return { classification: 'compatible' };
    return { classification: 'blocker', missingCapability: `external-command:${program}` };
  }
  if (grant.mode === 'denylist') {
    if (grant.deny.includes(program)) {
      return { classification: 'blocker', missingCapability: `external-command:${program}` };
    }
    return { classification: 'compatible' };
  }
  return { classification: 'unknown' };
}

/**
 * Classify a single value (a filesystem path or a network host/endpoint)
 * against a prefix-matched allow/deny grant. `klass` names the capability
 * class for the missingCapability string (`filesystem-path` /
 * `network-endpoint`).
 *
 * - allowlist: a `allow` entry is a prefix of the value ⇒ compatible;
 *   none matches ⇒ blocker. An entry that matches only as an EXACT value
 *   (not a prefix segment) when others nearly match is treated normally —
 *   no special-casing; prefix containment is the rule.
 * - denylist: a `deny` entry is a prefix of the value (or `*` wildcard) ⇒
 *   blocker; none matches ⇒ compatible.
 * - any other / missing mode ⇒ unknown.
 *
 * @param {string} value
 * @param {string} klass capability class label
 * @param {{ mode: string|null, allow: string[], deny: string[] }|undefined} grant
 * @returns {{ classification: string, missingCapability?: string }}
 */
function classifyAgainstList(value, klass, grant) {
  if (!grant) return { classification: 'unknown' };
  const matchesAny = (list) =>
    list.some((entry) => entry === '*' || (typeof entry === 'string' && value.startsWith(entry)));

  if (grant.mode === 'allowlist') {
    if (matchesAny(grant.allow)) return { classification: 'compatible' };
    return { classification: 'blocker', missingCapability: `${klass}:${value}` };
  }
  if (grant.mode === 'denylist') {
    if (matchesAny(grant.deny)) {
      return { classification: 'blocker', missingCapability: `${klass}:${value}` };
    }
    return { classification: 'compatible' };
  }
  return { classification: 'unknown' };
}

/**
 * Classify one CapabilityRecord against the resolved grants, producing
 * one or more Findings. Mapping rules:
 *
 * - Each derived `command` → an `external-command` finding keyed on its
 *   program token, capability string `"<tool>:<command>"`.
 * - Each derived `path` → a `filesystem-path` finding, capability string
 *   `"<tool>:<path>"`.
 * - Each derived `endpoint` → a `network-endpoint` finding, capability
 *   string `"<tool>:<endpoint>"`.
 * - A record with NO derived command/path/endpoint (no mappable class —
 *   e.g. an MCP tool with only a name/count, or whose surface is the
 *   inference-only port/env classes) → exactly one `unknown` finding,
 *   capability string `"<tool>"`. UNMAPPABLE ⇒ unknown, never compatible
 *   (R2.4).
 *
 * WARNING trigger (documented, deterministic): a record that DID derive a
 * mappable class but whose extraction confidence is below `high` (i.e.
 * `medium`/`low`) is downgraded from `compatible` to `warning` — the
 * usage maps to a granted class but cannot be confirmed at high
 * confidence. A `blocker` or `unknown` outcome is NOT softened to a
 * warning (a low-confidence blocker is still actionable). This keeps the
 * trigger a one-directional, deterministic compatible→warning demotion.
 *
 * @param {object} rec a CapabilityRecord
 * @param {string} profile
 * @param {object} grants normalized grants map
 * @returns {object[]} Finding[]
 */
function classifyRecord(rec, profile, grants) {
  const findings = [];
  const lowConfidence = rec.confidence !== 'high';
  const sessionContext = undefined; // best-effort/optional; not derived in this layer

  const emit = (capability, outcome) => {
    let classification = outcome.classification;
    // compatible→warning demotion when confidence is not high.
    if (classification === 'compatible' && lowConfidence) classification = 'warning';
    /** @type {object} */
    const finding = { profile, classification, capability };
    if (typeof sessionContext === 'string') finding.sessionContext = sessionContext;
    if (typeof outcome.missingCapability === 'string') {
      finding.missingCapability = outcome.missingCapability;
    }
    findings.push(finding);
  };

  for (const command of rec.commands) {
    const program = commandProgram(command);
    if (program === null) {
      // A command with no derivable program token is unmappable → unknown.
      emit(`${rec.tool}:${command}`, { classification: 'unknown' });
      continue;
    }
    const outcome = classifyCommand(program, grants['external-command']);
    emit(`${rec.tool}:${command}`, outcome);
  }

  for (const p of rec.paths) {
    const outcome = classifyAgainstList(p, 'filesystem-path', grants['filesystem-path']);
    emit(`${rec.tool}:${p}`, outcome);
  }

  for (const endpoint of rec.endpoints) {
    const outcome = classifyAgainstList(endpoint, 'network-endpoint', grants['network-endpoint']);
    emit(`${rec.tool}:${endpoint}`, outcome);
  }

  // No mappable class derived for this record → exactly one unknown
  // finding (UNMAPPABLE ⇒ unknown, never compatible — R2.4). Note: the
  // inference-only port/env classes are never populated by 2.2, so a tool
  // whose only surface is those falls here.
  const mappable = rec.commands.length > 0 || rec.paths.length > 0 || rec.endpoints.length > 0;
  if (!mappable) {
    emit(`${rec.tool}`, { classification: 'unknown' });
  }

  return findings;
}

/**
 * Stable, deterministic comparator for Findings: classification rank
 * (blocker < warning < unknown < compatible), then profile, then
 * capability string. Guarantees a reproducible ordering independent of
 * record/profile iteration order.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareFindings(a, b) {
  const ra = CLASSIFICATION_RANK[a.classification] ?? 99;
  const rb = CLASSIFICATION_RANK[b.classification] ?? 99;
  if (ra !== rb) return ra - rb;
  if (a.profile !== b.profile) return a.profile < b.profile ? -1 : 1;
  if (a.capability !== b.capability) return a.capability < b.capability ? -1 : 1;
  return 0;
}

/**
 * assess — classify a UsageAudit's observed capabilities against the
 * resolved grants of each selected profile (Task 3.2, Requirements 2.2,
 * 2.3, 2.4). See the section header for the full contract.
 *
 * Grant resolution per profile reuses {@link ingestProfileGrants}'s
 * injection seam: `opts.grantsByProfile[<profile>]` supplies grant JSON
 * text directly (tests classify against the synthetic fixture WITHOUT
 * nono); otherwise the live `nono profile show --json` shell-out runs
 * (absent on this host → skip). `opts.nonoBin` overrides the binary.
 *
 * - At least one profile resolves grants → `{ ok: true, value: Finding[] }`
 *   (deterministically ordered; one finding per observed capability,
 *   exactly one classification each).
 * - No profile resolves grants (nono unavailable / unparseable for all) →
 *   `{ ok: true, value: { assessment: 'skipped', reason, findings: [] } }`.
 *   The SKIP NEVER fabricates compatible findings (R2.4 false-compatible
 *   avoidance) and is NOT the R1.5 hard failure.
 *
 * @param {object} audit a UsageAudit (runAudit().value)
 * @param {string[]} profiles selected profile names
 * @param {{ grantsByProfile?: Record<string,string>, nonoBin?: string }} [opts]
 * @returns {{ ok: true, value: object[] }
 *          | { ok: true, value: { assessment: 'skipped', reason: string, findings: [] } }
 *          | { ok: false, error: object }}
 */
function assess(audit, profiles, opts) {
  const options = opts || {};
  if (!audit || typeof audit !== 'object' || !Array.isArray(audit.capabilities)) {
    return { ok: false, error: { kind: 'invalid-audit', detail: 'assess requires a UsageAudit' } };
  }
  const profileList = Array.isArray(profiles) ? profiles.filter((p) => typeof p === 'string') : [];

  /** @type {Array<{ profile: string, grants: object }>} */
  const resolved = [];
  const skipReasons = [];
  const byProfile =
    options.grantsByProfile && typeof options.grantsByProfile === 'object'
      ? options.grantsByProfile
      : {};

  for (const profile of profileList) {
    const ingestOpts = {};
    if (typeof byProfile[profile] === 'string') ingestOpts.grantsJson = byProfile[profile];
    if (typeof options.nonoBin === 'string') ingestOpts.nonoBin = options.nonoBin;

    const ingest = ingestProfileGrants(profile, ingestOpts);
    if (ingest.assessment === 'available') {
      resolved.push({ profile, grants: ingest.grants });
    } else {
      skipReasons.push(ingest.reason);
    }
  }

  // No profile resolved grants → SKIP (never fabricate compatible). This
  // is the live (absent-nono) path and is distinct from the R1.5 hard
  // failure: the audit itself succeeded; only the assessment is skipped.
  if (resolved.length === 0) {
    const reason = skipReasons.length > 0 ? skipReasons[0] : NONO_UNAVAILABLE_REASON;
    return { ok: true, value: { assessment: 'skipped', reason, findings: [] } };
  }

  /** @type {object[]} */
  const findings = [];
  for (const { profile, grants } of resolved) {
    for (const rec of audit.capabilities) {
      findings.push(...classifyRecord(rec, profile, grants));
    }
  }

  findings.sort(compareFindings);
  return { ok: true, value: findings };
}

// ────────────────────────────────────────────────────────────────────
// Task 4.1 (Requirements 3.1, 3.2, 3.3): the Tool-Use Replacement
// Review's RANK + SEED layer.
//
// `rankToolUse(audit)` ranks observed tool-use by
//   riskScore = count × capabilityRisk
// where capabilityRisk comes from a STATIC, documented map (below) and
// is converted to a numeric weight via RISK_WEIGHTS (high=3 / medium=2 /
// low=1). The list is sorted DETERMINISTICALLY: riskScore descending,
// tie-break frequency (count) descending, then tool name ascending. A
// contiguous 1-based `rank` is assigned after sorting.
//
// `seedReplacementCandidates(audit)` seeds MCP-replacement candidates
// from a STATIC, EXTENSIBLE map (MCP_REPLACEMENT_MAP). `git → Git MCP`
// is always seeded; a ranked tool/category with no known MCP candidate
// is emitted with `mcpCandidate` undefined and a "no viable replacement"
// rationale. The candidate list is emitted in the SAME deterministic
// order as the ranked list.
//
// Git recognition (R3.2): git is recognized by COMMAND PATTERN — bash
// commands whose program token (via commandProgram()) is `git` form a
// `git` rankable/known category whose count = number of git commands
// observed, so the static `git = high` risk applies and a git → Git MCP
// candidate can be seeded. URLs/paths INSIDE the git command strings are
// NOT promoted — only the program token matters.
//
// Scope: 4.1 produces the RANKED list + SEEDED candidates only. The
// decisions ledger (operator keep/replace/defer/none reconciliation) is
// task 4.2; reporting (5.x) and redaction are not here.
// ────────────────────────────────────────────────────────────────────

/**
 * STATIC capability-risk map (R3.1). Maps a tool/category name to a
 * qualitative risk level. `bash`/external-command and `git` are high;
 * `webfetch` is medium; `read`/`glob`/`grep` are low. Any tool NOT in
 * this map is treated as `medium` (see {@link capabilityRiskOf}).
 * Extensible: add a tool → level entry to reclassify it.
 *
 * @type {Readonly<Record<string, 'high'|'medium'|'low'>>}
 */
const CAPABILITY_RISK = Object.freeze({
  bash: 'high',
  git: 'high',
  webfetch: 'medium',
  read: 'low',
  glob: 'low',
  grep: 'low',
});

/** The risk level assigned to a tool absent from {@link CAPABILITY_RISK}. */
const DEFAULT_CAPABILITY_RISK = 'medium';

/**
 * Documented numeric weights for each risk level (R3.1). riskScore =
 * count × RISK_WEIGHTS[capabilityRisk]. high > medium > low so a
 * frequently-used high-risk tool ranks above a frequently-used low-risk
 * one.
 *
 * @type {Readonly<Record<'high'|'medium'|'low', number>>}
 */
const RISK_WEIGHTS = Object.freeze({ high: 3, medium: 2, low: 1 });

/**
 * STATIC, EXTENSIBLE MCP-replacement seed map (R3.2, R3.3). Maps a
 * tool/category name to a known MCP replacement. `git → git-mcp-server`
 * is seeded (the repo ships a git-mcp-server). A tool/category absent
 * from this map has no known replacement and is marked "no viable
 * replacement" by {@link seedReplacementCandidates}.
 *
 * @type {Readonly<Record<string, string>>}
 */
const MCP_REPLACEMENT_MAP = Object.freeze({
  git: 'git-mcp-server',
});

/** The rationale text emitted when no known MCP replacement exists (R3.3). */
const NO_VIABLE_REPLACEMENT = 'no viable replacement: no known MCP server for this tool';

/**
 * Resolve a tool/category name to its qualitative capability risk via
 * the static map, defaulting unknown tools to medium (R3.1).
 *
 * @param {string} tool
 * @returns {'high'|'medium'|'low'}
 */
function capabilityRiskOf(tool) {
  return CAPABILITY_RISK[tool] || DEFAULT_CAPABILITY_RISK;
}

/**
 * Fold a UsageAudit's CapabilityRecord[] into rankable categories keyed
 * by tool name with a stable count. Each capability record contributes
 * its `tool` with its observed `count`. Additionally, git usage is
 * recognized by COMMAND PATTERN (R3.2): every command whose program
 * token (via {@link commandProgram}) is `git` increments a derived `git`
 * category, so git is ranked/seeded as its own known category. The
 * underlying tool (e.g. `bash`) keeps its full observed count; the git
 * category is an additive recognition, not a re-bucketing.
 *
 * @param {object} audit a UsageAudit (runAudit().value)
 * @returns {Map<string, number>} category name → count
 */
function rankableCategories(audit) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  const add = (name, n) => {
    if (typeof name !== 'string' || name.length === 0 || n <= 0) return;
    counts.set(name, (counts.get(name) || 0) + n);
  };

  const capabilities = Array.isArray(audit && audit.capabilities) ? audit.capabilities : [];
  for (const rec of capabilities) {
    add(rec.tool, typeof rec.count === 'number' ? rec.count : 0);

    // Recognize git by command program token (R3.2). Count the number of
    // git commands observed for this record into the derived `git`
    // category. URLs/paths inside the command strings are NOT promoted.
    const commands = Array.isArray(rec.commands) ? rec.commands : [];
    let gitCommands = 0;
    for (const command of commands) {
      if (commandProgram(command) === 'git') gitCommands += 1;
    }
    add('git', gitCommands);
  }

  return counts;
}

/**
 * Deterministic comparator for rankable categories (R3.1): riskScore
 * descending, then count descending, then tool name ascending. Fully
 * deterministic for a fixed input.
 *
 * @param {{ tool: string, count: number, riskScore: number }} a
 * @param {{ tool: string, count: number, riskScore: number }} b
 * @returns {number}
 */
function compareRanked(a, b) {
  if (a.riskScore !== b.riskScore) return b.riskScore - a.riskScore;
  if (a.count !== b.count) return b.count - a.count;
  if (a.tool !== b.tool) return a.tool < b.tool ? -1 : 1;
  return 0;
}

/**
 * rankToolUse — rank observed tool-use by `riskScore = count ×
 * capabilityRisk` (Task 4.1, Requirement 3.1). See the section header
 * for the full contract.
 *
 * Returns RankedToolUse[] = { tool, count, riskScore, rank }, sorted by
 * riskScore desc with the documented tie-break (count desc, tool name
 * asc) and contiguous 1-based ranks. Deterministic for a fixed audit.
 *
 * @param {object} audit a UsageAudit (runAudit().value)
 * @returns {Array<{ tool: string, count: number, riskScore: number, rank: number }>}
 */
function rankToolUse(audit) {
  const counts = rankableCategories(audit);

  const ranked = [...counts.entries()].map(([tool, count]) => {
    const risk = capabilityRiskOf(tool);
    return { tool, count, riskScore: count * RISK_WEIGHTS[risk] };
  });

  ranked.sort(compareRanked);

  // Assign contiguous 1-based ranks after sorting.
  return ranked.map((entry, i) => ({ ...entry, rank: i + 1 }));
}

/**
 * seedReplacementCandidates — seed MCP-replacement candidates over the
 * ranked tool-use (Task 4.1, Requirements 3.2, 3.3). See the section
 * header for the full contract.
 *
 * Emits one ReplacementCandidate per ranked category, in the SAME
 * deterministic order as {@link rankToolUse}. A category present in
 * {@link MCP_REPLACEMENT_MAP} carries its `mcpCandidate` + a rationale;
 * a category with no known replacement omits `mcpCandidate` and carries
 * the "no viable replacement" rationale. `git → git-mcp-server` is
 * always seeded when git usage was observed.
 *
 * @param {object} audit a UsageAudit (runAudit().value)
 * @returns {Array<{ tool: string, mcpCandidate?: string, rationale: string }>}
 */
function seedReplacementCandidates(audit) {
  const ranked = rankToolUse(audit);

  return ranked.map((entry) => {
    const mcpCandidate = MCP_REPLACEMENT_MAP[entry.tool];
    if (typeof mcpCandidate === 'string' && mcpCandidate.length > 0) {
      return {
        tool: entry.tool,
        mcpCandidate,
        rationale: `replace ${entry.tool} usage with the ${mcpCandidate} MCP server`,
      };
    }
    return { tool: entry.tool, rationale: NO_VIABLE_REPLACEMENT };
  });
}

// ────────────────────────────────────────────────────────────────────
// Task 4.2 (Requirements 3.4, 3.5, 3.6, 3.7): the Tool-Use Replacement
// Review's decisions-ledger RECONCILE + VALIDATE layer.
//
// `reconcileLedger(candidates, opts)` reads an OPERATOR-MAINTAINED
// decisions ledger and reconciles each seeded ReplacementCandidate (from
// {@link seedReplacementCandidates}) to a `keep | replace | defer | none`
// decision, validates the decision-conditional required fields, and
// echoes undecided candidates:
//
//   reconcileLedger(candidates, opts) → {
//     reconciled: Array<{ tool, decision, entry }>,  // decided candidates
//     undecided:  string[],                          // tools w/ no entry (R3.4)
//     errors:     Array<{ tool, field, message }>,   // missing required field
//   }
//
// Validation (R3.5, R3.6):
//   - "replace" MUST carry permissionReduction AND workflowChange (R3.5).
//   - "keep"    MUST carry keepReason AND requiredCapability (R3.6).
//   - "defer" / "none" carry no extra required fields.
//   - a missing required field → a validation error NAMING the tool AND
//     the missing field (the observable); ALL such errors are collected
//     (validation does not stop at the first).
//
// Testability seam (mirrors the ingest seams above): `opts.ledger`
// supplies the ledger object DIRECTLY, or `opts.ledgerPath` supplies a
// ledger file PATH (so tests do not depend on $XDG_STATE_HOME). The
// runtime default reads the XDG path. A MISSING ledger file → all
// candidates `undecided`, NO error (the operator simply has not created
// one yet).
//
// Advisory only (R3.7): this function READS the ledger and RETURNS
// reconciled/validation data ONLY. It emits NO permission/MCP-registration
// side effects and writes NOTHING (not even the ledger). The boundary is
// enforced structurally — the code path performs only reads.
//
// Scope (4.2): ledger read + reconcile + validate + echo-undecided ONLY.
// No reporting/serialization (5.x), no redaction, no acting on decisions.
// ────────────────────────────────────────────────────────────────────

/**
 * Decision-conditional required fields (R3.5, R3.6). A ledger entry whose
 * `decision` is a key here MUST carry every listed field with a non-empty
 * string value; a missing/empty field is a validation error. `defer` and
 * `none` are absent → no extra required fields.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
const LEDGER_REQUIRED_FIELDS = Object.freeze({
  replace: Object.freeze(['permissionReduction', 'workflowChange']),
  keep: Object.freeze(['keepReason', 'requiredCapability']),
});

/** The recognized ledger decisions (design "Decision" union). */
const LEDGER_DECISIONS = Object.freeze(['keep', 'replace', 'defer', 'none']);

/**
 * Resolve the default decisions-ledger path when the caller supplies
 * neither an inline ledger nor a path:
 * `${XDG_STATE_HOME:-~/.local/state}/opencode-nono/review-decisions.json`
 * (design "Logical Data Model"). The CLI only READS this path.
 *
 * @returns {string}
 */
function defaultLedgerPath() {
  const xdgState =
    process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0
      ? process.env.XDG_STATE_HOME
      : path.join(process.env.HOME || '', '.local', 'state');
  return path.join(xdgState, 'opencode-nono', 'review-decisions.json');
}

/**
 * Load the operator-maintained ledger object from the injection seam or
 * disk. Resolution order:
 *   - `opts.ledger` (an object) → used verbatim (no disk read).
 *   - `opts.ledgerPath` (a string) → read that file.
 *   - otherwise → read {@link defaultLedgerPath}.
 *
 * A MISSING ledger file is NOT an error (R3.4 operator-not-yet-created):
 * it resolves to a ledger with no entries so every candidate falls
 * through to `undecided`. Malformed JSON / unexpected shape likewise
 * yields an empty entry set defensively (never a throw) — the ledger is
 * operator-owned and an audit must not crash on a hand-edited file.
 *
 * @param {{ ledger?: object, ledgerPath?: string }} opts
 * @returns {{ entries: object[] }}
 */
function loadLedger(opts) {
  if (opts.ledger && typeof opts.ledger === 'object' && !Array.isArray(opts.ledger)) {
    const entries = Array.isArray(opts.ledger.entries) ? opts.ledger.entries : [];
    return { entries };
  }

  const ledgerPath =
    typeof opts.ledgerPath === 'string' && opts.ledgerPath.length > 0
      ? opts.ledgerPath
      : defaultLedgerPath();

  // Missing file → no entries, no error (operator hasn't created one).
  if (!fileExists(ledgerPath)) return { entries: [] };

  let text;
  try {
    text = fs.readFileSync(ledgerPath, 'utf8');
  } catch {
    // Unreadable (e.g. permissions) → defensive empty set, never a throw.
    return { entries: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { entries: [] }; // malformed JSON → defensive empty set
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { entries: [] };
  const entries = Array.isArray(parsed.entries) ? parsed.entries : [];
  return { entries };
}

/**
 * Index ledger entries by tool name, keeping the LAST entry for a tool
 * when duplicates exist (deterministic, operator-edit-tolerant). Entries
 * that are not objects, or lack a string `tool`, are dropped defensively.
 *
 * @param {object[]} entries
 * @returns {Map<string, object>}
 */
function indexLedgerEntries(entries) {
  /** @type {Map<string, object>} */
  const byTool = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    if (typeof entry.tool !== 'string' || entry.tool.length === 0) continue;
    byTool.set(entry.tool, entry);
  }
  return byTool;
}

/**
 * Validate one ledger entry's decision-conditional required fields,
 * pushing one `{ tool, field, message }` error per MISSING required
 * field onto `errors`. The message NAMES both the tool and the missing
 * field (the R3.5/R3.6 observable). An unrecognized decision yields a
 * single `decision`-field error so a typo'd decision is surfaced rather
 * than silently treated as field-free.
 *
 * @param {object} entry a ledger entry (tool + decision + fields)
 * @param {Array<{ tool: string, field: string, message: string }>} errors
 */
function validateLedgerEntry(entry, errors) {
  const tool = entry.tool;
  const decision = entry.decision;

  if (!LEDGER_DECISIONS.includes(decision)) {
    errors.push({
      tool,
      field: 'decision',
      message: `ledger entry for tool "${tool}" has an unrecognized decision "${String(decision)}" (expected one of ${LEDGER_DECISIONS.join(', ')})`,
    });
    return;
  }

  const required = LEDGER_REQUIRED_FIELDS[decision] || [];
  for (const field of required) {
    const value = entry[field];
    const present = typeof value === 'string' && value.trim().length > 0;
    if (!present) {
      errors.push({
        tool,
        field,
        message: `ledger entry for tool "${tool}" with decision "${decision}" is missing required field "${field}"`,
      });
    }
  }
}

/**
 * reconcileLedger — read the operator-maintained decisions ledger and
 * reconcile the seeded replacement candidates against it (Task 4.2,
 * Requirements 3.4, 3.5, 3.6, 3.7). See the section header for the full
 * contract.
 *
 * Each candidate with a matching ledger entry is reconciled to its
 * decision (R3.4) and its decision-conditional required fields validated
 * (R3.5, R3.6); a missing required field yields a `{ tool, field,
 * message }` error naming both (collected, never stop-on-first). A
 * candidate with NO matching ledger entry is echoed in `undecided`
 * (R3.4). The function is advisory only (R3.7): it reads and returns,
 * mutating nothing.
 *
 * Output is deterministic: `reconciled` follows the input candidate
 * order, `undecided` follows the input candidate order, and `errors`
 * follow reconciled-entry order then required-field order.
 *
 * @param {Array<{ tool: string }>} candidates ReplacementCandidate[]
 *   (from {@link seedReplacementCandidates}).
 * @param {{ ledger?: object, ledgerPath?: string }} [opts]
 * @returns {{
 *   reconciled: Array<{ tool: string, decision: string, entry: object }>,
 *   undecided: string[],
 *   errors: Array<{ tool: string, field: string, message: string }>,
 * }}
 */
function reconcileLedger(candidates, opts) {
  const options = opts || {};
  const candidateList = Array.isArray(candidates) ? candidates : [];

  const { entries } = loadLedger(options);
  const byTool = indexLedgerEntries(entries);

  /** @type {Array<{ tool: string, decision: string, entry: object }>} */
  const reconciled = [];
  /** @type {string[]} */
  const undecided = [];
  /** @type {Array<{ tool: string, field: string, message: string }>} */
  const errors = [];

  for (const candidate of candidateList) {
    const tool = candidate && typeof candidate.tool === 'string' ? candidate.tool : null;
    if (tool === null) continue; // malformed candidate → skip defensively

    const entry = byTool.get(tool);
    if (!entry) {
      // No ledger entry for this candidate → echo it as undecided (R3.4).
      undecided.push(tool);
      continue;
    }

    // Reconcile to the recorded decision (R3.4) and validate the
    // decision-conditional required fields (R3.5, R3.6).
    reconciled.push({ tool, decision: entry.decision, entry });
    validateLedgerEntry(entry, errors);
  }

  // Advisory only (R3.7): purely-derived data is returned; nothing is
  // written and no permission/MCP registration is touched.
  return { reconciled, undecided, errors };
}

// ────────────────────────────────────────────────────────────────────
// Task 5.1 (Requirements 2.5, 1.7, 1.4): the Reporter.
//
// emitReport(opts) assembles ONE stably-key-ordered report object from
// the UsageAudit (runAudit), the assessment (assess), and the review
// (rankToolUse + seedReplacementCandidates + reconcileLedger), passes
// EVERY secret-bearing string through redact() during assembly (R1.7,
// on by default), serializes to byte-stable JSON + a human-readable
// Markdown rendering (R2.5), and writes both under
//   `${XDG_STATE_HOME:-~/.local/state}/opencode-nono/reports/<ISO>.{json,md}`
// at mode 0600 with last-N retention per extension (R1.4 location). The
// header records schemaVersion (=1), host, profileVersion (read from
// the sandbox-rendered metadata.json), and generatedAt.
//
// DETERMINISM (R2.5): the report object is built with a FIXED key
// insertion order and all arrays are already deterministically sorted
// upstream (capabilities by tool, findings by rank, ranked list by
// score), so identical inputs produce byte-identical JSON.
// `generatedAt` is INJECTABLE (an option) so a byte-stable test can fix
// it; the serializer never calls `new Date()` unconditionally.
//
// REDACTION (R1.7): a single deep pass redacts every string in the
// assembled object before serialization — commands, paths, endpoints,
// capability/missingCapability strings, sessionContext, ledger
// free-text, rationale, source detail, cavemem cwd, etc. The mask token
// contains no secret-shaped substring so the pass is idempotent.
//
// Scope (5.1): assembly + redaction + JSON/MD serialization + 0600/XDG
// retention write + header (incl. profileVersion read). The freshness
// marker (last-report.json) is task 5.2 and the CLI subcommand wiring is
// task 5.3 — neither is done here. The FileWriter in
// opencode-cost-report.js HARDCODES the `opencode-cost-diagnosis` subdir
// and so cannot be reused for the path; the writer below MIRRORS its
// pattern (`_withUmask(0o077, ...)`, ISO filename stem with `:`→`-`,
// recursive mkdir, per-extension last-N prune) under `opencode-nono/`.
// ────────────────────────────────────────────────────────────────────

/** report.schemaVersion (R2.5 / Data Contracts: additive evolution only). */
const REPORT_SCHEMA_VERSION = 1;

/** Default per-extension retention for the reports directory. */
const REPORT_RETENTION_COUNT = 10;

/** The graceful profileVersion default when metadata is absent/unreadable. */
const PROFILE_VERSION_UNKNOWN = null;

/**
 * Resolve the reports directory base (state dir). Precedence:
 *   1. explicit `stateDir` option (tests use this);
 *   2. `XDG_STATE_HOME`;
 *   3. `${HOME}/.local/state` (XDG basedir default).
 *
 * @param {string} [stateDirOverride]
 * @returns {string}
 */
function resolveReportStateDir(stateDirOverride) {
  if (typeof stateDirOverride === 'string' && stateDirOverride.length > 0) {
    return stateDirOverride;
  }
  if (process.env.XDG_STATE_HOME && process.env.XDG_STATE_HOME.length > 0) {
    return process.env.XDG_STATE_HOME;
  }
  return path.join(process.env.HOME || '', '.local', 'state');
}

/**
 * Resolve the sandbox-rendered metadata path the Reporter reads the
 * active `profileVersion` from. Precedence:
 *   1. explicit `metadataPath` option (tests inject the fixture);
 *   2. `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-nono/metadata.json`.
 *
 * @param {string} [metadataPathOverride]
 * @returns {string}
 */
function resolveMetadataPath(metadataPathOverride) {
  if (typeof metadataPathOverride === 'string' && metadataPathOverride.length > 0) {
    return metadataPathOverride;
  }
  const xdgConfig =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : path.join(process.env.HOME || '', '.config');
  return path.join(xdgConfig, 'opencode', 'opencode-nono', 'metadata.json');
}

/**
 * Read the active profile version from the sandbox-rendered
 * `metadata.json` (`profileVersion` field). A small reusable helper
 * (task 5.2 reuses it for the freshness marker). Returns
 * {@link PROFILE_VERSION_UNKNOWN} when the file is absent / unreadable /
 * malformed / lacks a string `profileVersion` — a graceful default,
 * never a throw.
 *
 * @param {string} [metadataPathOverride]
 * @returns {string|null}
 */
function readProfileVersion(metadataPathOverride) {
  const metadataPath = resolveMetadataPath(metadataPathOverride);
  let text;
  try {
    text = fs.readFileSync(metadataPath, 'utf8');
  } catch {
    return PROFILE_VERSION_UNKNOWN; // absent / unreadable → graceful default
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return PROFILE_VERSION_UNKNOWN; // malformed JSON → graceful default
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.profileVersion === 'string') {
    return parsed.profileVersion;
  }
  return PROFILE_VERSION_UNKNOWN;
}

/**
 * Deep-redact every string in a JSON-ish value (object/array/string/
 * primitive). Strings are passed through {@link redact}; objects and
 * arrays are rebuilt with the SAME key insertion order (determinism is
 * preserved — redaction does not reorder keys). Non-string primitives
 * (numbers/booleans/null/undefined) pass through unchanged. This is the
 * single serialization-time redaction pass (R1.7): the raw capability /
 * finding / ledger strings extracted unredacted by tasks 2.2 / 3.2 / 4.x
 * are masked HERE, on by default.
 *
 * @param {*} value
 * @returns {*}
 */
function redactDeep(value) {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v));
  if (value && typeof value === 'object') {
    /** @type {Record<string, *>} */
    const out = {};
    for (const key of Object.keys(value)) {
      out[key] = redactDeep(value[key]);
    }
    return out;
  }
  return value;
}

/**
 * Assemble ONE stably-key-ordered report object from the audit, the
 * assessment, and the review, redaction-passed (R1.7). The key
 * insertion order below IS the determinism contract (R2.5); arrays are
 * already deterministically sorted by their producers. `generatedAt` is
 * the injected timestamp (never `new Date()` here).
 *
 * The assessment may be either a Finding[] (assess succeeded) or a skip
 * envelope (`{ assessment: 'skipped', reason, findings: [] }`); both are
 * surfaced verbatim (redaction-passed) under `assessment`.
 *
 * @param {{
 *   audit: object,
 *   assessment: object|object[],
 *   review: { ranked: object[], candidates: object[], ledger: object },
 *   generatedAt: string,
 *   host: string,
 *   profileVersion: string|null,
 * }} parts
 * @returns {object} the report object (header + audit + assessment + review)
 */
function assembleReport(parts) {
  const { audit, assessment, review, generatedAt, host, profileVersion } = parts;
  const rev = review || {};

  // Fixed key insertion order → byte-stable JSON. Redact each section
  // deeply as it is placed (every string field masked before
  // serialization, R1.7).
  const report = {
    // ── header ──
    schemaVersion: REPORT_SCHEMA_VERSION,
    host: redact(typeof host === 'string' ? host : ''),
    profileVersion: typeof profileVersion === 'string' ? profileVersion : null,
    generatedAt: typeof generatedAt === 'string' ? generatedAt : '',
    // ── body ──
    audit: redactDeep(audit && typeof audit === 'object' ? audit : {}),
    assessment: redactDeep(
      assessment && typeof assessment === 'object'
        ? assessment
        : { assessment: 'skipped', reason: 'no assessment', findings: [] },
    ),
    review: {
      ranked: redactDeep(Array.isArray(rev.ranked) ? rev.ranked : []),
      candidates: redactDeep(Array.isArray(rev.candidates) ? rev.candidates : []),
      ledger: redactDeep(
        rev.ledger && typeof rev.ledger === 'object'
          ? rev.ledger
          : { reconciled: [], undecided: [], errors: [] },
      ),
    },
  };
  return report;
}

/**
 * Serialize a report object to byte-stable JSON. The object is already
 * built with a fixed key insertion order, so `JSON.stringify` with a
 * fixed indent is deterministic. A trailing newline keeps the file
 * POSIX-clean.
 *
 * @param {object} report
 * @returns {string}
 */
function serializeReportJson(report) {
  return `${JSON.stringify(report, null, 2)}\n`;
}

/** Render a list of capability records as Markdown bullet lines. */
function renderCapabilitiesMd(capabilities) {
  if (!Array.isArray(capabilities) || capabilities.length === 0) {
    return '- (none observed)\n';
  }
  let out = '';
  for (const cap of capabilities) {
    const tool = cap && typeof cap.tool === 'string' ? cap.tool : '(unknown)';
    const count = cap && typeof cap.count === 'number' ? cap.count : 0;
    const conf = cap && typeof cap.confidence === 'string' ? cap.confidence : '?';
    out += `- \`${tool}\` ×${count} (confidence: ${conf})\n`;
    const commands = Array.isArray(cap && cap.commands) ? cap.commands : [];
    for (const c of commands) out += `  - command: \`${c}\`\n`;
    const paths = Array.isArray(cap && cap.paths) ? cap.paths : [];
    for (const p of paths) out += `  - path: \`${p}\`\n`;
    const endpoints = Array.isArray(cap && cap.endpoints) ? cap.endpoints : [];
    for (const e of endpoints) out += `  - endpoint: \`${e}\`\n`;
  }
  return out;
}

/** Render the assessment (findings or skip envelope) as Markdown. */
function renderAssessmentMd(assessment) {
  if (assessment && !Array.isArray(assessment) && assessment.assessment === 'skipped') {
    return `Assessment skipped: ${assessment.reason}\n`;
  }
  const findings = Array.isArray(assessment) ? assessment : [];
  if (findings.length === 0) return '- (no findings)\n';
  let out = '';
  for (const f of findings) {
    let line = `- **${f.classification}** [${f.profile}] \`${f.capability}\``;
    if (typeof f.missingCapability === 'string') line += ` — missing: \`${f.missingCapability}\``;
    if (typeof f.sessionContext === 'string') line += ` — context: ${f.sessionContext}`;
    out += `${line}\n`;
  }
  return out;
}

/** Render the review (ranked + candidates + ledger) as Markdown. */
function renderReviewMd(review) {
  const rev = review || {};
  const ranked = Array.isArray(rev.ranked) ? rev.ranked : [];
  const candidates = Array.isArray(rev.candidates) ? rev.candidates : [];
  const ledger = rev.ledger && typeof rev.ledger === 'object' ? rev.ledger : {};

  let out = '### Ranked tool-use\n\n';
  if (ranked.length === 0) {
    out += '- (none)\n';
  } else {
    for (const r of ranked) {
      out += `- #${r.rank} \`${r.tool}\` — count ${r.count}, riskScore ${r.riskScore}\n`;
    }
  }

  out += '\n### Replacement candidates\n\n';
  if (candidates.length === 0) {
    out += '- (none)\n';
  } else {
    for (const c of candidates) {
      const cand = typeof c.mcpCandidate === 'string' ? c.mcpCandidate : '(none)';
      out += `- \`${c.tool}\` → ${cand}: ${c.rationale}\n`;
    }
  }

  const undecided = Array.isArray(ledger.undecided) ? ledger.undecided : [];
  out += '\n### Undecided candidates\n\n';
  out += undecided.length === 0 ? '- (none)\n' : undecided.map((t) => `- \`${t}\`\n`).join('');

  const errors = Array.isArray(ledger.errors) ? ledger.errors : [];
  out += '\n### Ledger validation errors\n\n';
  out += errors.length === 0 ? '- (none)\n' : errors.map((e) => `- ${e.message}\n`).join('');

  return out;
}

/**
 * Serialize a report object to a human-readable Markdown rendering of
 * the SAME content (R2.5). Deterministic for a fixed report object (the
 * report is already redaction-passed and stably ordered).
 *
 * @param {object} report an assembled report
 * @returns {string}
 */
function serializeReportMarkdown(report) {
  const audit = report.audit && typeof report.audit === 'object' ? report.audit : {};
  const sources = Array.isArray(audit.sources) ? audit.sources : [];

  let out = '# opencode-nono-audit report\n\n';
  out += `- schemaVersion: ${report.schemaVersion}\n`;
  out += `- host: ${report.host}\n`;
  out += `- profileVersion: ${String(report.profileVersion)}\n`;
  out += `- generatedAt: ${report.generatedAt}\n`;
  out += `- partial: ${audit.partial === true}\n\n`;

  out += '## Sources\n\n';
  if (sources.length === 0) {
    out += '- (none)\n';
  } else {
    for (const s of sources) {
      let line = `- \`${s.source}\`: ${s.status}`;
      if (typeof s.detail === 'string' && s.detail.length > 0) line += ` — ${s.detail}`;
      out += `${line}\n`;
    }
  }

  out += '\n## Capabilities\n\n';
  out += renderCapabilitiesMd(audit.capabilities);

  const unobservable = Array.isArray(audit.unobservableClasses) ? audit.unobservableClasses : [];
  out += '\n## Unobservable classes\n\n';
  out += unobservable.length === 0 ? '- (none)\n' : unobservable.map((c) => `- ${c}\n`).join('');

  out += '\n## Assessment\n\n';
  out += renderAssessmentMd(report.assessment);

  out += '\n## Review\n\n';
  out += renderReviewMd(report.review);

  return out;
}

/**
 * Filename-safe ISO 8601 stem for a timestamp string. `Date.toISOString`
 * emits two colons (`HH:MM:SS`); replace them globally with `-` so the
 * stem is safe on every supported filesystem. Mirrors FileWriter's
 * `_filenameStem`. The input is the already-fixed `generatedAt` string.
 *
 * @param {string} generatedAt an ISO 8601 timestamp string
 * @returns {string}
 */
function reportFilenameStem(generatedAt) {
  return String(generatedAt).replace(/:/g, '-');
}

/**
 * Run `fn` with the process umask set to `mask`, restoring the prior
 * umask in a finally block. Mirrors FileWriter's `_withUmask`: setting
 * 0o077 before writing means `fs.writeFileSync`'s default 0o666 mode is
 * masked down to 0o600 (R1.4 file mode), and the operator's umask is not
 * leaked past the write.
 *
 * @param {number} mask
 * @param {() => void} fn
 */
function withUmask(mask, fn) {
  const prior = process.umask(mask);
  try {
    fn();
  } finally {
    process.umask(prior);
  }
}

/**
 * Per-extension last-N retention prune of the reports directory. Mirrors
 * FileWriter's `_prune`: split managed files by extension, sort by mtime
 * descending, keep the first `retentionCount`, unlink the tail. Only
 * `.json` / `.md` flat files are managed; anything else survives. Benign
 * ENOENT races (stat / unlink) are skipped.
 *
 * @param {string} reportsDir
 * @param {number} retentionCount
 */
function pruneReports(reportsDir, retentionCount) {
  let entries;
  try {
    entries = fs.readdirSync(reportsDir, { withFileTypes: true });
  } catch {
    return; // dir vanished → nothing to prune
  }
  const byExt = { '.json': [], '.md': [] };
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name).toLowerCase();
    if (!(ext in byExt)) continue;
    const full = path.join(reportsDir, ent.name);
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(full).mtimeMs;
    } catch {
      continue; // race: vanished between readdir and stat
    }
    byExt[ext].push({ full, mtimeMs });
  }
  for (const ext of Object.keys(byExt)) {
    const list = byExt[ext];
    if (list.length <= retentionCount) continue;
    list.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    for (const { full } of list.slice(retentionCount)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* benign race / already-removed */
      }
    }
  }
}

/**
 * emitReport — assemble, redact, serialize, and write the audit report
 * (Task 5.1, Requirements 2.5, 1.7, 1.4). See the section header for the
 * full contract.
 *
 * Writes `<stateDir>/opencode-nono/reports/<ISO>.{json,md}` at mode 0600
 * with per-extension last-N retention, and returns the assembled report
 * object plus the serialized bytes and written paths.
 *
 * @param {{
 *   audit: object,
 *   assessment: object|object[],
 *   review: { ranked: object[], candidates: object[], ledger: object },
 *   generatedAt: string,           // INJECTABLE for byte-stable tests
 *   host?: string,                 // defaults to os.hostname()
 *   metadataPath?: string,         // injectable metadata.json path
 *   stateDir?: string,             // overrides XDG_STATE_HOME for tests
 *   retentionCount?: number,       // default REPORT_RETENTION_COUNT
 * }} opts
 * @returns {{ report: object, json: string, markdown: string, jsonPath: string, mdPath: string }}
 */
function emitReport(opts) {
  const options = opts || {};
  const generatedAt =
    typeof options.generatedAt === 'string' && options.generatedAt.length > 0
      ? options.generatedAt
      : new Date().toISOString();
  const host =
    typeof options.host === 'string' && options.host.length > 0
      ? options.host
      : os.hostname();
  const profileVersion = readProfileVersion(options.metadataPath);
  const retentionCount =
    Number.isInteger(options.retentionCount) && options.retentionCount >= 1
      ? options.retentionCount
      : REPORT_RETENTION_COUNT;

  const report = assembleReport({
    audit: options.audit,
    assessment: options.assessment,
    review: options.review,
    generatedAt,
    host,
    profileVersion,
  });

  const json = serializeReportJson(report);
  const markdown = serializeReportMarkdown(report);

  const stateDir = resolveReportStateDir(options.stateDir);
  const reportsDir = path.join(stateDir, 'opencode-nono', 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });

  const stem = reportFilenameStem(generatedAt);
  const jsonPath = path.join(reportsDir, `${stem}.json`);
  const mdPath = path.join(reportsDir, `${stem}.md`);

  // 0600 via umask: writeFileSync's default 0o666 masked by 0o077 → 0o600.
  withUmask(0o077, () => {
    fs.writeFileSync(jsonPath, json);
    fs.writeFileSync(mdPath, markdown);
  });

  pruneReports(reportsDir, retentionCount);

  return { report, json, markdown, jsonPath, mdPath };
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
  // Task 3.1: Compatibility Assessor grant ingest layer. Exported for
  // unit-test reach and for the eventual assess() (task 3.2) to consume.
  ingestProfileGrants,
  // Task 3.2: Compatibility Assessor classification layer. Exported for
  // unit-test reach and for the Reporter (task 5.x) to consume.
  assess,
  // Task 4.1: Tool-Use Replacement Review rank + seed layer. Exported
  // for unit-test reach and for the decisions ledger (task 4.2) +
  // Reporter (task 5.x) to consume. The static maps are exported as
  // documented constants so tests can assert against them.
  rankToolUse,
  seedReplacementCandidates,
  CAPABILITY_RISK,
  RISK_WEIGHTS,
  MCP_REPLACEMENT_MAP,
  // Task 4.2: Tool-Use Replacement Review decisions-ledger reconcile +
  // validate layer. Exported for unit-test reach and for the Reporter
  // (task 5.x) to consume the reconciled/validation data.
  reconcileLedger,
  defaultLedgerPath,
  LEDGER_REQUIRED_FIELDS,
  // Task 5.1: the Reporter. emitReport is the public entry point; the
  // assembly / serialization / metadata-read helpers are exported for
  // unit-test reach and for task 5.2 (freshness marker reuses
  // readProfileVersion) + task 5.3 (CLI wires emitReport).
  emitReport,
  assembleReport,
  serializeReportJson,
  serializeReportMarkdown,
  readProfileVersion,
  REPORT_SCHEMA_VERSION,
  REPORT_RETENTION_COUNT,
};
