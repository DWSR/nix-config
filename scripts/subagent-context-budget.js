#!/usr/bin/env node
/*
 * subagent-context-budget.js — BudgetCLI entry point.
 *
 * Task 1.2 owns only CLI and test-runner scaffolding. The audit,
 * validate, and smoke-plan commands intentionally return deterministic
 * placeholders until later tasks add report parsing and comparison.
 */
'use strict';

const COMMANDS = Object.freeze(['audit', 'validate', 'smoke-plan']);

function usage() {
  return [
    'Usage: subagent-context-budget <command> [options]',
    '',
    'Commands:',
    '  audit        Placeholder for budget metadata and diagnostic audit reports',
    '  validate     Placeholder for baseline/post diagnostic validation reports',
    '  smoke-plan   Placeholder for agent smoke-plan report generation',
    '',
    'Options:',
    '  --metadata <path>        Rendered budget metadata JSON',
    '  --diagnostic <path>      Diagnostic report JSON for audit',
    '  --baseline <path>        Baseline diagnostic report JSON for validate',
    '  --post <path>            Post-change diagnostic report JSON for validate',
    '  --format <json|markdown> Output format; JSON is the default',
    '  --help, -h               Show this help text',
    '',
  ].join('\n');
}

function placeholderReport(command) {
  return {
    schemaVersion: 1,
    command,
    status: 'placeholder',
    next: [],
  };
}

function writeStdout(text) {
  process.stdout.write(text);
}

function writeStderr(text) {
  process.stderr.write(text);
}

function main(argv) {
  const args = Array.isArray(argv) ? argv : [];
  const command = args[0];

  if (command === undefined || command === '--help' || command === '-h') {
    writeStdout(usage());
    return 0;
  }

  if (!COMMANDS.includes(command)) {
    writeStderr(`unknown command: ${command}\n\n${usage()}`);
    return 1;
  }

  writeStdout(`${JSON.stringify(placeholderReport(command), null, 2)}\n`);
  return 0;
}

module.exports = {
  COMMANDS,
  main,
  placeholderReport,
  usage,
};

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}
