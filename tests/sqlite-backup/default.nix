{
  pkgs,
  home-manager,
  realLitestream ? null,
  shopifyHome ? null,
}:
let
  inherit (pkgs) lib;

  litestreamFixture =
    (pkgs.writeShellScriptBin "litestream" ''
      echo "litestream fixture must not run in sqlite-backup tests" >&2
      exit 1
    '').overrideAttrs
      (_: {
        version = "0.5.11";
      });
  testPkgs = pkgs.extend (
    _final: _prev: {
      litestream = litestreamFixture;
    }
  );
  databaseFixture = pkgs.writeText "sqlite-backup-test.db" "";

  manifestData = builtins.fromJSON (builtins.readFile ./manifest.json);
  mkManifest =
    {
      suffix,
      minimum,
      maximum,
      managedPaths ? null,
    }:
    let
      db = builtins.head manifestData.databases;
    in
    pkgs.writeText "sqlite-backup-test-manifest-${suffix}.json" (
      builtins.toJSON (
        manifestData
        // {
          databases = [
            (
              db
              // {
                pressureGuard =
                  db.pressureGuard
                  // {
                    minimumFilesystemAvailableBytes = minimum;
                    maximumManagedLocalBytes = maximum;
                  }
                  // lib.optionalAttrs (managedPaths != null) { inherit managedPaths; };
              }
            )
          ]
          ++ builtins.tail manifestData.databases;
        }
      )
    );
  managedSymlinkTarget = pkgs.runCommand "sqlite-backup-managed-symlink-target" { } ''
    mkdir -p "$out"
    printf 'allocated managed data\n' >"$out/payload"
  '';
  managedSymlink = pkgs.runCommand "sqlite-backup-managed-symlink" { } ''
    ln -s ${managedSymlinkTarget} "$out"
  '';
  manifest = mkManifest {
    suffix = "exact";
    minimum = 102400;
    maximum = 3072;
  };
  belowBoundaryManifest = mkManifest {
    suffix = "below-boundary";
    minimum = 102401;
    maximum = 3073;
  };
  aboveBoundaryManifest = mkManifest {
    suffix = "above-boundary";
    minimum = 102399;
    maximum = 3071;
  };
  symlinkManifest = mkManifest {
    suffix = "managed-symlink";
    minimum = 0;
    maximum = 0;
    managedPaths = [ "${managedSymlink}" ];
  };
  recoveryPolicyManifest = mkManifest {
    suffix = "recovery-policy";
    minimum = 102400;
    maximum = 204800;
    managedPaths = [ "/" ];
  };
  markerPolicyManifest = mkManifest {
    suffix = "marker-policy";
    minimum = 102400;
    maximum = 102400;
    managedPaths = [ "/" ];
  };
  lowerPolicyManifest = mkManifest {
    suffix = "lower-policy";
    minimum = 102400;
    maximum = 51200;
    managedPaths = [ "/" ];
  };
  invalidPolicyManifest = mkManifest {
    suffix = "invalid-policy";
    minimum = 102400;
    maximum = 102400;
    managedPaths = [ ];
  };
  mkCli =
    manifestPath:
    import ../../scripts/sqlite-backup-cli.nix {
      pkgs = testPkgs;
      inherit lib manifestPath;
    };
  cli = mkCli manifest;
  belowBoundaryCli = mkCli belowBoundaryManifest;
  aboveBoundaryCli = mkCli aboveBoundaryManifest;
  symlinkCli = mkCli symlinkManifest;
  recoveryPolicyCli = mkCli recoveryPolicyManifest;
  markerPolicyCli = mkCli markerPolicyManifest;
  lowerPolicyCli = mkCli lowerPolicyManifest;
  invalidPolicyCli = mkCli invalidPolicyManifest;

  hm = home-manager.lib.homeManagerConfiguration {
    pkgs = testPkgs;
    modules = [
      ../../home-manager/common/sqlite-backup.nix
      (
        { lib, ... }:
        {
          options.home.mcp.keychainSecrets = lib.mkOption {
            type = lib.types.attrsOf lib.types.str;
            default = { };
          };

          config = {
            home = {
              username = "sqlite-backup-test";
              homeDirectory = "/var/empty/sqlite-backup-test";
              stateVersion = "26.05";
              sqliteBackup = {
                enable = true;
                pressureGuard = {
                  minimumFilesystemAvailableBytes = 102400;
                  checkIntervalSeconds = 60;
                };
                rcloneDestinations.fixture.type = "local";
                databases = [
                  {
                    name = "fixture";
                    path = databaseFixture;
                    remote = "fixture";
                    pressureGuard.maximumManagedLocalBytes = 3072;
                  }
                ];
              };
            };
          };
        }
      )
    ];
  };

  activation =
    pkgs.writeText "sqlite-backup-clear-halts-activation"
      hm.config.home.activation."sqlite-backup-clear-halts".data;

  render = pkgs.writeText "sqlite-backup-pressure-guard-render.json" (
    builtins.toJSON {
      agentNames = builtins.attrNames hm.config.launchd.agents;
      guard = hm.config.launchd.agents."sqlite-backup-guard-fixture".config;
      litestream = hm.config.launchd.agents."sqlite-backup-litestream-fixture".config;
      manifestPath = hm.config.home.sqliteBackup._manifestPath;
    }
  );

  localGoogleDriveRoot = "${hm.config.home.homeDirectory}/Library/CloudStorage/GoogleDrive-sqlite-backup-test/My Drive/sqlite-backup";
  localHm = hm.extendModules {
    modules = [
      {
        home.sqliteBackup.rcloneDestinations = lib.mkForce { ":local".type = "local"; };
        home.sqliteBackup.databases = lib.mkForce [
          {
            name = "fixture";
            path = databaseFixture;
            remote = ":local";
            remotePath = localGoogleDriveRoot;
            pressureGuard.maximumManagedLocalBytes = 3072;
          }
        ];
      }
    ];
  };
  localRender = pkgs.writeText "sqlite-backup-local-destination-render.json" (
    builtins.toJSON {
      inherit localGoogleDriveRoot;
      agentNames = builtins.attrNames localHm.config.launchd.agents;
      manifestPath = localHm.config.home.sqliteBackup._manifestPath;
    }
  );

  shopifyPolicy =
    if shopifyHome == null then
      { }
    else
      let
        sqliteBackup = shopifyHome.home.sqliteBackup;
        guardNames = builtins.filter (name: builtins.match "sqlite-backup-guard-.*" name != null) (
          builtins.attrNames shopifyHome.launchd.agents
        );
      in
      {
        inherit guardNames;
        inherit (sqliteBackup.pressureGuard)
          checkIntervalSeconds
          minimumFilesystemAvailableBytes
          ;
        databases = map (db: {
          inherit (db) name remote remotePath;
        }) sqliteBackup.databases;
        manifestPath = sqliteBackup._manifestPath;
        inherit (sqliteBackup) rcloneDestinations;
      };
  shopifyPolicyFile = pkgs.writeText "sqlite-backup-shopify-policy.json" (
    builtins.toJSON shopifyPolicy
  );
