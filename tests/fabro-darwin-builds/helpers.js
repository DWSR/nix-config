'use strict';

// Shared Nix evaluation helpers for the fabro-darwin-builds suite
// (mac-builder-for-fabro-nix-darwin-builds, task 5.2).
//
// Mirrors tests/mac-nix-remote-builder/helpers.js so every eval-based check in
// this suite evaluates the real flake with the same timeout, cwd, and failure
// reporting instead of growing a private copy.

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
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
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
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
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
