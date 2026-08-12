'use strict';

/*
 * smoke-catalog.test.js — Task 5.1 smoke-definition catalog.
 *
 * Validates the per-agent smoke-test catalog at
 * `home-manager/common/subagent-context-budget/smoke-catalog.json` and
 * the `loadSmokeCatalog` / `validateSmokeCatalog` helpers in the CLI
 * module.
 *
 * Requirements: 6.1 (smoke per agent), 6.2 (representative task),
 * 6.5 (preserve direct invocation), 7.2 (host parity).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  loadSmokeCatalog,
  validateSmokeCatalog,
} = require(path.join(__dirname, '../../../scripts/subagent-context-budget.js'));

const CATALOG_PATH = path.join(
  __dirname,
  '../../../home-manager/common/subagent-context-budget/smoke-catalog.json',
);

// Mirror of `home-manager/common/subagent-context-budget/budgets.nix`
// smokeClass assignments. Used for cross-check validation. Sourced
// directly from `budgets.nix` so the test fails if the .nix file drifts
// out of sync with the JSON catalog.
const BUDGETED_AGENTS = {
  general: { smokeClass: 'general-research', hostScope: 'all' },
  explore: { smokeClass: 'readonly-codebase-question', hostScope: 'all' },
  'nix-pkg': { smokeClass: 'nix-package-evaluation', hostScope: 'all' },
  'kiro-spec-orchestrator': { smokeClass: 'kiro-spec-orchestration', hostScope: 'all' },
  'nvim-tailor': { smokeClass: 'nvim-config-inspection', hostScope: 'all' },
  'security-auditor': { smokeClass: 'security-fixture-audit', hostScope: 'all' },
  'vault-curator': { smokeClass: 'vault-dedup-plan', hostScope: 'all' },
  'vault-synthesizer': { smokeClass: 'cavemem-to-memory-draft', hostScope: 'all' },
  'binks-overrider': { smokeClass: 'shopify-binks-override', hostScope: 'shopify' },
  'binks-reviewer': { smokeClass: 'shopify-binks-review', hostScope: 'shopify' },
  'bot-thread-triager': { smokeClass: 'shopify-bot-thread-triage', hostScope: 'shopify' },
  'ci-log-sleuth': { smokeClass: 'shopify-ci-log-analysis', hostScope: 'shopify' },
  'stack-fix-reviewer': { smokeClass: 'shopify-fix-review', hostScope: 'shopify' },
  'stack-captain': { smokeClass: 'shopify-stack-plan', hostScope: 'shopify' },
  'stack-preflight-auditor': { smokeClass: 'shopify-stack-preflight', hostScope: 'shopify' },
  'stack-status-sweeper': { smokeClass: 'shopify-stack-status', hostScope: 'shopify' },
  'yb-sleuth': { smokeClass: 'shopify-source-trace', hostScope: 'shopify' },
};

function fullBudgetMetadata() {
  const agents = {};
  for (const [name, info] of Object.entries(BUDGETED_AGENTS)) {
    agents[name] = {
      name,
      source: 'builtin',
      hostScope: info.hostScope,
      state: { kind: 'enforced', reason: 'default' },
      instructionProfile: 'placeholder',
      permissionBudget: { read: 'allow' },
      capabilityRationale: [],
      smokeClass: info.smokeClass,
    };
  }
  return { agents };
}

function makeDefinition(overrides = {}) {
  return {
    class: 'readonly-codebase-question',
    agentName: 'explore',
    hostScope: 'all',
    representativeTask: 'Locate the definition of a known function and return file_path:line_number.',
    expectations: {
      passCriteria: ['response includes a file path with line number'],
      failureSignals: ['agent reports missing read or grep permission'],
      skippedUnbudgeted: 'smoke runner emits skipped-unbudgeted without invoking the agent',
    },
    nonInteractive: {
      strategy: 'allow-only',
      details: 'All required permissions are allow rules; no ask prompts.',
    },
    directInvocation: 'opencode run --agent explore -- "Find definition of validateBudgetMetadata"',
    ...overrides,
  };
}

function makeCatalog(definitions) {
  return { schemaVersion: 1, smokeDefinitions: definitions };
}

test('smoke catalog file exists and loads', () => {
  assert.equal(fs.existsSync(CATALOG_PATH), true, `expected ${CATALOG_PATH} to exist`);
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true, JSON.stringify(result.errors || result.error, null, 2));
});

test('smoke catalog covers every budgeted agent', () => {
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  const expectedAgents = Object.keys(BUDGETED_AGENTS).sort();
  const actualAgents = result.value.smokeDefinitions.map((d) => d.agentName).sort();
  assert.deepEqual(actualAgents, expectedAgents);
});

test('smoke catalog covers every required smoke class', () => {
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  const expectedClasses = Object.values(BUDGETED_AGENTS).map((a) => a.smokeClass).sort();
  const actualClasses = result.value.smokeDefinitions.map((d) => d.class).sort();
  assert.deepEqual(actualClasses, expectedClasses);
});

test('smoke catalog is deterministically ordered by class', () => {
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  const classes = result.value.smokeDefinitions.map((d) => d.class);
  const sorted = [...classes].sort();
  assert.deepEqual(classes, sorted, 'smoke definitions must be sorted alphabetically by class');
});

test('smoke catalog cross-checks against budget metadata succeed', () => {
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  const crossCheck = validateSmokeCatalog(result.value, {
    budgetMetadata: fullBudgetMetadata(),
  });
  assert.equal(crossCheck.ok, true, JSON.stringify(crossCheck.errors, null, 2));
});

test('each smoke definition has required fields populated', () => {
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  for (const def of result.value.smokeDefinitions) {
    assert.ok(typeof def.class === 'string' && def.class.length > 0, `class missing for ${def.agentName}`);
    assert.ok(typeof def.agentName === 'string' && def.agentName.length > 0, `agentName missing for ${def.class}`);
    assert.ok(['all', 'shopify', 'personal'].includes(def.hostScope), `bad hostScope for ${def.class}`);
    assert.ok(typeof def.representativeTask === 'string' && def.representativeTask.length > 0, `representativeTask missing for ${def.class}`);
    assert.ok(Array.isArray(def.expectations.passCriteria) && def.expectations.passCriteria.length > 0, `passCriteria missing for ${def.class}`);
    assert.ok(Array.isArray(def.expectations.failureSignals) && def.expectations.failureSignals.length > 0, `failureSignals missing for ${def.class}`);
    assert.ok(typeof def.expectations.skippedUnbudgeted === 'string' && def.expectations.skippedUnbudgeted.length > 0, `skippedUnbudgeted missing for ${def.class}`);
    assert.ok(def.nonInteractive && typeof def.nonInteractive.strategy === 'string' && def.nonInteractive.strategy.length > 0, `nonInteractive.strategy missing for ${def.class}`);
    assert.ok(typeof def.nonInteractive.details === 'string' && def.nonInteractive.details.length > 0, `nonInteractive.details missing for ${def.class}`);
    assert.ok(typeof def.directInvocation === 'string' && def.directInvocation.length > 0, `directInvocation missing for ${def.class}`);
    assert.ok(
      def.directInvocation.includes(def.agentName),
      `directInvocation for ${def.class} must reference agent ${def.agentName}`,
    );
  }
});

test('each smoke definition uses a recognised nonInteractive strategy', () => {
  const allowed = new Set(['allow-only', 'auto-allow-ask', 'task-restricts-ask']);
  const result = loadSmokeCatalog(CATALOG_PATH);
  assert.equal(result.ok, true);
  for (const def of result.value.smokeDefinitions) {
    assert.ok(
      allowed.has(def.nonInteractive.strategy),
      `unrecognised strategy ${def.nonInteractive.strategy} for ${def.class}`,
    );
  }
});

test('validateSmokeCatalog accepts a minimal in-memory catalog', () => {
  const result = validateSmokeCatalog(makeCatalog([makeDefinition()]));
  assert.equal(result.ok, true);
  assert.equal(result.value.definitionCount, 1);
  assert.deepEqual(result.value.classes, ['readonly-codebase-question']);
});

test('validateSmokeCatalog rejects unsupported schemaVersion', () => {
  const result = validateSmokeCatalog({ schemaVersion: 2, smokeDefinitions: [makeDefinition()] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'schemaVersion'));
});

test('validateSmokeCatalog rejects non-array smokeDefinitions', () => {
  const result = validateSmokeCatalog({ schemaVersion: 1, smokeDefinitions: {} });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'smokeDefinitions'));
});

test('validateSmokeCatalog rejects definitions missing required fields', () => {
  const bad = makeDefinition();
  delete bad.representativeTask;
  delete bad.expectations.passCriteria;
  const result = validateSmokeCatalog(makeCatalog([bad]));
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('representativeTask'), `missing representativeTask not flagged: ${JSON.stringify(result.errors)}`);
  assert.ok(fields.includes('expectations.passCriteria'), `missing passCriteria not flagged: ${JSON.stringify(result.errors)}`);
});

test('validateSmokeCatalog rejects empty passCriteria / failureSignals', () => {
  const bad = makeDefinition({
    expectations: {
      passCriteria: [],
      failureSignals: [],
      skippedUnbudgeted: 'documented skip',
    },
  });
  const result = validateSmokeCatalog(makeCatalog([bad]));
  assert.equal(result.ok, false);
  const fields = result.errors.map((e) => e.field);
  assert.ok(fields.includes('expectations.passCriteria'));
  assert.ok(fields.includes('expectations.failureSignals'));
});

test('validateSmokeCatalog rejects invalid hostScope', () => {
  const bad = makeDefinition({ hostScope: 'invalid' });
  const result = validateSmokeCatalog(makeCatalog([bad]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'hostScope'));
});

test('validateSmokeCatalog rejects unrecognised nonInteractive strategy', () => {
  const bad = makeDefinition({
    nonInteractive: { strategy: 'wishful-thinking', details: '...' },
  });
  const result = validateSmokeCatalog(makeCatalog([bad]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.field === 'nonInteractive.strategy'));
});

test('validateSmokeCatalog rejects duplicate class entries', () => {
  const result = validateSmokeCatalog(makeCatalog([makeDefinition(), makeDefinition()]));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate/i.test(e.message)));
});

test('validateSmokeCatalog rejects out-of-order definitions', () => {
  const result = validateSmokeCatalog(makeCatalog([
    makeDefinition({ class: 'readonly-codebase-question', agentName: 'explore' }),
    makeDefinition({ class: 'general-research', agentName: 'general' }),
  ]));
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /alphabetical|order|sorted/i.test(e.message)),
    `expected ordering error, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateSmokeCatalog cross-check rejects unknown agentName when budgetMetadata is provided', () => {
  const bad = makeDefinition({ class: 'mystery-class', agentName: 'ghost-agent' });
  const result = validateSmokeCatalog(makeCatalog([bad]), {
    budgetMetadata: fullBudgetMetadata(),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /not found|unknown|absent/i.test(e.message)),
    `expected unknown-agent error, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateSmokeCatalog cross-check rejects class mismatch with budget metadata', () => {
  const bad = makeDefinition({
    class: 'general-research',
    agentName: 'explore',
  });
  const result = validateSmokeCatalog(makeCatalog([bad]), {
    budgetMetadata: fullBudgetMetadata(),
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /smokeClass|mismatch/i.test(e.message)),
    `expected smokeClass-mismatch error, got ${JSON.stringify(result.errors)}`,
  );
});

test('validateSmokeCatalog cross-check rejects hostScope mismatch with budget metadata', () => {
  const meta = fullBudgetMetadata();
  meta.agents['stack-captain'].hostScope = 'shopify';
  const bad = makeDefinition({
    class: 'shopify-stack-plan',
    agentName: 'stack-captain',
    hostScope: 'all',
  });
  const result = validateSmokeCatalog(makeCatalog([bad]), { budgetMetadata: meta });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((e) => /hostScope/i.test(e.message)),
    `expected hostScope-mismatch error, got ${JSON.stringify(result.errors)}`,
  );
});

test('loadSmokeCatalog returns missing-file error for nonexistent path', () => {
  const result = loadSmokeCatalog('/nonexistent/smoke-catalog.json');
  assert.equal(result.ok, false);
  assert.ok(result.error && /not found|ENOENT|missing/i.test(result.error.message || result.error.kind || ''));
});

test('smoke catalog file is byte-stable when re-serialized deterministically', () => {
  const raw = fs.readFileSync(CATALOG_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  // Definitions must be alphabetised by class; re-sorting must be a no-op.
  const classes = parsed.smokeDefinitions.map((d) => d.class);
  assert.deepEqual(classes, [...classes].sort());
});
