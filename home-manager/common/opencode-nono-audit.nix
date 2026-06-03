/*
  home-manager/common/opencode-nono-audit.nix — install pipeline for the
  opencode-nono-audit CLI (opencode-nono-audit spec, Task 1.2;
  Requirement 1.1).

  Thin module mirroring `home-manager/common/opencode-cost-diagnosis.nix`:
  builds the production wrapper (Task 1.2 — `scripts/opencode-nono-audit.nix`)
  via `pkgs.callPackage`, surfaces it through
  `programs.opencode-nono-audit.package` (read-only) for downstream
  consumers that need the absolute store path, and installs it on PATH.

  Peer dependency: asserts at HM-evaluation time that
  `programs.opencode.enable` is true on the same host. The audit CLI
  reads opencode's own SQLite session database (located via XDG_DATA_HOME
  or OPENCODE_DB_PATH); that database is populated only when opencode
  itself is installed and run by the HM-managed opencode wrapper. Without
  the peer the audit would silently produce empty inventories on a fresh
  machine; the assertion fails the build and names the missing peer
  instead. Mirrors the assertion shape in
  `home-manager/common/opencode-cost-diagnosis.nix`.

  The wrapper reaches `pkgs.opencode-cost-diagnosis-deps` (defined in
  `overlays/mcp-servers.nix`) transparently via callPackage's
  auto-resolution — it is not parameterised here.
*/
{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-nono-audit;

  # Production CLI wrapper (Task 1.2). Surfaced through
  # `programs.opencode-nono-audit.package` so downstream consumers can
  # resolve the binary by absolute store path without re-evaluating
  # callPackage themselves.
  opencode-nono-audit = pkgs.callPackage ../../scripts/opencode-nono-audit.nix { };
in
{
  options.programs.opencode-nono-audit = {
    enable = lib.mkEnableOption ''
      opencode-nono-audit: a read-only CLI that audits historical
      OpenCode tool usage, assesses it against the managed nono
      profiles, and emits a ranked tool-use list with advisory
      MCP-replacement decisions. Never mutates any source and never
      changes OpenCode permissions or MCP registrations.

      Requires programs.opencode.enable = true on the same host; the
      assertion below enforces this at HM evaluation time.
    '';

    package = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = opencode-nono-audit;
      description = ''
        The built `opencode-nono-audit` CLI derivation. Read-only;
        surfaces the derivation to downstream consumers that need to
        resolve the binary by absolute store path.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.opencode-nono-audit.enable requires programs.opencode.enable.

          The opencode-nono-audit CLI reads opencode's own SQLite
          session database to build a read-only tool-usage inventory.
          Without programs.opencode.enable = true, opencode itself is
          not installed on this host, the database does not exist, and
          the audit would produce empty inventories.

          To fix: set programs.opencode.enable = true; alongside
          programs.opencode-nono-audit.enable = true; in the same
          home-manager configuration.
        '';
      }
    ];
  };
}
