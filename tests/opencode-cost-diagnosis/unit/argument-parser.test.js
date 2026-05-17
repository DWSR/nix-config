/*
 * argument-parser.test.js — unit tests for the ArgumentParser (task
 * 5.1 of .kiro/specs/opencode-cost-diagnosis).
 *
 * Scope: ArgumentParser is a pure parser/validator. It takes argv
 * (after node + script name have been sliced off) and an optional
 * `{ now }` injection point (for deterministic --last math) and
 * returns a structured action descriptor:
 *
 *   {
 *     action: 'report' | 'help' | 'supported-opencode-version',
 *     selectors: { timeRangeStart?, timeRangeEnd?, sessionId?, cwdPattern? },
 *     includeContent: boolean,
 *     format: 'md' | 'json' | 'both',
 *     outputOverride: string | null,
 *   }
 *
 * Errors are surfaced as throws of `ArgumentError` so the CLI Entry
 * (task 5.3) can catch them, print the usage block, name the
 * offending arg in stderr, and exit 1. The parser itself never
 * touches process.stdout / process.stderr / process.exit — it is
 * exclusively pure. That separation matches the rest of the
 * module (FileWriter throws FileWriterError; CLI Entry handles the
 * exit-code mapping).
 *
 * Requirements covered:
 *   - R3.AC1 (--last time-range filter)
 *   - R3.AC2 (--session selector)
 *   - R3.AC3 (--cwd selector)
 *   - R3.AC5 (bad-arg → actionable stderr naming the offending arg)
 *   - R4.AC3 (--include-content opt-in)
 *   - R5.AC1 (--supported-opencode-version surfaces the pinned range
 *     + migration set so operators can read them without consulting
 *     external docs)
 *   - R6.AC5 reflection (parser surfaces actionable error text;
 *     CLI Entry handles the I/O + exit code mapping)
 *
 * Design references: design.md Argument Parser component summary
 * (lines 395-403), `parse_since` mirror in memory-sync.nix
 * (`<N><unit>` shape, single-unit only, reject multi-unit).
 *
 * `now` injection ergonomics: every --last test passes a FIXED_NOW
 * so the resulting `timeRangeStart` is independent of wall clock.
 * The CLI Entry (5.3) will not pass `now`, defaulting to Date.now()
 * at the call site.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  ArgumentParser,
  ArgumentError,
  SUPPORTED_VERSION_RANGE,
  SUPPORTED_MIGRATION_SET,
} = require(path.join(__dirname, '../../../scripts/opencode-cost-report.js'));

// Frozen "now" used for every --last test. 2026-05-17T12:00:00Z in
// ms epoch. Deliberately a round number so durations expressed as
// `1h`, `1d`, `7d`, `2w` produce inspect-friendly arithmetic.
const FIXED_NOW = Date.UTC(2026, 4, 17, 12, 0, 0); // month is 0-indexed

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function parse(argv, opts) {
  const p = new ArgumentParser();
  return p.parse(argv, opts);
}

/* ------------------------------------------------------------------ *
 * Smoke / shape checks
 * ------------------------------------------------------------------ */

test('ArgumentParser: exports a constructor', () => {
  assert.equal(typeof ArgumentParser, 'function');
  const p = new ArgumentParser();
  assert.equal(typeof p.parse, 'function');
});

test('ArgumentError: exported and extends Error', () => {
  assert.equal(typeof ArgumentError, 'function');
  const e = new ArgumentError('boom');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ArgumentError');
  assert.equal(e.message, 'boom');
});

test('ArgumentParser: empty argv → action=report, default format=both, defaults elsewhere', () => {
  const r = parse([]);
  assert.equal(r.action, 'report');
  assert.deepEqual(r.selectors, {});
  assert.equal(r.includeContent, false);
  assert.equal(r.format, 'both');
  assert.equal(r.outputOverride, null);
});

/* ------------------------------------------------------------------ *
 * --help / -h
 * ------------------------------------------------------------------ */

