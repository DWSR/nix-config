_: {
  # Per-host wiring for the SQLite Backup module. The module is enabled
  # with rclone's synthetic local backend pointed at Google Drive's File
  # Provider folder. Restic completes against local filesystem semantics;
  # Google Drive synchronization remains external and is not a durability
  # signal for this pipeline.
  #
  home.sqliteBackup = {
    enable = true;
    pressureGuard = {
      minimumFilesystemAvailableBytes = 128 * 1024 * 1024 * 1024;
      checkIntervalSeconds = 60;
    };
    rcloneDestinations = {
      ":local" = {
        type = "local";
      };
    };
    databases = [ ];
  };

  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
