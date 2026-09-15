'use strict';

/*
 * smoke-plan.test.js — Task 5.2 smoke-plan report generation.
 *
 * Generates per-agent smoke-plan entries from budget metadata and
 * smoke-catalog definitions. Verifies that enforced agents emit
 * full smoke entries (direct-invocation example included) and that
 * unbudgeted agents emit skipped-unbudgeted entries citing the
 * operator escape hatch (R6.1, R6.5, R7.5).
 *
 * Requirements: 6.1 (smoke test per budgeted agent),
 * 6.5 (preserve direct invocation), 7.5 (leave disabled agents
 * unchanged and report disabled state).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLI_PATH = path.join(__dirname, '../../../scripts/subagent-context-budget.js');
const FIXTURES_DIR = path.join(__dirname, '../fixtures');
const REPO_SMOKE_CATALOG = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/smoke-catalog.json',
);

const {
  buildSmokePlan,
  main,
  parseSmokePlanFlags,
  renderSmokePlanJson,
  renderSmokePlanMarkdown,
  runSmokePlanCommand,
} = require(CLI_PATH);

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadFixture(name) {
  return loadJson(path.join(FIXTURES_DIR, name));
}

function loadRepoCatalog() {
  return loadJson(REPO_SMOKE_CATALOG);
}

function captureMain(argv) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  try {
    return {
      exitCode: main(argv),
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
    };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

function writeTempJson(prefix, body) {
  const file = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
  );
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

// -----------------------------------------------------------------
// Helpers for building metadata with arbitrary agents.
// -----------------------------------------------------------------

function fixtureWithAgent(name, overrides) {
  const meta = loadFixture('budget-metadata.json');
  meta.agents[name] = {
    name,
    source: 'common-markdown',
    hostScope: 'all',
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'placeholder',
    permissionBudget: { read: 'allow' },
    capabilityRationale: [],
    smokeClass: 'placeholder-class',
    ...overrides,
  };
  return meta;
}

// -----------------------------------------------------------------
// Golden snapshot — buildSmokePlan output for the committed budget
// metadata fixture and the in-repo smoke catalog.
// -----------------------------------------------------------------

test('buildSmokePlan: matches smoke-plan-golden.json for the committed fixtures', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();
  const expected = loadFixture('smoke-plan-golden.json');

  const result = buildSmokePlan(metadata, catalog);

  assert.equal(result.ok, true, `buildSmokePlan must succeed; got ${JSON.stringify(result.error)}`);
  assert.deepEqual(result.value, expected);
});

// -----------------------------------------------------------------
// R6.1 — provide a smoke entry for every enforced agent.
// -----------------------------------------------------------------

test('buildSmokePlan: returns a plan entry per enforced agent matching the catalog (R6.1)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);

  assert.equal(result.ok, true, `buildSmokePlan must succeed; got ${JSON.stringify(result.error)}`);
  const plan = result.value;
  assert.equal(plan.command, 'smoke-plan');
  assert.equal(plan.schemaVersion, 1);
  assert.equal(plan.host, 'all');

  const names = plan.entries.map((e) => e.agentName);
  assert.deepEqual(names, ['explore', 'general']);
  assert.equal(plan.summary.agentCount, 2);
  assert.equal(plan.summary.enforcedCount, 2);
  assert.equal(plan.summary.skippedUnbudgetedCount, 0);
});

// -----------------------------------------------------------------
// R6.5 — direct invocation must be preserved in the plan entry.
// -----------------------------------------------------------------

test('buildSmokePlan: enforced entries include direct-invocation example and smoke metadata (R6.1, R6.5)', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true);

  const explore = result.value.entries.find((e) => e.agentName === 'explore');
  assert.ok(explore, 'explore entry must be present');
  assert.equal(explore.state, 'enforced');
  assert.equal(explore.hostScope, 'all');
  assert.ok(explore.smoke, 'enforced entry must include smoke metadata');
  assert.equal(explore.smoke.class, 'readonly-codebase-question');
  assert.ok(typeof explore.smoke.representativeTask === 'string' && explore.smoke.representativeTask.length > 0);
  assert.ok(Array.isArray(explore.smoke.expectations.passCriteria) && explore.smoke.expectations.passCriteria.length > 0);
  assert.ok(Array.isArray(explore.smoke.expectations.failureSignals) && explore.smoke.expectations.failureSignals.length > 0);
  assert.ok(typeof explore.smoke.expectations.skippedUnbudgeted === 'string' && explore.smoke.expectations.skippedUnbudgeted.length > 0);
  assert.ok(explore.smoke.nonInteractive && typeof explore.smoke.nonInteractive.strategy === 'string');
  assert.ok(
    typeof explore.smoke.directInvocation === 'string'
      && explore.smoke.directInvocation.includes('--agent explore'),
    'directInvocation must reference --agent explore',
  );
  assert.equal(Object.prototype.hasOwnProperty.call(explore, 'skip'), false);
});

// -----------------------------------------------------------------
// R7.5 — disabled (unbudgeted) agents leave behavior unchanged and the
// plan reports the disabled state with the operator escape hatch.
// -----------------------------------------------------------------

test('buildSmokePlan: emits skipped-unbudgeted entry for operator escape hatch and omits smoke metadata (R7.5)', () => {
  const metadata = fixtureWithAgent('operator-escape', {
    state: { kind: 'unbudgeted', reason: 'operator-escape-hatch' },
    instructionProfile: '',
    permissionBudget: {},
    smokeClass: 'operator-escape',
    hostScope: 'all',
  });
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true, `buildSmokePlan must succeed; got ${JSON.stringify(result.error)}`);

  const escapeHatch = result.value.entries.find((e) => e.agentName === 'operator-escape');
  assert.ok(escapeHatch, 'operator-escape entry must be present');
  assert.equal(escapeHatch.state, 'skipped-unbudgeted');
  assert.equal(escapeHatch.hostScope, 'all');
  assert.equal(Object.prototype.hasOwnProperty.call(escapeHatch, 'smoke'), false,
    'skipped-unbudgeted entry must omit smoke metadata');
  assert.ok(escapeHatch.skip, 'skipped-unbudgeted entry must include skip block');
  assert.equal(escapeHatch.skip.reason, 'operator-escape-hatch');
  assert.ok(
    typeof escapeHatch.skip.explanation === 'string' && escapeHatch.skip.explanation.length > 0,
    'skipped-unbudgeted entry must include an explanation citing the escape hatch',
  );
  assert.match(escapeHatch.skip.explanation, /escape[- ]hatch|unbudgeted/i);

  assert.equal(result.value.summary.skippedUnbudgetedCount, 1);
  assert.equal(result.value.summary.enforcedCount, 2);
  assert.equal(result.value.summary.agentCount, 3);
});

// -----------------------------------------------------------------
// Missing-catalog-entry: enforced agent in metadata with no matching
// catalog entry must produce an actionable error (R6.1).
// -----------------------------------------------------------------

test('buildSmokePlan: fails with named error when an enforced agent has no smoke definition (R6.1)', () => {
  const metadata = fixtureWithAgent('ghost-agent', {
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'placeholder',
    permissionBudget: { read: 'allow' },
    smokeClass: 'ghost-class',
  });
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, false);
  assert.ok(result.error, 'error block must be present');
  assert.equal(result.error.kind, 'missing-smoke-definition');
  assert.equal(result.error.agentName, 'ghost-agent');
  assert.match(result.error.message, /ghost-agent/);
});

// -----------------------------------------------------------------
// Missing-metadata-entry: catalog entry without a corresponding
// metadata agent is silently skipped (catalog covers all hosts;
// metadata only covers agents in scope). This is not an error.
// -----------------------------------------------------------------

test('buildSmokePlan: skips catalog entries whose agent is not present in the metadata', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true);

  const names = result.value.entries.map((e) => e.agentName);
  // The repo catalog includes nix-pkg, stack-captain,
  // yb-sleuth, etc. that are absent from the small fixture metadata.
  // The plan must not invent them.
  for (const absent of ['nix-pkg', 'stack-captain', 'yb-sleuth']) {
    assert.equal(names.includes(absent), false, `plan must not include catalog-only agent ${absent}`);
  }
});

// -----------------------------------------------------------------
// Class mismatch: enforced metadata agent whose smokeClass differs
// from the catalog entry's class must also be reported as a missing
// match.
// -----------------------------------------------------------------

test('buildSmokePlan: fails when an enforced agent smokeClass does not match the catalog class', () => {
  const metadata = fixtureWithAgent('nix-pkg', {
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'placeholder',
    permissionBudget: { read: 'allow' },
    // Catalog has class `nix-package-evaluation`; deliberately diverge.
    smokeClass: 'unexpected-class',
  });
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'smoke-class-mismatch');
  assert.equal(result.error.agentName, 'nix-pkg');
  assert.match(result.error.message, /nix-pkg/);
});

// -----------------------------------------------------------------
// Invalid metadata short-circuits to a validation error.
// -----------------------------------------------------------------

test('buildSmokePlan: surfaces metadata validation errors as invalid-metadata', () => {
  const broken = loadFixture('budget-metadata.json');
  broken.version = 99;
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(broken, catalog);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-metadata');
  assert.ok(Array.isArray(result.error.errors) && result.error.errors.length > 0);
});

// -----------------------------------------------------------------
// Invalid catalog short-circuits to a catalog validation error.
// -----------------------------------------------------------------

test('buildSmokePlan: surfaces catalog validation errors as invalid-catalog', () => {
  const metadata = loadFixture('budget-metadata.json');
  const broken = { schemaVersion: 2, smokeDefinitions: [] };

  const result = buildSmokePlan(metadata, broken);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'invalid-catalog');
  assert.ok(Array.isArray(result.error.errors) && result.error.errors.length > 0);
});

// -----------------------------------------------------------------
// Determinism — repeated invocations and key ordering are byte-stable.
// -----------------------------------------------------------------

test('buildSmokePlan: output is byte-stable across repeated invocations', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();

  const a = buildSmokePlan(metadata, catalog);
  const b = buildSmokePlan(metadata, catalog);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a.value, b.value);
  assert.equal(renderSmokePlanJson(a.value), renderSmokePlanJson(b.value));
});

test('buildSmokePlan: entries are alphabetised by agent name', () => {
  const metadata = fixtureWithAgent('aaaa-agent', {
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'placeholder',
    permissionBudget: { read: 'allow' },
    smokeClass: 'general-research',
  });
  // Force an enforced-but-no-catalog mismatch by giving it the same
  // class as `general` won't help (agent name mismatch); instead, mark
  // it unbudgeted so we don't trip the missing-definition error.
  metadata.agents['aaaa-agent'].state = {
    kind: 'unbudgeted',
    reason: 'operator-escape-hatch',
  };
  const catalog = loadRepoCatalog();

  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true);

  const names = result.value.entries.map((e) => e.agentName);
  const sorted = [...names].sort();
  assert.deepEqual(names, sorted, 'entries must be alphabetised by agentName');
});

test('renderSmokePlanJson: produces 2-space indented JSON with stable key order and no wall-clock', () => {
  const metadata = loadFixture('budget-metadata.json');
  const catalog = loadRepoCatalog();
  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true);

  const json = renderSmokePlanJson(result.value);
  assert.equal(json.startsWith('{'), true);
  // Indented with 2 spaces (matches the audit/validate JSON renderers).
  assert.ok(json.includes('\n  "'));
  // No timestamps or wall-clock leakage.
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(json), false);
  // Top-level keys are alphabetical.
  const parsed = JSON.parse(json);
  const topKeys = Object.keys(parsed);
  assert.deepEqual(topKeys, [...topKeys].sort());
});

// -----------------------------------------------------------------
// Markdown view — derived from the same plan object, deterministic.
// -----------------------------------------------------------------

test('renderSmokePlanMarkdown: deterministic Markdown view enumerates enforced and skipped agents', () => {
  const metadata = fixtureWithAgent('operator-escape', {
    state: { kind: 'unbudgeted', reason: 'operator-escape-hatch' },
    instructionProfile: '',
    permissionBudget: {},
    smokeClass: 'operator-escape',
    hostScope: 'all',
  });
  const catalog = loadRepoCatalog();
  const result = buildSmokePlan(metadata, catalog);
  assert.equal(result.ok, true);

  const md1 = renderSmokePlanMarkdown(result.value);
  const md2 = renderSmokePlanMarkdown(result.value);
  assert.equal(md1, md2, 'Markdown rendering must be deterministic');

  assert.match(md1, /# Subagent Context Budget — Smoke Plan/);
  assert.match(md1, /### explore/);
  assert.match(md1, /### general/);
  assert.match(md1, /### operator-escape/);
  // Enforced agents must show direct invocation; skipped agents must
  // show the escape-hatch reason.
  assert.match(md1, /opencode run --agent explore/);
  assert.match(md1, /operator-escape-hatch/);
  assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(md1), false);
});

// -----------------------------------------------------------------
// CLI flag parsing.
// -----------------------------------------------------------------

test('parseSmokePlanFlags: extracts --metadata, --smoke-catalog, --format', () => {
  const flags = parseSmokePlanFlags([
    '--metadata', '/tmp/m.json',
    '--smoke-catalog', '/tmp/c.json',
    '--format', 'markdown',
  ]);
  assert.equal(flags.metadata, '/tmp/m.json');
  assert.equal(flags['smoke-catalog'], '/tmp/c.json');
  assert.equal(flags.format, 'markdown');
});

// -----------------------------------------------------------------
// CLI integration: main(smoke-plan) reads the files and writes the
// real plan (no longer a placeholder).
// -----------------------------------------------------------------

test('main(smoke-plan): without --metadata exits 1 with a named-flag error (no placeholder)', () => {
  const { exitCode, stdout, stderr } = captureMain(['smoke-plan']);
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(stderr.includes('--metadata'), `stderr must mention --metadata; got ${stderr}`);
});

test('main(smoke-plan): prints a real JSON plan when given the repo fixtures', () => {
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
    '--smoke-catalog', REPO_SMOKE_CATALOG,
  ]);

  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.command, 'smoke-plan');
  assert.notEqual(parsed.status, 'placeholder', 'smoke-plan must no longer be a placeholder after task 5.2');
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.entries.length, 2);
  assert.deepEqual(parsed.entries.map((e) => e.agentName), ['explore', 'general']);
  // Privacy posture: no prompt or tool-output content.
  assert.equal(stdout.includes('promptBody'), false);
  assert.equal(stdout.includes('toolOutputBody'), false);
});

test('main(smoke-plan): byte-stable across repeated invocations', () => {
  const args = [
    'smoke-plan',
    '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
    '--smoke-catalog', REPO_SMOKE_CATALOG,
  ];
  const first = captureMain(args);
  const second = captureMain(args);
  assert.equal(first.exitCode, 0);
  assert.equal(second.exitCode, 0);
  assert.equal(first.stdout, second.stdout);
});

test('main(smoke-plan): markdown format emits a Markdown plan', () => {
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
    '--smoke-catalog', REPO_SMOKE_CATALOG,
    '--format', 'markdown',
  ]);
  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  assert.match(stdout, /# Subagent Context Budget — Smoke Plan/);
  assert.match(stdout, /opencode run --agent explore/);
});

test('main(smoke-plan): defaults to repo smoke-catalog when --smoke-catalog is omitted', () => {
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
  ]);
  assert.equal(stderr, '');
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.entries.length, 2);
});

test('main(smoke-plan): exits 1 when metadata file is missing', () => {
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', '/nonexistent/budget-metadata.json',
    '--smoke-catalog', REPO_SMOKE_CATALOG,
  ]);
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(/metadata/i.test(stderr));
});

test('main(smoke-plan): exits 1 when smoke-catalog file is missing', () => {
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
    '--smoke-catalog', '/nonexistent/smoke-catalog.json',
  ]);
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(/smoke[- ]catalog|catalog/i.test(stderr));
});

test('main(smoke-plan): exits 1 when metadata is invalid', () => {
  const bad = writeTempJson('bad-metadata', { version: 99, host: 'all' });
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', bad,
    '--smoke-catalog', REPO_SMOKE_CATALOG,
  ]);
  fs.unlinkSync(bad);
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.ok(/invalid-metadata|metadata/i.test(stderr));
});

test('main(smoke-plan): exits 1 with named missing-smoke-definition error', () => {
  const metaWithGhost = fixtureWithAgent('ghost-agent', {
    state: { kind: 'enforced', reason: 'default' },
    instructionProfile: 'placeholder',
    permissionBudget: { read: 'allow' },
    smokeClass: 'ghost-class',
  });
  const ghostPath = writeTempJson('ghost-metadata', metaWithGhost);
  const { exitCode, stdout, stderr } = captureMain([
    'smoke-plan',
    '--metadata', ghostPath,
    '--smoke-catalog', REPO_SMOKE_CATALOG,
  ]);
  fs.unlinkSync(ghostPath);
  assert.equal(exitCode, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /ghost-agent/);
});

// -----------------------------------------------------------------
// runSmokePlanCommand: programmatic entry point (no CLI parsing).
// -----------------------------------------------------------------

test('runSmokePlanCommand: dispatches with parsed flags and writes JSON', () => {
  // Sanity-check that the command can be invoked programmatically; it
  // routes through writeStdout / writeStderr like the other commands.
  const stdoutChunks = [];
  const realOut = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    return true;
  };
  let exitCode;
  try {
    exitCode = runSmokePlanCommand([
      '--metadata', path.join(FIXTURES_DIR, 'budget-metadata.json'),
      '--smoke-catalog', REPO_SMOKE_CATALOG,
    ]);
  } finally {
    process.stdout.write = realOut;
  }
  assert.equal(exitCode, 0);
  const parsed = JSON.parse(stdoutChunks.join(''));
  assert.equal(parsed.command, 'smoke-plan');
  assert.equal(parsed.entries.length, 2);
});