test('ArgumentParser: --help → action=help', () => {
  const r = parse(['--help']);
  assert.equal(r.action, 'help');
});

test('ArgumentParser: -h → action=help', () => {
  const r = parse(['-h']);
  assert.equal(r.action, 'help');
});

test('ArgumentParser: --help wins over other flags (no validation of remainder)', () => {
  // Help is a short-circuit affordance — operator typed it for a
  // reason, parser should not bury the help action behind a
  // validation error on the rest of the line.
  const r = parse(['--last', '999garbage', '--help']);
  assert.equal(r.action, 'help');
});

/* ------------------------------------------------------------------ *
 * --supported-opencode-version
 * ------------------------------------------------------------------ */

test('ArgumentParser: --supported-opencode-version → action=supported-opencode-version', () => {
  const r = parse(['--supported-opencode-version']);
  assert.equal(r.action, 'supported-opencode-version');
});

test('SUPPORTED_VERSION_RANGE and SUPPORTED_MIGRATION_SET constants are exported (R5.AC1)', () => {
  // The CLI Entry (5.3) prints these in response to
  // --supported-opencode-version. They must be importable so the
  // entry point doesn't have to re-derive them. (Task 2.1 already
  // exports them; this test pins that contract from the
  // argument-parser perspective so a refactor that moves them
  // doesn't silently break the 5.3 dispatch.)
  assert.equal(typeof SUPPORTED_VERSION_RANGE, 'string');
  assert.ok(SUPPORTED_VERSION_RANGE.length > 0);
  assert.ok(Array.isArray(SUPPORTED_MIGRATION_SET));
  assert.ok(SUPPORTED_MIGRATION_SET.length > 0);
});

/* ------------------------------------------------------------------ *
 * --last (time-range parsing, R3.AC1, parse_since mirror)
 * ------------------------------------------------------------------ */

test('ArgumentParser: --last 1h → timeRangeStart = now - 1 hour', () => {
  const r = parse(['--last', '1h'], { now: FIXED_NOW });
  assert.equal(r.action, 'report');
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - HOUR_MS);
  // timeRangeEnd is unset — the selector is "since N ago", not a
  // closed window. The Session Selector (task 5.2) treats absent
  // end as "now or later".
  assert.equal(r.selectors.timeRangeEnd, undefined);
});

test('ArgumentParser: --last 24h → 24 hours in ms', () => {
  const r = parse(['--last', '24h'], { now: FIXED_NOW });
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 24 * HOUR_MS);
});

test('ArgumentParser: --last 7d → 7 days in ms', () => {
  const r = parse(['--last', '7d'], { now: FIXED_NOW });
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 7 * DAY_MS);
});

test('ArgumentParser: --last 30d → 30 days in ms', () => {
  const r = parse(['--last', '30d'], { now: FIXED_NOW });
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 30 * DAY_MS);
});

test('ArgumentParser: --last 2w → 2 weeks in ms', () => {
  const r = parse(['--last', '2w'], { now: FIXED_NOW });
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 2 * WEEK_MS);
});

test('ArgumentParser: --last with multi-unit `7d6h` throws ArgumentError naming the offending value', () => {
  // Mirrors parse_since's single-unit-only contract. Even though
  // the substring "7d" alone is valid, the whole-token value
  // `7d6h` is not — silently parsing only the prefix would let
  // operators believe a longer/shorter window was applied.
  assert.throws(
    () => parse(['--last', '7d6h']),
    (err) => {
      assert.ok(err instanceof ArgumentError);
      assert.match(err.message, /7d6h/);
      return true;
    },
  );
});

test('ArgumentParser: --last with bare integer `30` throws (R3.AC5)', () => {
  assert.throws(
    () => parse(['--last', '30']),
    (err) => err instanceof ArgumentError && /30/.test(err.message),
  );
});

