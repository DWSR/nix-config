{ config, ... }:
let
  localGoogleDriveRoot = "${config.home.homeDirectory}/Library/CloudStorage/GoogleDrive-brandon.mcnama@shopify.com/My Drive/sqlite-backup";
in
{
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
    databases = [
      {
        name = "opencode";
        # opencode's session DB lives at a fixed XDG-Data-Home-relative
        # path and is Drizzle-managed. Verified on this host
        # 2026-05-15: ~/.local/share/opencode/opencode-stable.db (414 MB
        # at time of wiring; SQLite WAL mode, Litestream-safe). Each
        # turn writes `tokens.{input,output,reasoning,cache.read,write}`
        # plus pre-computed cost into `message.data`, which is the
        # baseline data source for the opencode-cost-diagnosis spec
        # (see .kiro/specs/opencode-cost-diagnosis/brief.md). Losing
        # session history would erase that baseline, hence backing it
        # up here.
        #
        # Sensitivity: this DB contains full conversation history
        # (prompts, tool outputs, file contents read by the agent).
        # Complete session content is shipped encrypted via the existing
        # archive passphrase (1Password: sqlite-backup-archive).
        #
        # Personal-host wiring remains intentionally deferred pending a
        # destination decision.
        path = "${config.xdg.dataHome}/opencode/opencode-stable.db";
        remote = ":local";
        remotePath = localGoogleDriveRoot;
        pressureGuard.maximumManagedLocalBytes = 128 * 1024 * 1024 * 1024;
        # Default tiers match the opencode workload profile: bursty
        # writes during active sessions but otherwise quiet; default
        # 300s replication cadence and 03:00 daily archive with
        # 7d/4w/6m retention are appropriate. Re-evaluate if the DB
        # grows substantially (at ~500MB+ consider tightening replication
        # retention to keep
        # off-host bandwidth bounded).
      }
    ];
  };

  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
