'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = process.env.FABRO_DARWIN_BUILDS_SOURCE ?? path.resolve(__dirname, '../..');
const nixEnv = { ...process.env, NIX_CONFIG: 'experimental-features = nix-command flakes' };

function nixEvalJson(expr, options = {}) {
  const repo = options.cwd ?? repoRoot;
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? 120_000,
      env: { ...nixEnv, NIX_CONFIG: 'experimental-features = nix-command flakes' },
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
        env: { ...nixEnv, NIX_CONFIG: 'experimental-features = nix-command flakes' },
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
