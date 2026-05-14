_: {
  # Dormant per-host scaffold for the SQLite Backup module. The module
  # is enabled with no databases and no rclone destinations, which (per
  # design.md §"Per-host Scaffolds" and requirements 1.2 / 1.3) creates
  # no runtime agents and requires no archival passphrase. Per-host
  # divergence (real rclone destinations and database entries) lands in
  # this file in follow-up PRs.
  home.sqliteBackup = {
    enable = true;
    rcloneDestinations = {
      gdrive = {
        type = "drive";
      };
    };
    databases = [ ];
  };

  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
