/*
 * file-writer.test.js — unit tests for the File Writer (task 4.1
 * of .kiro/specs/opencode-cost-diagnosis).
 *
 * The File Writer's job is to persist the rendered Markdown + JSON
 * report payloads to disk under the operator's XDG state dir with
 * mode 0600, prune older reports to the last 10 per extension, and
 * honor a `--output <path>` single-file override that skips pruning.
 *
 * Requirements covered: R4.AC4 (mode 0600), R4.AC5 (XDG state-dir,
 * never world-writable), R6.AC5 (I/O error → exit-4 trailer naming
 * path + operation). See design.md File Writer (summary table line
 * 402) and "Runtime File Layout" (lines 241-249).
 *
 * Test ergonomics:
 *
 *   - Every test that exercises the default-path branch uses a
 *     mkdtemp'd stateDir override; we never touch the operator's
 *     real $XDG_STATE_HOME. Process env is intentionally NOT
 *     mutated (the implementation accepts `stateDir` as a
 *     constructor option, mirroring the read-only-by-construction
 *     pattern other unit tests in this folder use). The XDG-env
 *     branch is exercised by one dedicated test that saves +
 *     restores `XDG_STATE_HOME` itself.
 *   - Pruning tests do NOT write 11 real reports back-to-back with
 *     timestamp gaps; instead we drop synthetic files into the
 *     reports dir and call `fs.utimesSync` to manufacture mtime
 *     ordering. The task brief explicitly forbids the slow-write
 *     approach.
 *   - mode 0600 verification uses `stat.mode & 0o777 === 0o600`;
 *     anything stricter (e.g. checking the full mode word) would
 *     vary across darwin/linux for the file-type bits and is not
 *     what R4.AC4 promises.
 *
 * The CLI's --output flag itself is parsed in task 5.1; this layer
 * only consumes the resolved override as a `outputOverride` option.
 * That separation matches the design's component split (File Writer
 * is an Output-layer module; flag parsing is the top-level CLI
 * Entry/Argument Parser).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  FileWriter,
} = require(
  path.join(__dirname, '../../../scripts/opencode-cost-report.js'),
);

// Deterministic report payloads. The writer is content-agnostic —
// it only cares about byte length and path resolution — so a short
// string is enough to verify "file exists with this content".
const SAMPLE_MD = '# sample report\n\nbody\n';
const SAMPLE_JSON = '{"sample":"report","ok":true}\n';

// Frozen wall-clock instant used as the report-generation timestamp.
// 2026-05-17T14:30:22.123Z → filename-safe form replaces every `:`
// with `-` so callers can predict the resolved path without
// re-implementing the filename math.
const FIXED_DATE = new Date('2026-05-17T14:30:22.123Z');
const FIXED_FILENAME_STEM = '2026-05-17T14-30-22.123Z';

function mkStateDir() {
  // Per-test ephemeral state dir. The writer will create
  // `${stateDir}/opencode-cost-diagnosis/reports/` itself; we just
  // hand it the parent.
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cost-diagnosis-fw-'),
  );
  return dir;
}

function rmrf(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function reportsDirOf(stateDir) {
  return path.join(stateDir, 'opencode-cost-diagnosis', 'reports');
}

// Drop a synthetic file at the given path with arbitrary content +
// mtime. Used by the pruning tests to manufacture an "11 historical
// reports" scenario without sleeping or writing through the writer.
function placeFile(p, content, mtimeMs) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  const t = mtimeMs / 1000;
  fs.utimesSync(p, t, t);
}

test('FileWriter: exports a constructor function', () => {
  // Smoke check the public shape before any behavioral asserts so
  // a missing export fails with a clear error rather than a cryptic
  // "FileWriter is not a constructor" deep inside another test.
  assert.equal(typeof FileWriter, 'function');
  const fw = new FileWriter();
  assert.equal(typeof fw.write, 'function');
});

test('FileWriter: default-state-dir write creates both .md and .json with mode 0600', () => {
  // The headline R4.AC4 path: hand the writer markdown + json + a
  // generation timestamp, get back the two paths, verify both files
  // exist with the expected content and mode.
  const stateDir = mkStateDir();
  try {
    const fw = new FileWriter({ stateDir });
    const result = fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });

    assert.equal(typeof result, 'object');
    assert.equal(typeof result.mdPath, 'string');
    assert.equal(typeof result.jsonPath, 'string');

    const rdir = reportsDirOf(stateDir);
    assert.equal(
      result.mdPath,
      path.join(rdir, `${FIXED_FILENAME_STEM}.md`),
      'default mdPath must use filename-safe ISO 8601 stem (no colons)',
    );
    assert.equal(
      result.jsonPath,
      path.join(rdir, `${FIXED_FILENAME_STEM}.json`),
    );

    assert.equal(fs.readFileSync(result.mdPath, 'utf8'), SAMPLE_MD);
    assert.equal(fs.readFileSync(result.jsonPath, 'utf8'), SAMPLE_JSON);

    const mdMode = fs.statSync(result.mdPath).mode & 0o777;
    const jsonMode = fs.statSync(result.jsonPath).mode & 0o777;
    assert.equal(
      mdMode,
      0o600,
      `markdown report must be mode 0600 (R4.AC4); got 0${mdMode.toString(8)}`,
    );
    assert.equal(
      jsonMode,
      0o600,
      `json report must be mode 0600 (R4.AC4); got 0${jsonMode.toString(8)}`,
    );
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: filename-safe ISO 8601 replaces colons (no `:` ever appears)', () => {
  // Regression guard for filenames on case-insensitive filesystems
  // and Windows tooling that chokes on `:`. The test also catches
  // the lazy mistake of using Date.toString() (with a space) or
  // Date.toUTCString() (with commas) instead of toISOString().
  const stateDir = mkStateDir();
  try {
    const fw = new FileWriter({ stateDir });
    const { mdPath, jsonPath } = fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: new Date('2024-01-02T03:04:05.678Z'),
    });
    for (const p of [mdPath, jsonPath]) {
      const base = path.basename(p);
      assert.ok(
        !base.includes(':'),
        `filename must not contain ':'; got ${base}`,
      );
      assert.ok(
        base.startsWith('2024-01-02T03-04-05.678Z'),
        `filename stem must mirror the generation timestamp; got ${base}`,
      );
    }
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: parent dirs are created recursively (no pre-existing `reports/` needed)', () => {
  // The writer's first invocation against a brand-new state dir
  // must work; we explicitly check that neither
  // `${stateDir}/opencode-cost-diagnosis` nor `.../reports`
  // exist beforehand.
  const stateDir = mkStateDir();
  try {
    const ocdDir = path.join(stateDir, 'opencode-cost-diagnosis');
    assert.equal(fs.existsSync(ocdDir), false);
    const fw = new FileWriter({ stateDir });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });
    assert.equal(fs.statSync(reportsDirOf(stateDir)).isDirectory(), true);
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: XDG_STATE_HOME env var resolves the default state dir', () => {
  // The constructor's stateDir option overrides env, but with NO
  // option the writer must consult XDG_STATE_HOME. We save +
  // restore the env var so the test does not pollute downstream
  // tests' process env (matches the task brief's "don't pollute
  // the operator's real state dir during tests" rule).
  const stateDir = mkStateDir();
  const saved = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDir;
  try {
    const fw = new FileWriter();
    const { mdPath, jsonPath } = fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });
    const rdir = reportsDirOf(stateDir);
    assert.equal(path.dirname(mdPath), rdir);
    assert.equal(path.dirname(jsonPath), rdir);
  } finally {
    if (saved === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = saved;
    }
    rmrf(stateDir);
  }
});

test('FileWriter: pruning retains the newest 10 .md and 10 .json files (12 → 10 per ext)', () => {
  // Seed 12 historical .md and 12 historical .json files with
  // synthetic mtimes ascending in 1-minute steps so "newest" vs
  // "oldest" is unambiguous. Then invoke the writer once with a
  // 13th-position timestamp — after the write + prune, exactly 10
  // of each extension must remain on disk, and the oldest 3 of
  // each extension must be gone. Mirrors memory-sync.nix:437-449's
  // last-10 retention contract.
  const stateDir = mkStateDir();
  try {
    const rdir = reportsDirOf(stateDir);
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const seeded = [];
    for (let i = 0; i < 12; i++) {
      const mtime = base + i * 60_000;
      const stem = `2026-01-01T00-${String(i).padStart(2, '0')}-00.000Z`;
      const mdPath = path.join(rdir, `${stem}.md`);
      const jsonPath = path.join(rdir, `${stem}.json`);
      placeFile(mdPath, `seeded md ${i}`, mtime);
      placeFile(jsonPath, `{"seeded":${i}}`, mtime);
      seeded.push({ i, mdPath, jsonPath, mtime });
    }

    // Sanity: 12 of each before the writer runs.
    const before = fs.readdirSync(rdir);
    assert.equal(before.filter((n) => n.endsWith('.md')).length, 12);
    assert.equal(before.filter((n) => n.endsWith('.json')).length, 12);

    // The fresh write lands with the current Date's mtime, which
    // is later than every seeded mtime (the seeded files are from
    // Jan 2026, the test runs whenever).
    const fw = new FileWriter({ stateDir });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: new Date(),
    });

    const after = fs.readdirSync(rdir);
    const mdRemaining = after.filter((n) => n.endsWith('.md'));
    const jsonRemaining = after.filter((n) => n.endsWith('.json'));
    assert.equal(
      mdRemaining.length,
      10,
      `pruning must leave exactly 10 .md files; got ${mdRemaining.length}: ${mdRemaining}`,
    );
    assert.equal(
      jsonRemaining.length,
      10,
      `pruning must leave exactly 10 .json files; got ${jsonRemaining.length}: ${jsonRemaining}`,
    );

    // The three oldest seeded files of each ext (i=0,1,2) must be
    // gone; the newest 9 seeded (i=3..11) plus the freshly-written
    // file must remain.
    for (const s of seeded.slice(0, 3)) {
      assert.equal(
        fs.existsSync(s.mdPath),
        false,
        `oldest seeded md ${path.basename(s.mdPath)} should have been pruned`,
      );
      assert.equal(
        fs.existsSync(s.jsonPath),
        false,
        `oldest seeded json ${path.basename(s.jsonPath)} should have been pruned`,
      );
    }
    for (const s of seeded.slice(3)) {
      assert.equal(fs.existsSync(s.mdPath), true);
      assert.equal(fs.existsSync(s.jsonPath), true);
    }
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: prunes .md and .json independently (12 .md + 5 .json → 10 .md + 5 .json)', () => {
  // Per-extension retention: a directory with only 5 .json files
  // must NOT have any .json pruned even when .md is at the cap.
  // Regression guard for the obvious bug of treating the two
  // extensions as one combined list.
  const stateDir = mkStateDir();
  try {
    const rdir = reportsDirOf(stateDir);
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    for (let i = 0; i < 12; i++) {
      placeFile(
        path.join(rdir, `2026-02-01T00-${String(i).padStart(2, '0')}-00.000Z.md`),
        `seeded md ${i}`,
        base + i * 60_000,
      );
    }
    for (let i = 0; i < 5; i++) {
      placeFile(
        path.join(rdir, `2026-02-01T00-${String(i).padStart(2, '0')}-00.000Z.json`),
        `{"seeded":${i}}`,
        base + i * 60_000,
      );
    }

    const fw = new FileWriter({ stateDir });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: new Date(),
    });

    const after = fs.readdirSync(rdir);
    const mdCount = after.filter((n) => n.endsWith('.md')).length;
    const jsonCount = after.filter((n) => n.endsWith('.json')).length;
    assert.equal(mdCount, 10, '.md must be capped at 10');
    assert.equal(
      jsonCount,
      6,
      '.json must not be pruned when below the cap (5 seeded + 1 new = 6)',
    );
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: pruning ignores non-report files (.txt, dot-files, subdirs)', () => {
  // The pruner walks the reports/ dir; it must restrict itself to
  // *.md and *.json by extension and ignore anything else. If a
  // stray operator note or a future telemetry file lives next to
  // the reports, it must survive a prune cycle.
  const stateDir = mkStateDir();
  try {
    const rdir = reportsDirOf(stateDir);
    fs.mkdirSync(rdir, { recursive: true });
    const stray = path.join(rdir, 'notes.txt');
    const dotfile = path.join(rdir, '.placeholder');
    fs.writeFileSync(stray, 'operator note');
    fs.writeFileSync(dotfile, '');
    // Subdir to verify the walk isn't recursive.
    fs.mkdirSync(path.join(rdir, 'archive'));

    // Seed 12 .md so pruning actually runs.
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    for (let i = 0; i < 12; i++) {
      placeFile(
        path.join(rdir, `2026-03-01T00-${String(i).padStart(2, '0')}-00.000Z.md`),
        `seeded md ${i}`,
        base + i * 60_000,
      );
    }

    const fw = new FileWriter({ stateDir });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: new Date(),
    });

    assert.equal(
      fs.existsSync(stray),
      true,
      'stray .txt file must not be pruned',
    );
    assert.equal(
      fs.existsSync(dotfile),
      true,
      'dotfile must not be pruned',
    );
    assert.equal(
      fs.statSync(path.join(rdir, 'archive')).isDirectory(),
      true,
      'subdirectory must not be pruned',
    );
  } finally {
    rmrf(stateDir);
  }
});

test('FileWriter: outputOverride .json writes only the JSON file, skips MD, skips pruning', () => {
  // --output /tmp/foo.json semantics: exactly one file written
  // (the JSON), no .md companion, and the default reports/ dir is
  // never even created. Pruning is bypassed too — we seed 12 .md
  // files first and verify they all survive.
  const stateDir = mkStateDir();
  const overrideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cost-diagnosis-override-'),
  );
  try {
    const rdir = reportsDirOf(stateDir);
    const base = Date.parse('2026-04-01T00:00:00.000Z');
    for (let i = 0; i < 12; i++) {
      placeFile(
        path.join(rdir, `2026-04-01T00-${String(i).padStart(2, '0')}-00.000Z.md`),
        `seeded md ${i}`,
        base + i * 60_000,
      );
    }

    const override = path.join(overrideDir, 'foo.json');
    const fw = new FileWriter({
      stateDir,
      outputOverride: override,
    });
    const result = fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });

    assert.equal(result.jsonPath, override);
    assert.equal(
      result.mdPath,
      null,
      'override of .json must NOT write a .md companion (single named file)',
    );
    assert.equal(fs.readFileSync(override, 'utf8'), SAMPLE_JSON);
    assert.equal(
      fs.statSync(override).mode & 0o777,
      0o600,
      'override-written file must still be mode 0600 (R4.AC4 is per-file, not per-path)',
    );

    // All 12 seeded .md must still exist — pruning is skipped
    // entirely under --output.
    const after = fs.readdirSync(rdir);
    assert.equal(
      after.filter((n) => n.endsWith('.md')).length,
      12,
      'pruning must be skipped under outputOverride; all 12 seeded .md must remain',
    );
  } finally {
    rmrf(stateDir);
    rmrf(overrideDir);
  }
});

test('FileWriter: outputOverride .md writes only the markdown file, skips JSON, skips pruning', () => {
  // Symmetric to the .json case. Two near-identical tests beat
  // one parametrized test here because failure-mode diagnostics
  // are clearer when the failing assert line names the extension.
  const stateDir = mkStateDir();
  const overrideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cost-diagnosis-override-'),
  );
  try {
    const override = path.join(overrideDir, 'report.md');
    const fw = new FileWriter({
      stateDir,
      outputOverride: override,
    });
    const result = fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });

    assert.equal(result.mdPath, override);
    assert.equal(
      result.jsonPath,
      null,
      'override of .md must NOT write a .json companion',
    );
    assert.equal(fs.readFileSync(override, 'utf8'), SAMPLE_MD);
    assert.equal(fs.statSync(override).mode & 0o777, 0o600);

    // The reports dir under stateDir must not even exist — no
    // default-path side-effects when override is set.
    assert.equal(
      fs.existsSync(reportsDirOf(stateDir)),
      false,
      'default reports dir must not be created when outputOverride is set',
    );
  } finally {
    rmrf(stateDir);
    rmrf(overrideDir);
  }
});

test('FileWriter: outputOverride with unknown extension is rejected', () => {
  // The override path's extension dictates the chosen format
  // (.md → markdown, .json → JSON). Any other extension is a
  // misuse — exit-1 territory in the CLI layer, but at the
  // FileWriter level we surface as a thrown Error so the caller
  // can map to the right exit code.
  const stateDir = mkStateDir();
  const overrideDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'opencode-cost-diagnosis-override-'),
  );
  try {
    const override = path.join(overrideDir, 'foo.bar');
    const fw = new FileWriter({
      stateDir,
      outputOverride: override,
    });
    assert.throws(
      () =>
        fw.write({
          markdown: SAMPLE_MD,
          json: SAMPLE_JSON,
          generatedAt: FIXED_DATE,
        }),
      /(\.md|\.json|unknown|unsupported|extension)/i,
      'rejecting a .bar override must name the supported extensions or the offending extension',
    );
    assert.equal(
      fs.existsSync(override),
      false,
      'a rejected override must not have created the target file',
    );
  } finally {
    rmrf(stateDir);
    rmrf(overrideDir);
  }
});

test('FileWriter: I/O write error (EACCES) throws a typed error naming path + operation (R6.AC5)', () => {
  // Simulate a non-ENOENT write failure by making the reports dir
  // read-only so the open(2) inside fs.writeFileSync fails with
  // EACCES. The thrown error must carry both the affected path
  // and the operation ("write"), so the CLI layer (task 5.3) can
  // assemble the exit-4 stderr trailer from named fields rather
  // than parsing message text.
  const stateDir = mkStateDir();
  try {
    const rdir = reportsDirOf(stateDir);
    fs.mkdirSync(rdir, { recursive: true });
    // Strip write/exec on the dir so children can't be created.
    // The umask 0o077 the writer sets affects the FILE mode of
    // newly-created files, not pre-existing dir perms, so this
    // setup is independent of the umask logic.
    fs.chmodSync(rdir, 0o500);

    const fw = new FileWriter({ stateDir });
    let caught;
    try {
      fw.write({
        markdown: SAMPLE_MD,
        json: SAMPLE_JSON,
        generatedAt: FIXED_DATE,
      });
    } catch (e) {
      caught = e;
    }
    // Re-grant perms before any rmrf, so the cleanup in finally
    // succeeds regardless of the assertion outcomes below.
    fs.chmodSync(rdir, 0o700);

    assert.ok(caught, 'EACCES write must surface as a thrown error');
    assert.ok(
      typeof caught.path === 'string' && caught.path.length > 0,
      `caught error must expose a .path field naming the failing file; got ${caught.path}`,
    );
    assert.ok(
      caught.path.includes(rdir),
      `caught error's .path must reference the reports dir; got ${caught.path}`,
    );
    assert.equal(
      caught.operation,
      'write',
      `caught error's .operation must be "write"; got ${caught.operation}`,
    );
    // Original errno preserved so the CLI Entry can assert on it
    // (e.g. to distinguish EACCES from ENOSPC in the trailer).
    assert.ok(
      caught.code && caught.code !== 'ENOENT',
      `caught error must surface a non-ENOENT errno; got ${caught.code}`,
    );
  } finally {
    // Safety net: re-grant perms if an earlier assertion bailed
    // before the in-test chmod restoration ran.
    try {
      fs.chmodSync(reportsDirOf(stateDir), 0o700);
    } catch {
      // dir may not exist on certain failure paths; ignore
    }
    rmrf(stateDir);
  }
});

test('FileWriter: process umask is restored after write (no global side-effect)', () => {
  // The writer must `process.umask(0o077)` before opening report
  // files (to guarantee mode 0600) and restore the prior umask
  // afterward. A test that runs under an arbitrary process umask
  // and observes the post-write umask matches the pre-write umask
  // catches both the "set umask but forgot to restore" and the
  // "restore in non-finally path skipped on throw" bugs.
  const stateDir = mkStateDir();
  const priorUmask = process.umask();
  try {
    const fw = new FileWriter({ stateDir });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: FIXED_DATE,
    });
    // Read-only sample of the current umask; process.umask(value)
    // returns the prior umask but ALSO sets it, so we must pass
    // back the same value we read.
    const after = process.umask(priorUmask);
    assert.equal(
      after,
      priorUmask,
      `process umask must be restored to ${priorUmask.toString(8)} after write; saw ${after.toString(8)}`,
    );
  } finally {
    // Re-assert prior umask to neutralise any partial-set bug.
    process.umask(priorUmask);
    rmrf(stateDir);
  }
});

test('FileWriter: retentionCount option overrides the 10-per-extension default', () => {
  // The constructor honors a `retentionCount` override so the
  // integration / smoke test suites can pick a smaller cap and
  // exercise pruning without seeding 12+ files. Default is 10
  // (per R4.AC5 + memory-sync.nix:437-449 reference), override
  // must be a positive integer.
  const stateDir = mkStateDir();
  try {
    const rdir = reportsDirOf(stateDir);
    const base = Date.parse('2026-06-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      placeFile(
        path.join(rdir, `2026-06-01T00-${String(i).padStart(2, '0')}-00.000Z.md`),
        `seeded md ${i}`,
        base + i * 60_000,
      );
      placeFile(
        path.join(rdir, `2026-06-01T00-${String(i).padStart(2, '0')}-00.000Z.json`),
        `{"seeded":${i}}`,
        base + i * 60_000,
      );
    }

    const fw = new FileWriter({ stateDir, retentionCount: 3 });
    fw.write({
      markdown: SAMPLE_MD,
      json: SAMPLE_JSON,
      generatedAt: new Date(),
    });

    const after = fs.readdirSync(rdir);
    assert.equal(
      after.filter((n) => n.endsWith('.md')).length,
      3,
      'retentionCount=3 must leave exactly 3 .md files',
    );
    assert.equal(
      after.filter((n) => n.endsWith('.json')).length,
      3,
      'retentionCount=3 must leave exactly 3 .json files',
    );
  } finally {
    rmrf(stateDir);
  }
});
