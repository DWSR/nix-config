{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkOption types;

  cfg = config.home.sqliteBackup;
  maxSafeInteger = 9007199254740991;
  yamlFormat = pkgs.formats.yaml { };

  # Single discoverable declaration site for the minimum versions of
  # the underlying tools this pipeline relies on (R11.AC3). Future
  # maintenance updates these constants in one place; the assertions
  # below — and any subsequent runtime checks — read from the same
  # binding.
  toolMinima = {
    litestream = "0.5.7";
    restic = "0.18.0";
    rclone = "1.72.0";
  };

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

      pressureGuard = mkOption {
        type = types.submodule {
          options.maximumManagedLocalBytes = mkOption {
            type = types.ints.unsigned;
            default = maxSafeInteger;
            description = ''
              Maximum physical allocated bytes across this database's
              Litestream staging, restic repository, and Litestream metadata
              directories before the complete pipeline is pressure-halted.
            '';
          };
        };
        default = { };
        description = "Per-database local disk-pressure guard settings.";
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

    pressureGuard = mkOption {
      type = types.submodule {
        options = {
          minimumFilesystemAvailableBytes = mkOption {
            type = types.ints.unsigned;
            default = 0;
            description = ''
              Minimum bytes that must remain available on the root filesystem.
              A lower observation pressure-halts each affected database.
            '';
          };

          checkIntervalSeconds = mkOption {
            type = types.ints.positive;
            default = 60;
            description = "Cadence of each per-database pressure guard agent.";
          };
        };
      };
      default = { };
      description = "Host-wide SQLite backup disk-pressure guard settings.";
    };

    archivePassphraseSecret = mkOption {
      type = types.str;
      default = "sqlite-backup-archive-passphrase";
      description = ''
        macOS Keychain account name (under the `nix-config-secrets` service)
        that holds the passphrase used by restic to encrypt
        archive-tier snapshots before they leave the host. The
        Keychain entry is written by the SOPS-bridged activation
        script as `-s nix-config-secrets -a <secret>`; the cli and
        verify scripts read it back with the same axis orientation.
      '';
    };

    rcloneConfigPassphraseSecret = mkOption {
      type = types.str;
      default = "sqlite-backup-rclone-config-passphrase";
      description = ''
        macOS Keychain account name (under the `nix-config-secrets` service)
        that holds the passphrase used to decrypt the operator-
        managed `~/.config/rclone/rclone.conf` at activation time
        (R17 verification) and at runtime for off-host shipment.
        Same `-s nix-config-secrets -a <secret>` orientation as
        `archivePassphraseSecret`.
      '';
    };

    _manifestPath = mkOption {
      type = types.path;
      internal = true;
      readOnly = true;
      description = ''
        Store path of the rendered sqlite-backup manifest JSON. This
        is the single cross-component data contract: the system-tier
        verification module reads it via
        `config.home-manager.users.<user>.home.sqliteBackup._manifestPath`
        and the per-database CLI binary embeds it at derivation time.
        Operators cannot override this option; it is computed from
        the public surface.
      '';
    };

    _cliBinary = mkOption {
      type = types.nullOr types.package;
      internal = true;
      default = null;
      description = ''
        Per-database operator CLI derivation. Built and wired in by
        the CLI-integration task that follows the per-DB launchd
        agent declaration (see tasks.md). When `null`, the per-DB
        replicate, archive, and pressure-guard launchd agents are not declared — only
        the Litestream daemon agent is emitted per configured
        database. When set to a derivation exposing
        `bin/sqlite-backup`, all four agents per database are
        declared. Operators do not set this option directly; the
        configuration glue layer wires it from the CLI module.
      '';
    };
  };

  config = lib.mkIf cfg.enable (
    let
      dbRootFor = db: "${config.xdg.dataHome}/sqlite-backup/${db.name}";
      stagingDirFor = db: "${dbRootFor db}/litestream-staging";
      repoDirFor = db: "${dbRootFor db}/restic";
      litestreamMetadataDirFor = db: "${dbRootFor db}/litestream-metadata";

      litestreamConfigFor =
        db:
        yamlFormat.generate "sqlite-backup-litestream-${db.name}.yaml" {
          dbs = [
            {
              path = toString db.path;
              "meta-path" = litestreamMetadataDirFor db;
              replica.url = "file://${stagingDirFor db}";
            }
          ];
        };

      pressureGuardFor = db: {
        inherit (cfg.pressureGuard) checkIntervalSeconds minimumFilesystemAvailableBytes;
        inherit (db.pressureGuard) maximumManagedLocalBytes;
        filesystemPath = "/";
        managedPaths = [
          (stagingDirFor db)
          (repoDirFor db)
          (litestreamMetadataDirFor db)
        ];
      };

      # Single derivation reference for the operator-facing CLI. The same
      # value is exposed three ways:
      #
      #   1. `home.packages = [ cliBinary ]` — puts `sqlite-backup` on
      #      the operator's interactive shell PATH (R13.AC1, R13.AC2).
      #   2. `home.sqliteBackup._cliBinary = cliBinary` — flips the
      #      placeholder option from Task 2.5 so the per-DB replicate,
      #      archive, and pressure-guard launchd wrappers are emitted with
      #      `ProgramArguments` pointing at the same store path.
      #
      # Holding the binding once guarantees the launchd
      # `ProgramArguments` paths and the user-installed binary on PATH
      # resolve to the same store derivation — avoids any drift between
      # what the operator runs by hand and what launchd kicks off
      # (Task 2.5 review, suggestion 8).
      #
      # Manifest path is baked into the derivation at build time via
      # `cfg._manifestPath`; the script then reads its own configuration
      # without needing the path passed at runtime.
      cliBinary = import ../../scripts/sqlite-backup-cli.nix {
        inherit pkgs lib;
        manifestPath = cfg._manifestPath;
      };
    in
    {
      # Eval-time guards. The platform assertion fires whenever the
      # module is enabled (R10.AC2). The version and missing-destination
      # assertions only matter when at least one database is configured —
      # the dormant default (R1.AC2 / R1.AC3) must continue to evaluate
      # cleanly with `databases = [ ]`.
      assertions = [
        (lib.hm.assertions.assertPlatform "home.sqliteBackup" pkgs lib.platforms.darwin)
        {
          assertion = cfg.pressureGuard.minimumFilesystemAvailableBytes <= maxSafeInteger;
          message = ''
            home.sqliteBackup.pressureGuard.minimumFilesystemAvailableBytes
            must not exceed ${toString maxSafeInteger} so runtime JSON and
            shell arithmetic remain exact.
          '';
        }
      ]
      ++ lib.optionals (cfg.databases != [ ]) (
        [
          {
            assertion = lib.versionAtLeast pkgs.litestream.version toolMinima.litestream;
            message = ''
              home.sqliteBackup requires pkgs.litestream version
              ${toolMinima.litestream} or newer, but the available
              version is ${pkgs.litestream.version}. Update the
              Litestream overlay (overlays/litestream.nix) or the
              `nixpkgs-unstable` flake input that backs it.
            '';
          }
        ]
        ++ lib.concatMap (db: [
          {
            assertion = builtins.hasAttr db.remote cfg.rcloneDestinations;
            message = ''
              home.sqliteBackup.databases entry "${db.name}" references
              rclone destination "${db.remote}", but no entry with that
              name is declared in home.sqliteBackup.rcloneDestinations.
              Either add a "${db.remote}" entry to rcloneDestinations,
              or change database "${db.name}" to reference an existing
              destination.
            '';
          }
          {
            assertion = db.pressureGuard.maximumManagedLocalBytes <= maxSafeInteger;
            message = ''
              home.sqliteBackup.databases entry "${db.name}" sets
              pressureGuard.maximumManagedLocalBytes above
              ${toString maxSafeInteger}; runtime JSON and shell arithmetic
              require a JSON-safe integer.
            '';
          }
        ]) cfg.databases
      );

      # Manual halt-flag clearing activation hook (R13.AC15). On every HM
      # activation (e.g. `darwin-rebuild switch`), remove any manual halt
      # flags written by the operator CLI under
      # `${config.xdg.stateHome}/sqlite-backup/halt-*.flag`. This makes
      # manual halt state ephemeral with respect to rebuilds: the declarative
      # `home.sqliteBackup.databases` configuration takes precedence
      # and pipelines return to their declared running state.
      #
      # Emergency `pressure-*.json` markers are a separate persistent safety
      # state and MUST NOT be removed by activation. Only the CLI's guarded
      # `clear-pressure` transition may remove them.
      #
      # Uses HM's `run` and `verboseEcho` shell helpers (see
      # home-manager modules/home-environment.nix:433-488), which honor
      # `DRY_RUN` and `VERBOSE` automatically. The `2>/dev/null || true`
      # tail keeps activation idempotent on first run when neither the
      # parent directory nor any halt files exist.
      home.activation.sqlite-backup-clear-halts = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
        verboseEcho "Clearing sqlite-backup manual halt flags; preserving pressure markers"
        run rm -f -- "${config.xdg.stateHome}/sqlite-backup/halt-"*.flag 2>/dev/null || true
      '';

      # Manifest renderer (R1.AC1, R5.AC5, R16.AC1). The rendered
      # manifest is the single cross-component data contract — the
      # system-tier verification module and the per-database CLI binary
      # both consume it (design.md §HM Module → State Management). The
      # manifest exists whenever the module is enabled, including the
      # dormant `databases = [ ]` case, so that downstream consumers
      # have a stable file to point at.
      home.sqliteBackup._manifestPath = pkgs.writeText "sqlite-backup-manifest.json" (
        builtins.toJSON {
          rcloneConfigPath = "${config.xdg.configHome}/rclone/rclone.conf";
          inherit (cfg) rcloneConfigPassphraseSecret archivePassphraseSecret;
          # Per Mechanism A in design.md §Boundary Commitments: every
          # secret consumed by this pipeline is stored in the macOS
          # Keychain under SERVICE = `nix-config-secrets`, ACCOUNT =
          # secret name (e.g. `sqlite-backup-archive-passphrase`).
          # The activation script (`mcp-secrets-activate.nix`) writes
          # the entries with this orientation; the cli and verify
          # scripts read them back the same way. This swapped-axis
          # form matches the post-mcpproxy-migration convention shared
          # with MCP secrets (which use SERVICE = `mcpproxy`).
          keychainService = "nix-config-secrets";
          inherit (cfg) rcloneDestinations;
          databases = map (db: {
            inherit (db)
              name
              path
              remote
              remotePath
              replicationTier
              archiveTier
              ;
            stagingDir = stagingDirFor db;
            repoDir = repoDirFor db;
            litestreamMetadataDir = litestreamMetadataDirFor db;
            litestreamConfigPath = litestreamConfigFor db;
            pressureGuard = pressureGuardFor db;
          }) cfg.databases;
        }
      );

      # Per-database launchd agent declarations (R2.1, R2.4-2.6, R12.3,
      # R14.2-3, R15.1, R15.5). For each entry in `cfg.databases` we
      # emit up to four agents under the
      # `dev.dwsr.sqlite-backup.{litestream,replicate,archive,guard}.<db>`
      # label scheme documented in design.md §"Architecture Pattern &
      # Boundary Map":
      #
      #   * `litestream.<db>` — long-running Litestream daemon
      #     (`KeepAlive = true`, auto-restarts on exit per R2.4) that
      #     replicates the live SQLite WAL into the per-DB staging
      #     directory.
      #   * `replicate.<db>` — `StartInterval`-driven wrapper that
      #     drives the replication-tier snapshot via the operator CLI
      #     (`__replicate-trigger` subcommand, R14.2).
      #   * `archive.<db>` — `StartCalendarInterval`-driven wrapper
      #     that drives the archive-tier snapshot via the operator
      #     CLI (`__archive-trigger` subcommand, R14.3).
      #   * `guard.<db>` — independent RunAtLoad + StartInterval disk guard
      #     that persists a pressure marker and unloads Litestream when a
      #     configured byte threshold is violated.
      #
      # The replicate, archive, and guard wrappers depend on the per-database
      # CLI binary, which is built by a later task and wired into
      # `cfg._cliBinary` by the configuration glue layer. While
      # `_cliBinary` is the default `null`, only the Litestream daemon
      # agent is declared per database; the wrappers are emitted as
      # soon as the CLI derivation is wired in. The dormant default
      # (`databases = [ ]`, R1.AC2 / R1.AC3) emits no agents at all.
      launchd.agents =
        let
          logBaseFor = db: role: "${config.home.homeDirectory}/Library/Logs/sqlite-backup-${db.name}-${role}";

          # Build a single launchd agent name/value pair for use with
          # `lib.listToAttrs`. The HM-side attribute key is local to
          # this repo; the user-facing identity is the `Label` field
          # set by the per-role builders below.
          mkAgent = db: role: extra: {
            name = "sqlite-backup-${role}-${db.name}";
            value = {
              enable = true;
              config = {
                Label = "dev.dwsr.sqlite-backup.${role}.${db.name}";
                StandardOutPath = "${logBaseFor db role}.log";
                StandardErrorPath = "${logBaseFor db role}.error.log";
              }
              // extra;
            };
          };

          litestreamAgent =
            db:
            mkAgent db "litestream" {
              KeepAlive = true;
              RunAtLoad = true;
              ProgramArguments = [
                "${cliBinary}/bin/sqlite-backup"
                "__litestream-trigger"
                db.name
              ];
            };

          replicateAgent =
            db:
            mkAgent db "replicate" {
              StartInterval = db.replicationTier.cadenceSeconds;
              ProgramArguments = [
                "${cfg._cliBinary}/bin/sqlite-backup"
                "__replicate-trigger"
                db.name
              ];
            };

          archiveAgent =
            db:
            mkAgent db "archive" {
              StartCalendarInterval = db.archiveTier.schedule;
              ProgramArguments = [
                "${cfg._cliBinary}/bin/sqlite-backup"
                "__archive-trigger"
                db.name
              ];
            };

          guardAgent =
            db:
            mkAgent db "guard" {
              RunAtLoad = true;
              StartInterval = cfg.pressureGuard.checkIntervalSeconds;
              ProgramArguments = [
                "${cfg._cliBinary}/bin/sqlite-backup"
                "__pressure-guard"
                db.name
              ];
            };

          perDbAgents =
            db:
            [ (litestreamAgent db) ]
            ++ lib.optionals (cfg._cliBinary != null) [
              (replicateAgent db)
              (archiveAgent db)
              (guardAgent db)
            ];
        in
        lib.listToAttrs (lib.concatMap perDbAgents cfg.databases);

      # CLI binary on the operator's PATH (R13.AC1, R13.AC2). The same
      # derivation is wired into `home.sqliteBackup._cliBinary` below so
      # that the per-DB launchd `ProgramArguments` resolve to the exact
      # store path the operator invokes from a shell.
      home.packages = [ cliBinary ];

      # Flip the Task 2.5 placeholder so the per-DB replicate, archive, and
      # guard launchd agents get emitted alongside the always-on Litestream
      # daemon agent. Single source of truth — same derivation reference
      # appears in `home.packages` (above) and here, so the launchd
      # ProgramArguments and the PATH binary cannot diverge.
      home.sqliteBackup._cliBinary = cliBinary;

      # Two `home.mcp.keychainSecrets` entries that route the SQLite
      # backup pipeline's two passphrases through the existing sops →
      # 1Password → macOS Keychain bridge (R7.1, R7.2, R7.3 and design.md
      # §"HM Module → Implementation Notes"):
      #
      #   * `archivePassphraseSecret` (default
      #     `sqlite-backup-archive-passphrase`) — the symmetric
      #     passphrase restic uses to encrypt every snapshot in both the
      #     local and the off-host repository.
      #   * `rcloneConfigPassphraseSecret` (default
      #     `sqlite-backup-rclone-config-passphrase`) — the passphrase
      #     rclone uses to decrypt the operator-managed
      #     `~/.config/rclone/rclone.conf` at activation-time
      #     verification (R17) and at every off-host shipment.
      #
      # The keys deliberately reference `cfg.archivePassphraseSecret` /
      # `cfg.rcloneConfigPassphraseSecret` rather than hardcoded strings
      # so per-host scaffolds that override the secret service name
      # (e.g., to scope multiple hosts under distinct Keychain entries)
      # stay in sync without a parallel edit here.
      #
      # The 1Password URIs below are the operator workflow defaults
      # documented in design.md §"Recovery and Operations Workflow"
      # phase 3. Per-host scaffolds can override either entry by adding
      # a `home.mcp.keychainSecrets.<service-name> = "op://...";` line
      # of their own — Nix attrset merging means the scaffold value
      # wins. Operators on hosts that source secrets from a different
      # 1Password vault (e.g., `op://Employee/...` on Shopify-managed
      # hosts) should override here in their per-host scaffold.
      home.mcp.keychainSecrets = {
        ${cfg.archivePassphraseSecret} = "op://Private/sqlite-backup-archive/passphrase";
        ${cfg.rcloneConfigPassphraseSecret} = "op://Private/sqlite-backup-rclone-config/passphrase";
      };
    }
  );
}
