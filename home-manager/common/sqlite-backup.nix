{
  lib,
  ...
}:
let
  inherit (lib) mkOption types;

  # Options shape for a single rclone destination entry. The freeform
  # type permits arbitrary non-credential rclone backend attributes
  # (region, endpoint, scope, etc.) per R5.AC5; credentials live in
  # the operator-managed encrypted ~/.config/rclone/rclone.conf and
  # never appear here.
  destinationOpts = {
    freeformType = types.attrsOf types.str;

    options = {
      type = mkOption {
        type = types.str;
        description = ''
          rclone backend type for this destination, e.g. `"drive"`,
          `"b2"`, `"s3"`, `"sftp"`, or `"local"`.
        '';
        example = "drive";
      };
    };
  };

  # Options shape for a single configured database. Defaults match the
  # values documented in design.md §HM Module Service Interface.
  databaseOpts = {
    options = {
      name = mkOption {
        type = types.str;
        description = ''
          Logical identifier for this database. Used in launchd agent
          labels, log paths, and per-database state directories. Must
          be unique within the host.
        '';
        example = "cavemem";
      };

      path = mkOption {
        type = types.path;
        description = ''
          Absolute path to the live SQLite database file that
          Litestream will replicate. Typically expressed as
          `"''${config.home.homeDirectory}/.cavemem/data.db"` so the
          path follows the operator's home directory.
        '';
        example = lib.literalExpression ''
          "''${config.home.homeDirectory}/.cavemem/data.db"
        '';
      };

      remote = mkOption {
        type = types.str;
        description = ''
          Name of the entry in `home.sqliteBackup.rcloneDestinations`
          that this database ships its archival snapshots to. Must be
          a key of `rcloneDestinations`.
        '';
        example = "gdrive";
      };

      remotePath = mkOption {
        type = types.str;
        default = "sqlite-backup";
        description = ''
          Path component appended to the rclone remote when shipping
          this database's restic repository off-host.
        '';
      };

      replicationTier = mkOption {
        type = types.submodule {
          options = {
            cadenceSeconds = mkOption {
              type = types.int;
              default = 300;
              description = ''
                Cadence (in seconds) at which the replication-tier
                wrapper runs to capture committed transactions into
                the local restic repository (R14.AC2).
              '';
            };

            retention = mkOption {
              type = types.listOf types.str;
              default = [
                "--keep-hourly"
                "24"
              ];
              description = ''
                restic retention CLI flags applied to replication-tier
                snapshots (tag `replication`).
              '';
            };
          };
        };
        default = { };
        description = ''
          Replication-tier (continuous, frequent, short-retention)
          settings for this database.
        '';
      };

      archiveTier = mkOption {
        type = types.submodule {
          options = {
            schedule = mkOption {
              type = types.attrs;
              default = {
                Hour = 3;
                Minute = 0;
              };
              description = ''
                launchd `StartCalendarInterval` attribute set scheduling
                the archive-tier snapshot for this database.
              '';
            };

            retention = mkOption {
              type = types.listOf types.str;
              default = [
                "--keep-daily"
                "7"
                "--keep-weekly"
                "4"
                "--keep-monthly"
                "6"
              ];
              description = ''
                restic retention CLI flags applied to archive-tier
                snapshots (tag `archive`).
              '';
            };
          };
        };
        default = { };
        description = ''
          Archive-tier (scheduled, encrypted, long-retention) settings
          for this database.
        '';
      };
    };
  };
in
{
  options.home.sqliteBackup = {
    enable = lib.mkEnableOption "declarative SQLite backup pipeline (Litestream + restic + rclone)";

    rcloneDestinations = mkOption {
      type = types.attrsOf (types.submodule destinationOpts);
      default = { };
      description = ''
        Named set of rclone destinations available to entries in
        `home.sqliteBackup.databases`. Each entry must declare its
        rclone backend `type` and may declare any additional
        non-credential rclone backend attributes (region, endpoint
        URL, scope, etc.) as freeform string-valued attributes.
        Database entries reference these destinations by name only;
        the backend type and other backend attributes are never
        embedded inline at the database entry (R5.AC5).
      '';
      example = lib.literalExpression ''
        {
          gdrive = { type = "drive"; };
          b2-east = {
            type = "b2";
            hard_delete = "true";
          };
        }
      '';
    };

    databases = mkOption {
      type = types.listOf (types.submodule databaseOpts);
      default = [ ];
      description = ''
        List of SQLite databases to back up. With the empty default
        and `enable = true`, the module declares no runtime agents
        and performs no activation-time verification — the dormant
        default required by R1.AC2 and R1.AC3.
      '';
    };

    archivePassphraseSecret = mkOption {
      type = types.str;
      default = "sqlite-backup-archive-passphrase";
      description = ''
        macOS Keychain service name (under the `mcp-hub` account)
        that holds the passphrase used by restic to encrypt
        archive-tier snapshots before they leave the host.
      '';
    };

    rcloneConfigPassphraseSecret = mkOption {
      type = types.str;
      default = "sqlite-backup-rclone-config-passphrase";
      description = ''
        macOS Keychain service name (under the `mcp-hub` account)
        that holds the passphrase used to decrypt the operator-
        managed `~/.config/rclone/rclone.conf` at activation time
        (R17 verification) and at runtime for off-host shipment.
      '';
    };
  };
}
