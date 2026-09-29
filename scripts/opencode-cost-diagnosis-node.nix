/*
  scripts/opencode-cost-diagnosis-node.nix — generic Node dev/test
  wrapper for the opencode-cost-diagnosis spec (Task 1.4; Requirement
  1.4).

  Unlike `scripts/opencode-cost-report.nix` (Task 1.3), which binds a
  specific JS entry point and is the production CLI, this wrapper
  binds no script: it simply exports `NODE_PATH` against the vendored
  deps tree from Task 1.2 (`pkgs.opencode-cost-diagnosis-deps`,
  defined in `overlays/mcp-servers.nix`) and execs `node` with
  whatever arguments the caller passes.

  Consumers (per tasks.md):

  - Task 1.6 — fixture creator script invoked as
    `opencode-cost-diagnosis-node tests/fixtures/create.js …`
  - Task 6.1 / 6.2 — test runner invoked as
    `opencode-cost-diagnosis-node --test tests/*.test.js`
  - Ad-hoc verification:
    `opencode-cost-diagnosis-node -e 'require("better-sqlite3");
    require("tiktoken"); console.log("ok")'`

  This is a developer/verification tool, NOT an end-user CLI. It is
   shipped on PATH alongside the production wrapper so the deps tree is
  trivially exercisable from any shell without having to know the
  store path of `opencode-cost-diagnosis-deps`.

  NODE_PATH wiring matches the sibling wrapper: the deps derivation
  produces a flat `${out}/lib/node_modules/` layout (see overlay's
  `installPhase`) specifically so a single NODE_PATH export resolves
  every dependency the diagnostic and its tests need
  (`better-sqlite3`, `tiktoken`, and any transitive resolutions).
*/
{
  writeShellApplication,
  nodejs_22,
  opencode-cost-diagnosis-deps,
}:
writeShellApplication {
  name = "opencode-cost-diagnosis-node";
  runtimeInputs = [ nodejs_22 ];
  text = ''
    # Resolve `require('better-sqlite3')` and `require('tiktoken')`
    # (and any transitive deps) against the vendored tree from Task
    # 1.2. The deps derivation flattens to $out/lib/node_modules/ so
    # this single export is sufficient.
    export NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules

    exec ${nodejs_22}/bin/node "$@"
  '';
}
