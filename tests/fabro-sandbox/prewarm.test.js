'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const walkPath = path.join(repoRoot, 'scripts/fabro-flake-inputs.nix');
const prewarmPath = path.join(repoRoot, 'scripts/fabro-sandbox-prewarm.nix');

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

// Evaluate the guest through the flake. Only the list length is forced:
// `system.extraDependencies` is typed `listOf pathInStore`, so touching an
// element coerces the prewarm derivation (and its whole build command) into a
// store path, re-fetching the locked closure (~1.8 GiB) inside the build
// sandbox. The walk itself is covered against a fixture graph below, and the
// module wiring is read from source.
function guest() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.config;
    in
    {
      extraDependenciesCount = builtins.length vm.system.extraDependencies;
    }
  `);
}

function source(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

// Evaluate the recursive walk against a small input graph: a direct input, a
// transitive input that does not follow one of the root's inputs, two inputs
// that resolve to the same source, and `self` (which must be skipped).
function walk() {
  return nixEvalJson(`
    let
      fixture = {
        self = { outPath = "/fixture/self"; inputs = { }; };
        nixpkgs = { outPath = "/fixture/nixpkgs"; inputs = { }; };
        fenix = {
          outPath = "/fixture/fenix";
          inputs = {
            nixpkgs = { outPath = "/fixture/nixpkgs"; inputs = { }; };
            rust-analyzer-src = { outPath = "/fixture/rust-analyzer-src"; inputs = { }; };
          };
        };
        nix-snapshotter = {
          outPath = "/fixture/nix-snapshotter";
          inputs = { globset = { outPath = "/fixture/globset"; inputs = { }; }; };
        };
      };
      walk = import ${walkPath};
    in
    walk { inputs = builtins.removeAttrs fixture [ "self" ]; }
  `);
}

// Evaluate the manifest derivation against fixture sources. The stub stands in
// for nixpkgs so the assertion logic stays testable without importing it; the
// real wiring is covered by the guest check.
function manifest(sources) {
  return nixEvalJson(`
    let
      lib = {
        length = builtins.length;
        escapeShellArgs = args: builtins.concatStringsSep " " args;
      };
      pkgs = {
        runCommand = name: env: text: {
          inherit name text;
          passthru = env.passthru or { };
        };
      };
    in
    import ${prewarmPath} {
      inherit lib pkgs;
      sources = [ ${sources.map((source) => JSON.stringify(source)).join(' ')} ];
    }
  `);
}

test('the guest roots the flake-input prewarm in system.extraDependencies', () => {
  // `system.extraDependencies` is part of the system closure, so the system
  // profile GC root keeps the prewarmed sources alive across `nix.gc`; the
  // sandbox containers, which bind-mount the guest store, then resolve the
  // repository's locked inputs without GitHub.
  assert.equal(guest().extraDependenciesCount, 1);

  const sandbox = source('configurations/fabro-vm/sandbox.nix');
  assert.match(sandbox, /prewarmFlakeInputs = import \.\.\/\.\.\/scripts\/fabro-sandbox-prewarm\.nix/);
  assert.match(sandbox, /sources = flakeInputSources;/);
  assert.match(sandbox, /system\.extraDependencies = \[ prewarmFlakeInputs \];/);
});

test('the flake threads the recursive input walk to the guest', () => {
  const flake = source('flake.nix');
  assert.match(flake, /flakeInputSources = \(import \.\/scripts\/fabro-flake-inputs\.nix\) \{/);
  assert.match(flake, /inputs = builtins\.removeAttrs inputs \[ "self" \];/);
  assert.match(flake, /inherit flakeInputSources;/);
});

test('the walk covers transitive inputs that skip the root nixpkgs', () => {
  const sources = walk();
  // A non-recursive implementation (top-level inputs only) drops these, and
  // `nix flake check --no-build --offline` then fails evaluating the outputs
  // that consume them.
  for (const expected of [
    '/fixture/nixpkgs',
    '/fixture/fenix',
    '/fixture/nix-snapshotter',
    '/fixture/rust-analyzer-src',
    '/fixture/globset',
  ]) {
    assert.ok(sources.includes(expected), `walk must include ${expected}: ${JSON.stringify(sources)}`);
  }
});

test('the walk skips self and de-duplicates shared sources', () => {
  const sources = walk();
  assert.ok(!sources.includes('/fixture/self'), 'the root self input must not be prewarmed');
  assert.equal(
    sources.filter((source) => source === '/fixture/nixpkgs').length,
    1,
    `shared sources must appear once: ${JSON.stringify(sources)}`,
  );
});

test('the manifest records every source so the output keeps the references', () => {
  const sources = ['/fixture/nixpkgs', '/fixture/rust-analyzer-src'];
  const prewarm = manifest(sources);
  // The output file names each source path, which is what turns the passthru
  // list into runtime references of the prewarm output (and thus into
  // system-closure entries). A source missing here would survive in the store
  // only until the next GC.
  assert.equal(prewarm.name, 'fabro-sandbox-flake-inputs');
  assert.deepEqual(prewarm.passthru.sources, sources);
  for (const source of sources) {
    assert.ok(
      prewarm.text.includes(source),
      `the prewarm build command must list ${source}`,
    );
  }
  assert.match(prewarm.text, /2 locked sources rooted in the guest store/);
  assert.match(prewarm.text, /total apparent bytes:/);
});
