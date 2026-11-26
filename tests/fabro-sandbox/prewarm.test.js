'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

// Evaluate the guest's prewarm derivation together with the flake's locked
// input graph, so the assertions read the NixOS-evaluated wiring (the
// `system.extraDependencies` root and the derivation's `passthru.sources`)
// rather than the module source. `expected` recomputes the input-source walk
// independently from `builtins.getFlake`, which is what proves the guest
// threaded the full closure through `specialArgs` and did not drop transitive
// inputs that skip the root's nixpkgs.
function prewarm() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.config;
      matches = builtins.filter (p: (p.name or "") == "fabro-sandbox-flake-inputs")
        vm.system.extraDependencies;
      prewarm = builtins.head matches;
      src = p: builtins.unsafeDiscardStringContext p;
      walk = f: [ f.outPath ] ++ builtins.concatMap walk (builtins.attrValues (f.inputs or { }));
      sources = map src prewarm.passthru.sources;
      expected = map src (
        flake.inputs.nixpkgs.lib.unique (
          builtins.concatMap walk (builtins.attrValues (builtins.removeAttrs flake.inputs [ "self" ]))
        )
      );
    in
    {
      name = prewarm.name;
      matches = builtins.length matches;
      extraDependencyNames = map (p: p.name or "") vm.system.extraDependencies;
      sources = sources;
      expected = expected;
      buildCommand = prewarm.buildCommand;
      inputs = {
        nixpkgs = src flake.inputs.nixpkgs.outPath;
        darwin = src flake.inputs.darwin.outPath;
        homeManager = src flake.inputs.home-manager.outPath;
        nixosLima = src flake.inputs.nixos-lima.outPath;
        rustAnalyzer = src flake.inputs.fenix.inputs.rust-analyzer-src.outPath;
        globset = src flake.inputs.nix-snapshotter.inputs.globset.outPath;
        brewSrc = src flake.inputs.homebrew.inputs.brew-src.outPath;
      };
    }
  `);
}

test('the guest roots the flake-input prewarm in system.extraDependencies', () => {
  const image = prewarm();
  // `system.extraDependencies` is part of the system closure, so the system
  // profile GC root keeps the prewarmed sources alive across `nix.gc`; the
  // sandbox containers, which bind-mount the guest store, then resolve the
  // repository's locked inputs without GitHub.
  assert.equal(image.name, 'fabro-sandbox-flake-inputs');
  assert.equal(image.matches, 1, `expected exactly one prewarm derivation: ${JSON.stringify(image.extraDependencyNames)}`);
  assert.ok(image.extraDependencyNames.includes('fabro-sandbox-flake-inputs'));
});

test('the prewarm covers every locked flake input source', () => {
  const image = prewarm();
  assert.ok(image.sources.length > 0, 'the prewarm must carry input sources');
  assert.deepEqual(
    [...image.sources].sort(),
    [...image.expected].sort(),
    'the prewarm must root exactly the repository flake input closure',
  );
});

test('the prewarm includes transitive inputs that skip the root nixpkgs', () => {
  const { sources, inputs } = prewarm();
  // A non-recursive implementation (top-level inputs only) drops these, and
  // `nix flake check --no-build --offline` then fails evaluating the outputs
  // that consume them.
  for (const [name, path] of Object.entries(inputs)) {
    assert.ok(sources.includes(path), `prewarm must include the ${name} input source (${path})`);
  }
});

test('the manifest records every source so the output keeps the references', () => {
  const { sources, buildCommand } = prewarm();
  // The output file names each source path, which is what turns the
  // passthru list into runtime references of the prewarm output (and thus
  // into system-closure entries). A source missing here would survive in the
  // store only until the next GC.
  for (const source of sources) {
    assert.ok(
      buildCommand.includes(source),
      `the prewarm build command must list ${source}`,
    );
  }
  assert.match(buildCommand, /locked sources rooted in the guest store/);
  assert.match(buildCommand, /total apparent bytes:/);
});
