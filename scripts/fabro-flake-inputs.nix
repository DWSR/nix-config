# Recursive source walk for the fabro sandbox flake-input prewarm (issue
# #374). Walks the whole input graph, not just the root's direct inputs, so
# transitive inputs that are not followed into one of the root's inputs are
# included too (fenix's rust-analyzer-src, nix-snapshotter's globset,
# homebrew's brew-src, ...). The fabro guest roots this closure in its store
# (configurations/fabro-vm/sandbox.nix) so sandbox containers, which bind-mount
# the guest `/nix/store`, resolve `nix flake metadata` / `nix flake check
# --no-build` inputs offline instead of re-fetching the pinned archives from
# GitHub.
#
# `inputs` is the flake's root `inputs` attrset (minus `self`). Kept as a
# standalone function so tests/fabro-sandbox/prewarm.test.js can exercise the
# walk against a fixture graph without evaluating the repository flake (which
# would fetch every locked source inside the test build).
{ inputs }:
let
  walk =
    flake: [ flake.outPath ] ++ builtins.concatMap walk (builtins.attrValues (flake.inputs or { }));
  all = builtins.concatMap walk (builtins.attrValues inputs);
in
builtins.foldl' (seen: path: if builtins.elem path seen then seen else seen ++ [ path ]) [ ] all
