/*
 * review-ledger.test.js — tests for the Tool-Use Replacement Review's
 * decisions-ledger RECONCILE + VALIDATE layer (opencode-nono-audit spec,
 * Task 4.2, Requirements 3.4, 3.5, 3.6, 3.7).
 *
 * Task 4.2 adds `reconcileLedger(candidates, opts)`: it reads an
 * OPERATOR-MAINTAINED decisions ledger and reconciles each seeded
 * ReplacementCandidate (from seedReplacementCandidates) to a
 * `keep | replace | defer | none` decision, validates the
 * decision-conditional required fields, and echoes undecided candidates:
 *
 *   reconcileLedger(candidates, opts) → {
 *     reconciled: Array<{ tool, decision, entry }>,
 *     undecided:  string[],   // candidate tools with no ledger entry (R3.4)
 *     errors:     Array<{ tool, field, message }>,  // missing required field
 *   }
 *
 * Validation (R3.5, R3.6):
 *   - decision "replace" MUST carry permissionReduction AND workflowChange.
 *   - decision "keep"    MUST carry keepReason AND requiredCapability.
 *   - "defer" / "none" carry no extra required fields.
 *   - a missing required field → a validation error NAMING the tool AND
 *     the missing field (the observable); all errors collected.
 *
 * Testability seam: `opts.ledger` supplies the ledger object directly,
 * or `opts.ledgerPath` supplies a ledger file PATH (so tests do not
 * depend on $XDG_STATE_HOME). A MISSING ledger file → all candidates
 * undecided, NO error.
 *
 * Advisory only (R3.7): reconcileLedger READS the ledger and RETURNS
 * reconciled/validation data only; it performs no permission/MCP
 * mutation and writes nothing (not even the ledger).
 *
 * Lives under integration/ (NOT fixtures/) so run.js's
 * discoverTestFiles() picks it up.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { reconcileLedger } = require('../../../scripts/opencode-nono-audit.js');

/** A small, fixed set of seeded candidates mirroring 4.1's output shape. */
function sampleCandidates() {
  return [
    { tool: 'git', mcpCandidate: 'git-mcp-server', rationale: 'replace git usage' },
    { tool: 'bash', rationale: 'no viable replacement: no known MCP server for this tool' },
    { tool: 'read', rationale: 'no viable replacement: no known MCP server for this tool' },
  ];
}

/** Find a reconciled entry by tool. */
function reconciledOf(result, tool) {
  return result.reconciled.find((r) => r.tool === tool);
}

/** Find an error entry naming a given tool. */
function errorsForTool(result, tool) {
  return result.errors.filter((e) => e.tool === tool);
}

// ────────────────────────────────────────────────────────────────────
// 1. replace MISSING permissionReduction (and/or workflowChange) →
//    validation error naming the tool + field (observable, R3.5)
// ────────────────────────────────────────────────────────────────────

test('a "replace" entry missing permissionReduction yields a validation error naming the tool and field (R3.5)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [
      // replace WITHOUT permissionReduction; workflowChange present.
      { tool: 'git', decision: 'replace', workflowChange: 'use git-mcp-server tools' },
    ],
  };

  const result = reconcileLedger(candidates, { ledger });

  assert.ok(Array.isArray(result.errors), 'errors must be an array');
  const gitErrors = errorsForTool(result, 'git');
  assert.ok(gitErrors.length >= 1, 'a replace entry missing a required field must yield an error');

  // The error must name BOTH the tool and the specific missing field.
  const permErr = gitErrors.find((e) => e.field === 'permissionReduction');
  assert.ok(permErr, `expected an error for the missing permissionReduction field; saw ${JSON.stringify(gitErrors)}`);
  assert.equal(permErr.tool, 'git', 'error must name the tool');
  assert.match(permErr.message, /git/, 'error message must include the tool name');
  assert.match(permErr.message, /permissionReduction/, 'error message must include the missing field name');
});

test('a "replace" entry missing BOTH required fields collects an error for each missing field (R3.5)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [{ tool: 'git', decision: 'replace' }], // neither field present
  };

  const result = reconcileLedger(candidates, { ledger });

  const gitErrors = errorsForTool(result, 'git');
  const fields = gitErrors.map((e) => e.field).sort();
  assert.deepEqual(
    fields,
    ['permissionReduction', 'workflowChange'],
    `both missing replace fields must be collected; saw ${JSON.stringify(fields)}`,
  );
  for (const e of gitErrors) {
    assert.match(e.message, /git/, 'each error message must name the tool');
    assert.match(e.message, new RegExp(e.field), 'each error message must name its field');
  }
});

