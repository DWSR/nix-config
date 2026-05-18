/*
  home-manager/common/opencode-cost-diagnosis.nix — install pipeline
  for the opencode session cost-attribution diagnostic (Tasks 1.5 +
  6.3 of the `opencode-cost-diagnosis` spec; Requirements 1.1, 1.2,
  1.3, 5.1, 5.2).

  This module is the milestone where `darwin-rebuild switch` lands
  working binaries on PATH on both nix-darwin hosts. Subsequent tasks
  flesh out the diagnostic's logic; this module's sole job is the
  wiring contract:

    1. Production CLI (Task 1.3 — `scripts/opencode-cost-report.nix`)
       built via `pkgs.callPackage` and surfaced as
       `programs.opencode-cost-diagnosis.package` (read-only) for
       downstream consumers that need the absolute store path.

    2. Generic test/dev Node wrapper (Task 1.4 —
       `scripts/opencode-cost-diagnosis-node.nix`) installed on PATH
       alongside the production CLI so the fixture creator (Task 1.6)
       and the test runner (Tasks 6.1, 6.2) can `require()` the
       vendored `better-sqlite3` and `tiktoken` deps without
       resolving store paths by hand.

    3. Post-`nix flake update` smoke test (Task 6.3 —
       `scripts/opencode-cost-diagnosis-smoke-test.nix`) installed on
       PATH so the operator can revalidate the install pipeline +
       schema-baseline pin after any opencode bump. Mirrors the
       `cavememSmokeTest` precedent in `home-manager/common/cavemem.nix`.

  Peer dependency: this module asserts at HM-evaluation time that
  `programs.opencode.enable` is true on the same host. The opencode
  diagnostic reads opencode's own SQLite database (located via
  XDG_DATA_HOME by Task 2.1) and that database is populated only when
  opencode itself is installed and run by the HM-managed opencode
  wrapper. Without `programs.opencode.enable = true;` the diagnostic
  would silently produce empty reports on a fresh machine; the
  assertion fails the build instead and names the missing peer so the
  operator's fix is obvious. Mirrors the same assertion shape used by
  `home-manager/common/memory-sync.nix`.

  Both wrappers and the future smoke-test derivation reach
  `pkgs.opencode-cost-diagnosis-deps` (Task 1.2, defined in
  `overlays/mcp-servers.nix`) transparently via callPackage's
  auto-resolution — they are not parameterised here.
*/
{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-cost-diagnosis;

  # Production CLI wrapper (Task 1.3). Surfaced through
  # `programs.opencode-cost-diagnosis.package` so downstream consumers
  # (e.g. the smoke-test from 6.3, future launchd integration, or
  # ad-hoc operator scripts) can resolve the binary by absolute store
  # path without re-evaluating callPackage themselves.
  opencode-cost-report = pkgs.callPackage ../../scripts/opencode-cost-report.nix { };

  # Generic Node dev/test wrapper (Task 1.4). Installed alongside the
  # production CLI so the fixture creator (Task 1.6) and the test
  # runner (Tasks 6.1, 6.2) inherit the same NODE_PATH wiring without
  # the operator having to know the deps tree's store path.
  opencode-cost-diagnosis-node = pkgs.callPackage ../../scripts/opencode-cost-diagnosis-node.nix { };

  # Post-`nix flake update` smoke-test (Task 6.3). Runs four
  # fail-fast checks against the live opencode DB at
  # `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-stable.db`:
  # (a) DB exists and is readable, (b) data_migration set matches
  # the pinned baseline, (c) opencode-cost-report is on PATH, (d)
  # `opencode-cost-report --supported-opencode-version` output
  # contains the expected version range. Exits 0 silently on
  # success; on any failure prints
  # `[smoke-test-failure: <label>] <detail>` to stderr and exits
  # non-zero. Same shape as the `cavememSmokeTest` precedent.
  opencode-cost-diagnosis-smoke-test =
    pkgs.callPackage ../../scripts/opencode-cost-diagnosis-smoke-test.nix
      { };
in
{
  options.programs.opencode-cost-diagnosis = {
    enable = lib.mkEnableOption ''
      opencode session cost-attribution diagnostic: installs the
      `opencode-cost-report` CLI for inspecting opencode session
      token usage and cost, plus the generic
      `opencode-cost-diagnosis-node` dev/test wrapper used by the
      fixture creator and the test suite, plus the
      `opencode-cost-diagnosis-smoke-test` runtime verifier the
      operator runs after `nix flake update` / `darwin-rebuild
      switch` to confirm the install pipeline and schema-baseline
      pin are still in sync with the live opencode DB.

      Requires programs.opencode.enable = true on the same host; the
      assertion below enforces this at HM evaluation time.
    '';

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = opencode-cost-report;
      description = ''
        The built `opencode-cost-report` production-CLI derivation.
        Read-only; surfaces the derivation to downstream consumers
        (e.g. the smoke-test from Task 6.3) that need to resolve the
        binary by absolute store path.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    # Three binaries on PATH: production CLI, generic Node dev
    # wrapper, and the post-`nix flake update` smoke test. Order is
    # cosmetic — each is independently usable.
    home.packages = [
      cfg.package
      opencode-cost-diagnosis-node
      opencode-cost-diagnosis-smoke-test
    ];

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.opencode-cost-diagnosis.enable requires programs.opencode.enable.

          The opencode-cost-report diagnostic reads opencode's own
          SQLite database to attribute session token usage and cost.
          Without programs.opencode.enable = true, opencode itself is
          not installed on this host, the database does not exist,
          and the diagnostic would produce empty reports.

          To fix: set programs.opencode.enable = true; alongside
          programs.opencode-cost-diagnosis.enable = true; in the same
          home-manager configuration.
        '';
      }
    ];
  };
}
