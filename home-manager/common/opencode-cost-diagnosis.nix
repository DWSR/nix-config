/*
  home-manager/common/opencode-cost-diagnosis.nix — install pipeline
  for the opencode session cost-attribution diagnostic (Task 1.5 of
  the `opencode-cost-diagnosis` spec; Requirements 1.1, 1.2, 1.3).

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

    3. Smoke-test derivation (Task 6.3 — to be appended to
       `home.packages` when that task lands) will become a third
       entry in the same list. The shape of this module is
       deliberately the same as `home-manager/common/cavemem.nix`'s
       `cavememSmokeTest` precedent for that reason.

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
in
{
  options.programs.opencode-cost-diagnosis = {
    enable = lib.mkEnableOption ''
      opencode session cost-attribution diagnostic: installs the
      `opencode-cost-report` CLI for inspecting opencode session
      token usage and cost, plus the generic
      `opencode-cost-diagnosis-node` dev/test wrapper used by the
      fixture creator and the test suite.

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
    # Both wrappers shipped on PATH. The smoke-test derivation from
    # Task 6.3 will become a third entry in this list when that task
    # lands.
    home.packages = [
      cfg.package
      opencode-cost-diagnosis-node
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