// ────────────────────────────────────────────────────────────────────
// 2. keep MISSING keepReason (and/or requiredCapability) → validation
//    error naming the tool + field (R3.6)
// ────────────────────────────────────────────────────────────────────

test('a "keep" entry missing keepReason yields a validation error naming the tool and field (R3.6)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [
      // keep WITHOUT keepReason; requiredCapability present.
      { tool: 'bash', decision: 'keep', requiredCapability: 'external-command' },
    ],
  };

  const result = reconcileLedger(candidates, { ledger });

  const bashErrors = errorsForTool(result, 'bash');
  const reasonErr = bashErrors.find((e) => e.field === 'keepReason');
  assert.ok(reasonErr, `expected an error for the missing keepReason field; saw ${JSON.stringify(bashErrors)}`);
  assert.equal(reasonErr.tool, 'bash', 'error must name the tool');
  assert.match(reasonErr.message, /bash/, 'error message must include the tool name');
  assert.match(reasonErr.message, /keepReason/, 'error message must include the missing field name');
});

test('a "keep" entry missing BOTH required fields collects an error for each missing field (R3.6)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [{ tool: 'bash', decision: 'keep' }], // neither field present
  };

  const result = reconcileLedger(candidates, { ledger });

  const bashErrors = errorsForTool(result, 'bash');
  const fields = bashErrors.map((e) => e.field).sort();
  assert.deepEqual(
    fields,
    ['keepReason', 'requiredCapability'],
    `both missing keep fields must be collected; saw ${JSON.stringify(fields)}`,
  );
});

// ────────────────────────────────────────────────────────────────────
// 3. Valid replace + valid keep → reconciled with NO error (R3.4/3.5/3.6)
// ────────────────────────────────────────────────────────────────────

test('valid "replace" (both fields) and valid "keep" (both fields) reconcile with NO validation error (R3.4, R3.5, R3.6)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [
      {
        tool: 'git',
        decision: 'replace',
        permissionReduction: 'drop external-command:git from the profile',
        workflowChange: 'agents use git-mcp-server tools instead of bash git',
      },
      {
        tool: 'bash',
        decision: 'keep',
        keepReason: 'arbitrary build/test commands are unavoidable',
        requiredCapability: 'external-command',
      },
    ],
  };

  const result = reconcileLedger(candidates, { ledger });

  assert.deepEqual(result.errors, [], `valid entries must yield no errors; saw ${JSON.stringify(result.errors)}`);

  const git = reconciledOf(result, 'git');
  assert.ok(git, 'git must be reconciled');
  assert.equal(git.decision, 'replace', 'git decision must reconcile to replace');

  const bash = reconciledOf(result, 'bash');
  assert.ok(bash, 'bash must be reconciled');
  assert.equal(bash.decision, 'keep', 'bash decision must reconcile to keep');
});

// ────────────────────────────────────────────────────────────────────
// 4. defer / none entries reconcile with no required-field error (R3.4)
// ────────────────────────────────────────────────────────────────────

test('"defer" and "none" entries reconcile with no required-field error (R3.4)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [
      { tool: 'git', decision: 'defer' },
      { tool: 'bash', decision: 'none' },
    ],
  };

  const result = reconcileLedger(candidates, { ledger });

  assert.deepEqual(result.errors, [], `defer/none require no extra fields; saw ${JSON.stringify(result.errors)}`);

  const git = reconciledOf(result, 'git');
  assert.ok(git, 'git must be reconciled');
  assert.equal(git.decision, 'defer');

  const bash = reconciledOf(result, 'bash');
  assert.ok(bash, 'bash must be reconciled');
  assert.equal(bash.decision, 'none');
});

// ────────────────────────────────────────────────────────────────────
// 5. Candidates with NO ledger entry are echoed in `undecided`
//    (observable, R3.4)
// ────────────────────────────────────────────────────────────────────