test('ArgumentParser: --last with bare unit `d` throws (R3.AC5)', () => {
  assert.throws(
    () => parse(['--last', 'd']),
    (err) => err instanceof ArgumentError && /['"`]?d['"`]?/.test(err.message),
  );
});

test('ArgumentParser: --last with empty value throws (R3.AC5)', () => {
  assert.throws(
    () => parse(['--last', '']),
    (err) => err instanceof ArgumentError,
  );
});

test('ArgumentParser: --last with unknown unit `1y` throws naming the value (R3.AC5)', () => {
  assert.throws(
    () => parse(['--last', '1y']),
    (err) => err instanceof ArgumentError && /1y/.test(err.message),
  );
});

test('ArgumentParser: --last with zero count `0d` throws (zero-window is operator error)', () => {
  assert.throws(
    () => parse(['--last', '0d']),
    (err) => err instanceof ArgumentError && /0d/.test(err.message),
  );
});

test('ArgumentParser: --last with negative `-1d` throws', () => {
  assert.throws(
    () => parse(['--last', '-1d']),
    (err) => err instanceof ArgumentError && /-1d/.test(err.message),
  );
});

test('ArgumentParser: --last with non-integer `1.5d` throws', () => {
  assert.throws(
    () => parse(['--last', '1.5d']),
    (err) => err instanceof ArgumentError && /1\.5d/.test(err.message),
  );
});

test('ArgumentParser: --last with missing value (last flag in argv) throws naming --last', () => {
  // `--last` consumed the end of argv with no successor. We
  // refuse rather than silently no-op.
  assert.throws(
    () => parse(['--last']),
    (err) => err instanceof ArgumentError && /--last/.test(err.message),
  );
});

/* ------------------------------------------------------------------ *
 * --session (R3.AC2)
 * ------------------------------------------------------------------ */

test('ArgumentParser: --session ses_abc123 → selectors.sessionId', () => {
  const r = parse(['--session', 'ses_abc123']);
  assert.equal(r.action, 'report');
  assert.equal(r.selectors.sessionId, 'ses_abc123');
});

test('ArgumentParser: --session with missing value throws naming --session', () => {
  assert.throws(
    () => parse(['--session']),
    (err) => err instanceof ArgumentError && /--session/.test(err.message),
  );
});

/* ------------------------------------------------------------------ *
 * --cwd (R3.AC3)
 * ------------------------------------------------------------------ */

test('ArgumentParser: --cwd /Users/x/foo → selectors.cwdPattern', () => {
  const r = parse(['--cwd', '/Users/x/foo']);
  assert.equal(r.action, 'report');
  assert.equal(r.selectors.cwdPattern, '/Users/x/foo');
});

test('ArgumentParser: --cwd with missing value throws naming --cwd', () => {
  assert.throws(
    () => parse(['--cwd']),
    (err) => err instanceof ArgumentError && /--cwd/.test(err.message),
  );
});

/* ------------------------------------------------------------------ *
 * --include-content (R4.AC3)
 * ------------------------------------------------------------------ */

test('ArgumentParser: --include-content → includeContent=true', () => {
  const r = parse(['--include-content']);
  assert.equal(r.includeContent, true);
});

test('ArgumentParser: --include-content is a bare boolean flag (does NOT consume next arg)', () => {
  // Regression guard: bare flag should NOT swallow the subsequent
  // selector arg as a "value". The next arg is itself a flag with
  // its own value.
  const r = parse(['--include-content', '--cwd', '/p']);
  assert.equal(r.includeContent, true);
  assert.equal(r.selectors.cwdPattern, '/p');
});

/* ------------------------------------------------------------------ *
 * --format (default 'both')
 * ------------------------------------------------------------------ */

test('ArgumentParser: --format md → format=md', () => {
  const r = parse(['--format', 'md']);
  assert.equal(r.format, 'md');
});

test('ArgumentParser: --format json → format=json', () => {
  const r = parse(['--format', 'json']);
  assert.equal(r.format, 'json');
});

test('ArgumentParser: --format both → format=both', () => {
  const r = parse(['--format', 'both']);
  assert.equal(r.format, 'both');
});

test('ArgumentParser: --format with unsupported value throws naming the value', () => {
  assert.throws(
    () => parse(['--format', 'yaml']),
    (err) => err instanceof ArgumentError && /yaml/.test(err.message),
  );
});

test('ArgumentParser: --format with missing value throws naming --format', () => {
  assert.throws(
    () => parse(['--format']),
    (err) => err instanceof ArgumentError && /--format/.test(err.message),
  );
});

/* ------------------------------------------------------------------ *
 * --output
 * ------------------------------------------------------------------ */

test('ArgumentParser: --output /tmp/report.md → outputOverride', () => {
  const r = parse(['--output', '/tmp/report.md']);
  assert.equal(r.outputOverride, '/tmp/report.md');
});

test('ArgumentParser: --output with missing value throws naming --output', () => {
  assert.throws(
    () => parse(['--output']),
    (err) => err instanceof ArgumentError && /--output/.test(err.message),
  );
});

/* ------------------------------------------------------------------ *
 * Combined / observables
 * ------------------------------------------------------------------ */

test('ArgumentParser: `--last 30d --cwd /Users/x/foo` returns parsed result containing both selectors (task brief observable)', () => {
  const r = parse(['--last', '30d', '--cwd', '/Users/x/foo'], { now: FIXED_NOW });
  assert.equal(r.action, 'report');
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 30 * DAY_MS);
  assert.equal(r.selectors.cwdPattern, '/Users/x/foo');
});

