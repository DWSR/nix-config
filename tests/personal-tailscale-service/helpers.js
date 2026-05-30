'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function nixEvalJson(expr, options = {}) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 120_000,
    },
  ));
}

function nixEvalFailure(expr, options = {}) {
  try {
    childProcess.execFileSync(
      'nix',
      ['eval', '--json', '--impure', '--expr', expr],
      {
        cwd: options.cwd ?? repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout ?? 120_000,
      },
    );
  } catch (error) {
    return String(error.stderr ?? error.message);
  }

  throw new Error('expected nix eval to fail, but it succeeded');
}

module.exports = {
  nixEvalFailure,
  nixEvalJson,
  repoRoot,
};
