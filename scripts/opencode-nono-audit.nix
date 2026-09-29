/*
  scripts/opencode-nono-audit.nix — wrapper for the opencode-nono-audit
  CLI (opencode-nono-audit spec, Task 1.2; Requirement 1.1).

  Shape mirrors `scripts/opencode-cost-report.nix`: a
  `writeShellApplication` that pins the Node runtime via `runtimeInputs`,
  points `NODE_PATH` at the vendored deps tree produced by
  `pkgs.opencode-cost-diagnosis-deps` (defined in
  `overlays/mcp-servers.nix`), and execs Node against the audit CLI's JS
  entry point.

  Two env vars are injected:

  - `NODE_PATH` resolves `require('better-sqlite3')` against the flat
    `${out}/lib/node_modules/` layout the deps derivation produces —
    the audit CLI reuses opencode-cost-diagnosis's vendored deps tree
    read-only rather than vendoring its own.

  - `OPENCODE_NONO_COST_REPORT_LIB` is the build-time store path of the
    sibling `opencode-cost-report.js`. The audit CLI does
    `require(process.env.OPENCODE_NONO_COST_REPORT_LIB)` to reuse the
    `SqliteReader` export (design.md "Allowed Dependencies" / the Usage
    Audit CLI "Implementation Notes"). Capturing it as a Nix path means
    the runtime sees an immutable /nix/store/... path.

  No per-host parameterisation: the CLI discovers the session DB
  location at runtime via flags / XDG defaults, so the HM module invokes
  this via `pkgs.callPackage ./scripts/opencode-nono-audit.nix { }` with
  an empty override set.
*/
{
  writeShellApplication,
  nodejs_22,
  opencode-cost-diagnosis-deps,
}:
writeShellApplication {
  name = "opencode-nono-audit";
  runtimeInputs = [ nodejs_22 ];
  text = ''
    # Resolve `require('better-sqlite3')` against the vendored deps
    # tree. The deps derivation produces a flat $out/lib/node_modules/
    # layout specifically for this NODE_PATH-based consumption.
    export NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules

    # Build-time store path of the sibling cost-report library. The
    # audit CLI requires this for the SqliteReader export (read-only
    # reuse of opencode-cost-diagnosis).
    export OPENCODE_NONO_COST_REPORT_LIB=${./opencode-cost-report.js}

    exec ${nodejs_22}/bin/node ${./opencode-nono-audit.js} "$@"
  '';
}