test('candidates with no matching ledger entry are echoed in undecided (R3.4 observable)', () => {
  const candidates = sampleCandidates();
  const ledger = {
    entries: [
      {
        tool: 'git',
        decision: 'replace',
        permissionReduction: 'drop external-command:git',
        workflowChange: 'use git-mcp-server',
      },
    ],
  };

  const result = reconcileLedger(candidates, { ledger });

  assert.ok(Array.isArray(result.undecided), 'undecided must be an array');
  // bash and read have no ledger entry → both echoed; git is decided.
  assert.deepEqual(
    [...result.undecided].sort(),
    ['bash', 'read'],
    `undecided must echo exactly the candidates lacking a ledger entry; saw ${JSON.stringify(result.undecided)}`,
  );
  assert.ok(!result.undecided.includes('git'), 'a decided candidate must not be echoed as undecided');
});

// ────────────────────────────────────────────────────────────────────
// 6. Missing ledger file (via the path seam) → all candidates undecided,
//    NO error / NO throw
// ────────────────────────────────────────────────────────────────────

test('a missing ledger file (path seam) yields all candidates undecided and no error (no throw)', () => {
  const candidates = sampleCandidates();
  const nonexistent = path.join(
    os.tmpdir(),
    `opencode-nono-no-such-ledger-${process.pid}-${Date.now()}.json`,
  );
  // Guard: ensure the path really does not exist.
  assert.equal(fs.existsSync(nonexistent), false, 'precondition: ledger path must not exist');

  let result;
  assert.doesNotThrow(() => {
    result = reconcileLedger(candidates, { ledgerPath: nonexistent });
  }, 'a missing ledger file must not throw');

  assert.deepEqual(result.errors, [], 'a missing ledger file must yield no validation errors');
  assert.deepEqual(result.reconciled, [], 'a missing ledger file means nothing is decided');
  assert.deepEqual(
    [...result.undecided].sort(),
    ['bash', 'git', 'read'],
    `every candidate must be undecided when the ledger file is absent; saw ${JSON.stringify(result.undecided)}`,
  );
});

test('a present ledger file (path seam) is read and reconciled', () => {
  const candidates = sampleCandidates();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-ledger-'));
  const ledgerPath = path.join(dir, 'review-decisions.json');
  fs.writeFileSync(
    ledgerPath,
    JSON.stringify({
      entries: [
        {
          tool: 'git',
          decision: 'replace',
          permissionReduction: 'drop external-command:git',
          workflowChange: 'use git-mcp-server',
        },
      ],
    }),
    'utf8',
  );

  try {
    const result = reconcileLedger(candidates, { ledgerPath });
    assert.deepEqual(result.errors, [], 'a valid ledger file must yield no errors');
    const git = reconciledOf(result, 'git');
    assert.ok(git, 'git must reconcile from the ledger file');
    assert.equal(git.decision, 'replace');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ────────────────────────────────────────────────────────────────────
// 7. Advisory only (R3.7): returns advisory data, performs no
//    permission/MCP mutation and writes nothing (not even the ledger).
// ────────────────────────────────────────────────────────────────────

test('reconcileLedger is advisory only: it writes nothing and exposes no apply/mutate action (R3.7)', () => {
  const candidates = sampleCandidates();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-advisory-'));
  const ledgerPath = path.join(dir, 'review-decisions.json');
  const original = JSON.stringify({
    entries: [
      {
        tool: 'git',
        decision: 'replace',
        permissionReduction: 'drop external-command:git',
        workflowChange: 'use git-mcp-server',
      },
      { tool: 'bash', decision: 'keep' }, // intentionally invalid → error path
    ],
  });
  fs.writeFileSync(ledgerPath, original, 'utf8');

  try {
    const before = fs.readdirSync(dir).sort();
    const result = reconcileLedger(candidates, { ledgerPath });
    const after = fs.readdirSync(dir).sort();

    // The directory contents must be UNCHANGED (no report/marker/ledger write).
    assert.deepEqual(after, before, 'reconcileLedger must not create or remove any files');
    // The ledger file itself must be byte-for-byte unchanged (read-only).
    assert.equal(fs.readFileSync(ledgerPath, 'utf8'), original, 'the ledger file must not be modified');

    // The result is purely advisory data — reconciled/undecided/errors —
    // and exposes NO apply/mutate/commit affordance.
    assert.deepEqual(
      Object.keys(result).sort(),
      ['errors', 'reconciled', 'undecided'],
      `result must carry only advisory data; saw keys ${JSON.stringify(Object.keys(result))}`,
    );
    for (const k of ['apply', 'commit', 'mutate', 'write', 'enforce']) {
      assert.equal(typeof result[k], 'undefined', `result must expose no "${k}" action (advisory only)`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
