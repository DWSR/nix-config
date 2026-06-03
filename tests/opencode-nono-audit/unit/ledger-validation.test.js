/*
 * ledger-validation.test.js — focused UNIT tests for the decisions-ledger
 * required-field validator's UNCOVERED branches (opencode-nono-audit spec,
 * Task 4.2, Requirements 3.4, 3.5, 3.6).
 *
 * integration/review-ledger.test.js already exercises (via injected
 * ledgers, so it is effectively unit-level) the core matrix: replace →
 * permissionReduction + workflowChange, keep → keepReason +
 * requiredCapability, defer/none → no extra fields, undecided echo, and
 * missing-file behavior. This suite does NOT duplicate that; it pins the
 * two genuinely-uncovered validator branches plus the required-fields
 * contract constant:
 *
 *   1. An UNRECOGNIZED decision (a typo'd / unknown decision string)
 *      yields exactly one `decision`-field error naming the tool — the
 *      `!LEDGER_DECISIONS.includes(decision)` branch, untested elsewhere.
 *   2. An empty / whitespace-only required field is treated as MISSING
 *      (the `value.trim().length > 0` predicate) — distinct from the
 *      absent-key cases the integration suite covers.
 *   3. LEDGER_REQUIRED_FIELDS is the frozen decision→required-fields
 *      contract, asserted directly (R3.5/R3.6 source of truth).
 *
 * Driven through the exported reconcileLedger with an INJECTED ledger
 * (opts.ledger) — pure, no disk I/O.
 *
 * Lives under unit/ (run.js recurses everywhere except fixtures/ and
 * node_modules/).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  reconcileLedger,
  LEDGER_REQUIRED_FIELDS,
} = require('../../../scripts/opencode-nono-audit.js');

/** Minimal candidate set: one tool is enough for validator-branch tests. */
function candidates() {
  return [{ tool: 'git', rationale: 'x' }];
}

/** Errors naming a given tool. */
function errorsForTool(result, tool) {
  return result.errors.filter((e) => e.tool === tool);
}

// ────────────────────────────────────────────────────────────────────
// 1. Unrecognized decision → single `decision`-field error (R3.4)
// ────────────────────────────────────────────────────────────────────

test('an unrecognized decision yields exactly one decision-field error naming the tool (R3.4)', () => {
  const ledger = { entries: [{ tool: 'git', decision: 'replaace' }] }; // typo
  const result = reconcileLedger(candidates(), { ledger });

  const gitErrors = errorsForTool(result, 'git');
  assert.equal(gitErrors.length, 1, 'an unrecognized decision must yield exactly one error');
  assert.equal(gitErrors[0].field, 'decision', 'the error must be on the decision field');
  assert.match(gitErrors[0].message, /git/, 'message must name the tool');
  assert.match(gitErrors[0].message, /replaace/, 'message must echo the bad decision value');
  // The entry is still reconciled (the bad decision is recorded for the
  // operator to fix), but it does NOT spuriously emit required-field errors.
  const reconciled = result.reconciled.find((r) => r.tool === 'git');
  assert.ok(reconciled, 'the entry is still reconciled so the operator sees it');
  assert.equal(reconciled.decision, 'replaace');
  assert.ok(
    !gitErrors.some((e) => e.field === 'permissionReduction' || e.field === 'workflowChange'),
    'an unrecognized decision must NOT also emit required-field errors',
  );
});

// ────────────────────────────────────────────────────────────────────
// 2. Whitespace-only required field is treated as MISSING (R3.5/R3.6)
// ────────────────────────────────────────────────────────────────────

test('a whitespace-only required field is treated as missing (R3.5)', () => {
  const ledger = {
    entries: [
      {
        tool: 'git',
        decision: 'replace',
        permissionReduction: '   ', // present but blank → must count as missing
        workflowChange: 'use git-mcp-server',
      },
    ],
  };
  const result = reconcileLedger(candidates(), { ledger });

  const gitErrors = errorsForTool(result, 'git');
  const permErr = gitErrors.find((e) => e.field === 'permissionReduction');
  assert.ok(permErr, 'a whitespace-only required value must be flagged as missing');
  assert.match(permErr.message, /permissionReduction/, 'message must name the field');
  // workflowChange is genuinely present → no error for it.
  assert.ok(
    !gitErrors.some((e) => e.field === 'workflowChange'),
    'a present non-blank required field must not be flagged',
  );
});

// ────────────────────────────────────────────────────────────────────
// 3. A non-string required field is treated as MISSING (R3.6)
// ────────────────────────────────────────────────────────────────────

test('a non-string required field value is treated as missing (R3.6)', () => {
  const ledger = {
    entries: [
      {
        tool: 'git',
        decision: 'keep',
        keepReason: 42, // wrong type → must count as missing
        requiredCapability: 'external-command',
      },
    ],
  };
  const result = reconcileLedger(candidates(), { ledger });

  const gitErrors = errorsForTool(result, 'git');
  const reasonErr = gitErrors.find((e) => e.field === 'keepReason');
  assert.ok(reasonErr, 'a non-string required value must be flagged as missing');
  assert.ok(
    !gitErrors.some((e) => e.field === 'requiredCapability'),
    'the present string field must not be flagged',
  );
});

// ────────────────────────────────────────────────────────────────────
// 4. LEDGER_REQUIRED_FIELDS contract constant (R3.5/R3.6 source of truth)
// ────────────────────────────────────────────────────────────────────

test('LEDGER_REQUIRED_FIELDS encodes the replace/keep required-field contract and omits defer/none (R3.5, R3.6)', () => {
  assert.deepEqual(
    [...LEDGER_REQUIRED_FIELDS.replace],
    ['permissionReduction', 'workflowChange'],
    'replace requires permissionReduction + workflowChange (R3.5)',
  );
  assert.deepEqual(
    [...LEDGER_REQUIRED_FIELDS.keep],
    ['keepReason', 'requiredCapability'],
    'keep requires keepReason + requiredCapability (R3.6)',
  );
  // defer / none impose no extra required fields → absent from the map.
  assert.equal(LEDGER_REQUIRED_FIELDS.defer, undefined, 'defer imposes no required fields');
  assert.equal(LEDGER_REQUIRED_FIELDS.none, undefined, 'none imposes no required fields');
});