test('ArgumentParser: all flags combined parse correctly', () => {
  const r = parse(
    [
      '--last', '7d',
      '--session', 'ses_xyz',
      '--cwd', '/repo',
      '--include-content',
      '--format', 'json',
      '--output', '/tmp/out.json',
    ],
    { now: FIXED_NOW },
  );
  assert.equal(r.action, 'report');
  assert.equal(r.selectors.timeRangeStart, FIXED_NOW - 7 * DAY_MS);
  assert.equal(r.selectors.sessionId, 'ses_xyz');
  assert.equal(r.selectors.cwdPattern, '/repo');
  assert.equal(r.includeContent, true);
  assert.equal(r.format, 'json');
  assert.equal(r.outputOverride, '/tmp/out.json');
});

test('ArgumentParser: order of flags does not affect parsed result', () => {
  const r1 = parse(['--cwd', '/p', '--last', '1h'], { now: FIXED_NOW });
  const r2 = parse(['--last', '1h', '--cwd', '/p'], { now: FIXED_NOW });
  assert.deepEqual(r1, r2);
});

/* ------------------------------------------------------------------ *
 * Unknown / unsupported flags (R3.AC5)
 * ------------------------------------------------------------------ */

test('ArgumentParser: unknown long flag throws ArgumentError naming the flag', () => {
  assert.throws(
    () => parse(['--bogus']),
    (err) => err instanceof ArgumentError && /--bogus/.test(err.message),
  );
});

test('ArgumentParser: unknown short flag throws ArgumentError naming the flag', () => {
  assert.throws(
    () => parse(['-x']),
    (err) => err instanceof ArgumentError && /-x/.test(err.message),
  );
});

test('ArgumentParser: positional (non-flag) argument throws ArgumentError naming the value', () => {
  // The CLI takes no positional arguments. Anything that does not
  // start with `-` is a user error and should be surfaced rather
  // than silently dropped.
  assert.throws(
    () => parse(['stray-arg']),
    (err) => err instanceof ArgumentError && /stray-arg/.test(err.message),
  );
});

test('ArgumentParser: `--last 7d6h` (observable) exits via ArgumentError naming the offending value', () => {
  // Mirrors the task-brief observable verbatim:
  //   opencode-cost-report --last 7d6h exits 1 with the offending
  //   value named in stderr
  // The parser surfaces the ArgumentError; CLI Entry (5.3) maps it
  // to exit 1 + usage block on stderr.
  let caught;
  try {
    parse(['--last', '7d6h']);
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof ArgumentError);
  assert.match(caught.message, /7d6h/);
});
