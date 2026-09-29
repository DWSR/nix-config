/*
  scripts/opencode-cost-report.nix — wrapper for the opencode session
  cost-attribution diagnostic CLI (Task 1.3 of the
  opencode-cost-diagnosis spec; Requirement 1; extended in Task 1.3 of
  the v2-diagnosis spec to wire the bundled pricing JSON via
  OPENCODE_COST_PRICING_PATH per Requirements 3.1 and 3.5).

   A `writeShellApplication` pins the Node runtime via
  `runtimeInputs`, points `NODE_PATH` at the vendored deps tree
  produced by `pkgs.opencode-cost-diagnosis-deps` (Task 1.2, defined
  in `overlays/mcp-servers.nix`), and execs Node against the
  diagnostic's JS entry point.

   No per-host parameterisation: the diagnostic discovers opencode's
   session DB location at runtime via
  flags / defaults, so the wrapper takes no host-specific arguments.
  Consequently the HM module (Task 6.x) will invoke this derivation
  via `pkgs.callPackage ./scripts/opencode-cost-report.nix { }` with
  an empty override set.

  NODE_PATH wiring:

  - `opencode-cost-diagnosis-deps` ships a flat `node_modules/` tree
    at `${out}/lib/node_modules/` (see overlay's `installPhase` which
    deliberately flattens the standard `buildNpmPackage` layout for
    exactly this NODE_PATH-based consumption pattern). Setting
    NODE_PATH at this point lets the stub script — and the
    subsequent-task implementations that replace it — `require()`
    `better-sqlite3` and `tiktoken` without living inside a node
    project.
*/
{
  writeShellApplication,
  nodejs_22,
  opencode-cost-diagnosis-deps,
}:
writeShellApplication {
  name = "opencode-cost-report";
  runtimeInputs = [ nodejs_22 ];
  text = ''
    # Resolve `require('better-sqlite3')` and `require('tiktoken')`
    # against the vendored deps tree from Task 1.2. The deps
    # derivation produces a flat $out/lib/node_modules/ layout
    # specifically for this kind of NODE_PATH-based consumption.
    export NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules

    # Pass the build-time store path of the bundled pricing JSON to
    # the runtime via env var. `PricingTable` (v2-diagnosis Task 2.1)
    # reads $OPENCODE_COST_PRICING_PATH and loads rates from it; the
    # path is captured at build time via Nix path interpolation so
    # the runtime sees an immutable /nix/store/... path (Requirements
    # 3.1, 3.5).
    export OPENCODE_COST_PRICING_PATH=${./opencode-cost-report-pricing.json}

    exec ${nodejs_22}/bin/node ${./opencode-cost-report.js} "$@"
  '';
}
