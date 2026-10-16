'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const checkPath = path.join(repoRoot, 'scripts/fabro-sandbox-pinned.nix');
const realLock = path.join(repoRoot, 'flake.lock');
const unpinnedLock = path.join(__dirname, 'fixtures/flake.lock.unpinned');
const missingLock = path.join(__dirname, 'fixtures/flake.lock.missing');

// Evaluate the pinned-input check against `lockFile`. The check only needs
// `lib.assertMsg` and `runCommand`, so a minimal stub keeps the assertion
// logic testable without importing nixpkgs or building a derivation; the real
// `pkgs` wiring is covered by checks.<system>.fabro-sandbox-pinned itself.
function evalCheck(lockFile) {
  const expr = `
    let
      lib = { assertMsg = cond: msg: if cond then true else throw msg; };
      pkgs = { inherit lib; runCommand = name: env: text: { inherit name env text; }; };
    in
    import ${checkPath} { inherit pkgs; lockFile = ${lockFile}; }
  `;
  return childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  );
}

function evalCheckFailure(lockFile) {
  try {
    evalCheck(lockFile);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }

  throw new Error('expected the pinned-input check to fail, but it evaluated');
}

test('the real flake.lock pins the nix-snapshotter input', () => {
  const rendered = JSON.parse(evalCheck(realLock));
  assert.equal(rendered.name, 'fabro-sandbox-pinned');
  assert.match(rendered.env.rev, /^[0-9a-f]{40}$/);
  assert.match(rendered.env.narHash, /^sha256-/);
});

test('an unpinned nix-snapshotter node fails the check with a named message', () => {
  const failure = evalCheckFailure(unpinnedLock);
  assert.match(
    failure,
    /fabro-sandbox-pinned: the 'nix-snapshotter' flake\.lock node is unpinned/,
  );
});

test('a missing nix-snapshotter node fails the check with a named message', () => {
  const failure = evalCheckFailure(missingLock);
  assert.match(
    failure,
    /fabro-sandbox-pinned: flake\.lock has no 'nix-snapshotter' node/,
  );
});