in
pkgs.runCommand "sqlite-backup-tests"
  {
    nativeBuildInputs = [
      pkgs.bash
      pkgs.jq
      pkgs.rclone
      pkgs.restic
    ];
    SQLITE_BACKUP_ACTIVATION = activation;
    SQLITE_BACKUP_ACTIVATION_STATE_HOME = hm.config.xdg.stateHome;
    SQLITE_BACKUP_CLI_ABOVE_BOUNDARY = lib.getExe aboveBoundaryCli;
    SQLITE_BACKUP_CLI_BELOW_BOUNDARY = lib.getExe belowBoundaryCli;
    SQLITE_BACKUP_CLI_MANAGED_SYMLINK = lib.getExe symlinkCli;
    SQLITE_BACKUP_CLI_RECOVERY_POLICY = lib.getExe recoveryPolicyCli;
    SQLITE_BACKUP_CLI_MARKER_POLICY = lib.getExe markerPolicyCli;
    SQLITE_BACKUP_CLI_LOWER_POLICY = lib.getExe lowerPolicyCli;
    SQLITE_BACKUP_CLI_INVALID_POLICY = lib.getExe invalidPolicyCli;
    SQLITE_BACKUP_CLI = lib.getExe cli;
    SQLITE_BACKUP_MANAGED_SYMLINK = managedSymlink;
    SQLITE_BACKUP_REAL_LITESTREAM = if realLitestream == null then "" else lib.getExe realLitestream;
    SQLITE_BACKUP_RENDER = render;
    SQLITE_BACKUP_LOCAL_RENDER = localRender;
    SQLITE_BACKUP_LOCAL_CLI = lib.getExe localHm.config.home.sqliteBackup._cliBinary;
    SQLITE_BACKUP_SHOPIFY_POLICY = shopifyPolicyFile;
    SQLITE_BACKUP_SHOPIFY_CLI =
      if shopifyHome == null then "" else lib.getExe shopifyHome.home.sqliteBackup._cliBinary;
  }
  ''
    bash ${./persistent-emergency-halts.test.sh}
    bash ${./disk-pressure-guard.test.sh}
    bash ${./local-google-drive-destination.test.sh}
    touch "$out"
  ''
