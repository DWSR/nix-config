'use strict';

/*
 * helpers.js — shared harness for the hammerspoon-keybindings renderer +
 * syntax-gate tests (Task 8.2, _Boundary: Verification_).
 *
 * Mirrors tests/personal-tailscale-service/helpers.js: thin wrappers over
 * `nix eval --impure` driving the LOCAL flake via
 * `builtins.getFlake (toString <repoRoot>)`. The renderer is imported pure —
 * `import <repoRoot>/home-manager/common/hammerspoon-keybindings/render.nix
 * { lib = flake.inputs.nixpkgs.lib; } <fixture>` — so every assertion runs
 * host-free (no darwinConfigurations, no Hammerspoon app, no Accessibility;
 * Req 4.4). `luacParse` exercises the same `luac -p` mechanism the delivery
 * gate (checked-config.nix) uses (Req 5.1, 5.3).
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

const NIX_EVAL_TIMEOUT_MS = 120_000;
const NIX_EVAL_MAX_BUFFER = 64 * 1024 * 1024;

function nixEvalJson(expr, options = {}) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? NIX_EVAL_TIMEOUT_MS,
      maxBuffer: NIX_EVAL_MAX_BUFFER,
    },
  ));
}

function nixEvalRaw(expr, options = {}) {
  return childProcess.execFileSync(
    'nix',
    ['eval', '--raw', '--impure', '--expr', expr],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? NIX_EVAL_TIMEOUT_MS,
      maxBuffer: NIX_EVAL_MAX_BUFFER,
    },
  );
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
        timeout: options.timeout ?? NIX_EVAL_TIMEOUT_MS,
        maxBuffer: NIX_EVAL_MAX_BUFFER,
      },
    );
  } catch (error) {
    return String(error.stderr ?? error.message);
  }

  throw new Error('expected nix eval to fail, but it succeeded');
}

// Nix expression that imports the pure renderer with nixpkgs `lib` and applies
// it to one fixture from fixtures.nix. Forcing the resulting string forces the
// renderer's `lib.seq validated` guard, so a malformed fixture surfaces the
// renderer's `throw` (Req 4.3) rather than a stale value.
function renderExpr(fixtureName) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      lib = flake.inputs.nixpkgs.lib;
      fixtures = import ${repoRoot}/tests/hammerspoon-keybindings/fixtures.nix;
      render = import ${repoRoot}/home-manager/common/hammerspoon-keybindings/render.nix { inherit lib; };
    in
    render fixtures.${fixtureName}
  `;
}

// Write Lua to a throwaway file and parse-check it with `luac -p` (the exact
// gate checked-config.nix runs). Returns the exit status + captured streams;
// never throws on a non-zero exit so callers can assert pass (5.1) or fail
// (5.3). Uses os.tmpdir() (no hardcoded temp-dir path literal).
function luacParse(luaSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-kb-luac-'));
  try {
    const file = path.join(dir, 'init.lua');
    fs.writeFileSync(file, luaSource);
    const result = childProcess.spawnSync('luac', ['-p', file], { encoding: 'utf8' });
    return {
      status: result.status,
      signal: result.signal,
      error: result.error,
      stderr: String(result.stderr ?? ''),
      stdout: String(result.stdout ?? ''),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  luacParse,
  nixEvalFailure,
  nixEvalJson,
  nixEvalRaw,
  renderExpr,
  repoRoot,
};
