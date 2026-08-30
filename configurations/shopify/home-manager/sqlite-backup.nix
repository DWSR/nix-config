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
        name = "cavemem";
        # cavemem v0.2.1 + cavemem-data-dir-env.patch (cavemem-integration
        # task 1.3) honors CAVEMEM_DATA_DIR; the HM module's default is
        # ${config.xdg.dataHome}/cavemem and the SQLite filename is
        # data.db (NOT cavemem.db, verified at cavemem v0.2.1 source per
        # cavemem-integration task 7.2).
        path = "${config.xdg.dataHome}/cavemem/data.db";
        remote = ":local";
        remotePath = localGoogleDriveRoot;
        # remotePath selects the local Drive File Provider root; archiveTier
        # defaults to 03:00 daily with 7d/4w/6m retention; replicationTier
        # defaults to 300s shipment cadence with 24h hourly retention.
        # All defaults match the cavemem workload profile (low-write
        # personal observation history) and the operator-confirmed
        # retention policy from the kiro-spec-requirements pass on
        # 2026-05-14. No tier overrides needed.
      }
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
        # Same sensitivity profile as cavemem above — both capture
        # complete session content. Shipped encrypted via the existing
        # archive passphrase (1Password: sqlite-backup-archive); trust
        # model is identical to cavemem on this host.
        #
        # Personal-host wiring intentionally deferred, mirroring the
        # cavemem precedent — operator-decision pending on the personal
        # destination.
        path = "${config.xdg.dataHome}/opencode/opencode-stable.db";
        remote = ":local";
        remotePath = localGoogleDriveRoot;
        pressureGuard.maximumManagedLocalBytes = 96 * 1024 * 1024 * 1024;
        # Default tiers match the opencode workload profile: bursty
        # writes during active sessions but otherwise quiet; default
        # 300s replication cadence and 03:00 daily archive with
        # 7d/4w/6m retention are appropriate. Re-evaluate if the DB
        # grows substantially (it is already ~10x cavemem's size — at
        # ~500MB+ consider tightening replication retention to keep
        # off-host bandwidth bounded).
      }
    ];
  };

  home.mcp.keychainSecrets = {
    sqlite-backup-archive-passphrase = "op://Employee/sqlite-backup-archive/passphrase";
    sqlite-backup-rclone-config-passphrase = "op://Employee/sqlite-backup-rclone-config/passphrase";
  };
}
