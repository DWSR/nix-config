'use strict';

/*
 * runbook.test.js — Task 7.1 operator runbook coverage.
 *
 * Verifies the runbook documents the full audit, validation, and
 * rollback flow without requiring operators to read design internals
 * (Requirements 4.5, 5.1, 5.2, 5.4, 5.5, 7.4, 7.5).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RUNBOOK_PATH = path.join(
  __dirname,
  '../../../.kiro/specs/subagent-context-budget/runbook.md',
);

function readRunbook() {
  assert.ok(fs.existsSync(RUNBOOK_PATH), 'runbook.md must exist');
  return fs.readFileSync(RUNBOOK_PATH, 'utf8');
}

function assertOrdered(runbook, earlier, later) {
  const earlierIndex = runbook.indexOf(earlier);
  const laterIndex = runbook.indexOf(later);
  assert.notEqual(earlierIndex, -1, `runbook must include ${earlier}`);
  assert.notEqual(laterIndex, -1, `runbook must include ${later}`);
  assert.ok(earlierIndex < laterIndex, `${earlier} must appear before ${later}`);
}

function assertOrderedAfter(runbook, anchor, earlier, later) {
  const anchorIndex = runbook.indexOf(anchor);
  assert.notEqual(anchorIndex, -1, `runbook must include ${anchor}`);
  const scoped = runbook.slice(anchorIndex);
  assertOrdered(scoped, earlier, later);
}

function fencedCommandBlocks(runbook) {
  return Array.from(runbook.matchAll(/```(?:sh|nix)\n([\s\S]*?)```/g), (match) => match[1]);
}

test('operator runbook exists and covers the full validation workflow', () => {
  const runbook = readRunbook();
  const lower = runbook.toLowerCase();

  const requiredPhrases = [
    'baseline capture',
    'enable budgets',
    'smoke preflight',
    'post-change capture',
    'validation',
    'residual interpretation',
    'rollback',
    'escape hatch',
    'migration phases',
  ];

  for (const phrase of requiredPhrases) {
    assert.ok(lower.includes(phrase), `runbook must include ${phrase}`);
  }
});

test('operator runbook includes required command surface and escape hatches', () => {
  const runbook = readRunbook();

  const requiredSnippets = [
    'opencode-cost-report',
    'opencode-cost-report --format json',
    'darwin-rebuild switch --flake',
    'subagent-context-budget audit',
    'subagent-context-budget validate',
    'subagent-context-budget smoke-plan',
    'subagent-context-budget-smoke-test',
    'disableBudget = true',
    'enforce = false',
  ];

  for (const snippet of requiredSnippets) {
    assert.ok(runbook.includes(snippet), `runbook must include ${snippet}`);
  }
});

test('operator runbook command blocks contain no ellipsis, TODO, or angle-placeholder commands', () => {
  const runbook = readRunbook();
  const commandBlocks = fencedCommandBlocks(runbook).join('\n');

  assert.doesNotMatch(runbook, /\.\.\./, 'runbook must not contain ellipsis placeholders');
  assert.doesNotMatch(runbook, /TODO/i, 'runbook must not contain TODO placeholders');
  assert.doesNotMatch(commandBlocks, /<[^>]+>/, 'command blocks must not contain <...> placeholders');
});

test('operator runbook commands are ordered as the full validation workflow', () => {
  const runbook = readRunbook();

  assertOrdered(runbook, 'opencode-cost-report --format json > "$BASELINE_REPORT"', 'subagent-context-budget audit');
  assertOrdered(runbook, 'programs.subagent-context-budget.enforce = true;', 'darwin-rebuild switch --flake');
  assertOrdered(runbook, 'darwin-rebuild switch --flake', 'subagent-context-budget-smoke-test');
  assertOrderedAfter(
    runbook,
    '## Smoke preflight',
    'subagent-context-budget-smoke-test',
    'subagent-context-budget smoke-plan',
  );
  assertOrdered(runbook, 'opencode-cost-report --format json > "$POST_REPORT"', 'subagent-context-budget validate');
  assertOrderedAfter(
    runbook,
    '## Rollback / escape hatch',
    'programs.subagent-context-budget.agents.general.disableBudget = true;',
    'darwin-rebuild switch --flake ".#$HOST"',
  );
});
