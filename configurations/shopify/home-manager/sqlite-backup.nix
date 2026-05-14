{ config, ... }:
{
  # Per-host wiring for the SQLite Backup module. The module is enabled
  # with the gdrive destination declared and the cavemem database wired
  # against it; per the existing requirements (Req 1.AC4) adding a
  # database entry creates the runtime pipeline for that database
  # without requiring any other change.
  #
  # Cavemem is the first real database wired into this module on
  # Shopify. The cavemem-integration roadmap's "Existing Spec Updates"
  # entry for sqlite-backup is satisfied by this direct host-config
  # change rather than a spec extension (Req 1.AC4 already covers it).
  #
  # Personal-host wiring is intentionally deferred — see the cavemem
  # integration roadmap for the eventual personal-host destination
  # decision.
  home.sqliteBackup = {
    enable = true;
    rcloneDestinations = {
      gdrive = {
        type = "drive";
      };
    };
    databases = [
      {
        name = "cavemem";
        # cavemem v0.2.1 + cavemem-data-dir-env.patch (cavemem-integration
        # task 1.3) honors CAVEMEM_DATA_DIR; the HM module's default is
        # ${config.xdg.dataHome}/cavemem and the SQLite filename is
        # data.db (NOT cavemem.db, verified at cavemem v0.2.1 source per
        # cavemem-integration task 7.2).
        path = "${config.xdg.dataHome}/cavemem/data.db";
        remote = "gdrive";
        # remotePath defaults to "sqlite-backup"; archiveTier defaults to
        # 03:00 daily with 7d/4w/6m retention; replicationTier defaults
        # to 300s off-host shipment cadence with 24h hourly retention.
        # All defaults match the cavemem workload profile (low-write
        # personal observation history) and the operator-confirmed
        # retention policy from the kiro-spec-requirements pass on
        # 2026-05-14. No tier overrides needed.
      }
    ];
  };

  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
