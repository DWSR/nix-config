# `fabro.postgres`: the single declaration surface for the guest's workload
# databases, roles, extensions, and grants.
#
# The interface deliberately has no password, superuser, createdb, or
# createrole field: peer authentication over the Unix socket needs no
# credential, and a workload role must not administer the cluster. Every
# consumer (server configuration, bootstrap SQL, grant SQL, and the evaluated
# checks) derives its input from `config.fabro.postgres`, so a second source
# cannot create a workload database or role.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.postgres;

  # Names are spliced into quoted SQL identifiers by the provisioning units;
  # restricting them to the unquoted-identifier subset keeps a declaration
  # from smuggling in a quote or a second statement.
  namePattern = "[a-z_][a-z0-9_]*";
  nameType = lib.types.strMatching namePattern;

  # A system account name is a Unix user name, not a SQL identifier: the
  # LiteLLM wiring maps the `litellm_migrator` role to the `litellm-migrator`
  # account, so hyphens stay legal here.
  systemUserNamePattern = "[a-z_][a-z0-9_-]*";
  systemUserNameType = lib.types.strMatching systemUserNamePattern;

  # The object privileges each grant scope may carry. The `on` option selects
  # the scope; `grantAssertions` rejects a privilege from another scope.
  grantPrivileges = {
    database = [ "CONNECT" ];
    schema = [ "USAGE" ];
    all-tables = [
      "SELECT"
      "INSERT"
      "UPDATE"
      "DELETE"
    ];
    all-sequences = [
      "USAGE"
      "SELECT"
    ];
  };

  declaredRoleNames = lib.attrNames cfg.roles;
  declaredDatabaseNames = lib.attrNames cfg.databases;

  # Peer-only authentication for the Unix socket: the module's superuser
  # mapping first, then one peer rule per declared role so `pg_ident` can map
  # that role's system account, and a final reject for every other local
  # connection. `lib.mkForce` replaces the module's default file, so its two
  # `host ... md5` lines cannot survive and no network rule reaches the
  # cluster.
  authenticationLines =
    lib.concatStringsSep "\n" (
      [ "local all postgres peer map=postgres" ]
      ++ lib.map (name: "local all ${name} peer map=fabro-services") declaredRoleNames
      ++ [ "local all all reject" ]
    )
    + "\n";

  # The `fabro-services` ident map maps each declared role's system account to
  # the role. `lib.mkAfter` appends these entries to the module default, so
  # the `postgres postgres postgres` superuser mapping survives.
  identMapLines = lib.concatMapStrings (
    name: "fabro-services ${cfg.roles.${name}.systemUser} ${name}\n"
  ) declaredRoleNames;

  # `postgresql-setup` creates the declared databases and roles. The role
  # projection carries only the role name and, when declared, its connection
  # limit: the declaration surface has no password, superuser, createdb, or
  # createrole field, and `ensureClauses` is never fed a caller-supplied
  # attrset, so no freeform clause can smuggle one in.
  roleUsers = lib.mapAttrsToList (
    name: role:
    {
      inherit name;
    }
    // lib.optionalAttrs (role.connectionLimit != -1) {
      ensureClauses.connection_limit = role.connectionLimit;
    }
  ) cfg.roles;

  nameAssertions =
    kind: label: names:
    map (name: {
      assertion = builtins.match namePattern name != null;
      message = "fabro.postgres.${kind}.${name}: the ${label} name '${name}' must match ${namePattern}.";
    }) names;

  roleAssertions = lib.concatLists (
    lib.mapAttrsToList (name: role: [
      {
        assertion = name != "postgres";
        message = "fabro.postgres.roles.${name}: the postgres role is reserved for the cluster superuser and cannot be declared as a workload role.";
      }
      {
        assertion = builtins.elem role.systemUser (lib.attrNames config.users.users);
        message = "fabro.postgres.roles.${name}.systemUser: the system user '${role.systemUser}' is not declared in users.users.";
      }
    ]) cfg.roles
  );

  databaseAssertions = lib.concatLists (
    lib.mapAttrsToList (name: database: [
      {
        assertion = name != "postgres";
        message = "fabro.postgres.databases.${name}: the postgres database is reserved for the cluster superuser and cannot be declared as a workload database.";
      }
      {
        assertion = builtins.elem database.owner declaredRoleNames;
        message = "fabro.postgres.databases.${name}.owner: the owner '${database.owner}' must be a declared role in fabro.postgres.roles.";
      }
    ]) cfg.databases
  );

  grantAssertions = lib.imap0 (
    index: grant:
    let
      path = "fabro.postgres.grants[${toString index}]";
      allowed = grantPrivileges.${grant.on};
    in
    [
      {
        assertion = builtins.elem grant.database declaredDatabaseNames;
        message = "${path}.database: the database '${grant.database}' must be declared in fabro.postgres.databases.";
      }
      {
        assertion = builtins.elem grant.role declaredRoleNames;
        message = "${path}.role: the role '${grant.role}' must be a declared role in fabro.postgres.roles.";
      }
      {
        assertion = builtins.all (privilege: builtins.elem privilege allowed) grant.privileges;
        message = "${path}.privileges: a grant on '${grant.on}' allows only [ ${lib.concatStringsSep " " allowed} ], but the declaration names [ ${lib.concatStringsSep " " grant.privileges} ].";
      }
    ]
  ) cfg.grants;

  # Quoted SQL identifier. `nameType`/`systemUserNameType` restrict every name
  # to `[a-z_][a-z0-9_]*` (or the hyphenated system-account form), so the
  # quotes cannot be escaped and no declaration can splice a second statement
  # into the generated file.
  sqlIdent = name: ''"${name}"'';

  # The grants of one `on` scope in one database, in declaration order.
  grantsOn =
    database: scope: lib.filter (grant: grant.database == database && grant.on == scope) cfg.grants;

  grantPrivilegeList = grant: lib.concatStringsSep ", " grant.privileges;

  # Guarded ownership: `ALTER DATABASE ... OWNER TO` is a no-op catalog-wise
  # when the declared owner already owns the database, and the guard keeps the
  # bootstrap from touching an already-correct catalog on every switch. The
  # `\echo` marker printed by the caller names the database when this block
  # fails.
  ownershipSql = name: database: ''
    DO $fabro$
    BEGIN
      IF EXISTS (
        SELECT 1
          FROM pg_database
         WHERE datname = '${name}'
           AND pg_get_userbyid(datdba) <> '${database.owner}'
      ) THEN
        ALTER DATABASE ${sqlIdent name} OWNER TO ${sqlIdent database.owner};
      END IF;
    END
    $fabro$;
  '';

  # Default privileges are keyed by the role that will create the objects, so
  # each owner gets a role-marked block. They cover the Prisma tables and the
  # views the migration role creates after this unit has run, which is why
  # `postgres-grants` can then apply the same privileges to every existing
  # object.
  defaultPrivilegesSql =
    name: database:
    let
      statements =
        lib.map (
          grant:
          "ALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdent database.owner} IN SCHEMA public GRANT ${grantPrivilegeList grant} ON TABLES TO ${sqlIdent grant.role};"
        ) (grantsOn name "all-tables")
        ++ lib.map (
          grant:
          "ALTER DEFAULT PRIVILEGES FOR ROLE ${sqlIdent database.owner} IN SCHEMA public GRANT ${grantPrivilegeList grant} ON SEQUENCES TO ${sqlIdent grant.role};"
        ) (grantsOn name "all-sequences");
    in
    lib.optionalString (statements != [ ]) ''
      \echo 'fabro.postgres: role ${database.owner}'
      ${lib.concatStringsSep "\n" statements}
    '';

  # One database block: guarded ownership and database-level revocation and
  # grants happen from the maintenance database; the `\connect` then enters the
  # declared database for extensions, the `public` schema posture, and the
  # owner's default privileges. `REVOKE ALL ... FROM PUBLIC` is what keeps a
  # role from another workload off this database (Requirement 5.11).
  databaseBootstrapSql =
    name:
    let
      database = cfg.databases.${name};
    in
    ''
      \echo 'fabro.postgres: database ${name}'
      ${ownershipSql name database}
      REVOKE ALL ON DATABASE ${sqlIdent name} FROM PUBLIC;
      REVOKE CREATE ON DATABASE ${sqlIdent name} FROM PUBLIC;
      ${lib.concatMapStrings (
        grant: "GRANT ${grantPrivilegeList grant} ON DATABASE ${sqlIdent name} TO ${sqlIdent grant.role};\n"
      ) (grantsOn name "database")}
      \connect ${sqlIdent name}
      ${lib.concatMapStrings (
        extension: "CREATE EXTENSION IF NOT EXISTS ${sqlIdent extension};\n"
      ) database.extensions}
      REVOKE CREATE ON SCHEMA public FROM PUBLIC;
      ${lib.concatMapStrings (
        grant: "GRANT ${grantPrivilegeList grant} ON SCHEMA public TO ${sqlIdent grant.role};\n"
      ) (grantsOn name "schema")}
      ${defaultPrivilegesSql name database}
    '';

  bootstrapSqlText = lib.concatMapStrings databaseBootstrapSql declaredDatabaseNames;
in
{
  options.fabro.postgres = {
    enable = lib.mkEnableOption "the shared PostgreSQL cluster and its declarative provisioning";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.unstable.postgresql_18;
      description = ''
        PostgreSQL package the cluster runs. The repository's pinned unstable
        input supplies the 18.6 server the workload contracts require.
      '';
    };

    dataDir = lib.mkOption {
      type = lib.types.str;
      default = "/var/lib/postgresql/18";
      readOnly = true;
      description = ''
        Cluster data directory. It is fixed so a configuration switch always
        reuses the same PGDATA and preserves existing databases, roles, and
        rows.
      '';
    };

    socketDir = lib.mkOption {
      type = lib.types.str;
      default = "/run/postgresql";
      readOnly = true;
      description = ''
        Unix socket directory the server listens on and every provisioning
        and workload client connects to.
      '';
    };

    roles = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule (
          { name, ... }:
          {
            options = {
              systemUser = lib.mkOption {
                type = systemUserNameType;
                default = name;
                description = ''
                  System account the role's peer-authenticated connection is
                  mapped from. It defaults to the role name, may contain
                  hyphens (for example `litellm-migrator`), and must be a
                  declared `users.users` entry.
                '';
              };
              connectionLimit = lib.mkOption {
                type = lib.types.int;
                default = -1;
                description = ''
                  Connection limit applied to the role. The default `-1`
                  leaves the cluster default in place.
                '';
              };
            };
          }
        )
      );
      default = { };
      description = ''
        Login roles declared for workload databases, keyed by role name.
      '';
    };

    databases = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            owner = lib.mkOption {
              type = nameType;
              description = ''
                Declared role that owns the database and the objects the
                schema-initialization step creates in it.
              '';
            };
            extensions = lib.mkOption {
              type = lib.types.listOf (
                lib.types.enum [
                  "pg_textsearch"
                  "vector"
                  "pg_uuidv7"
                ]
              );
              default = [ ];
              description = ''
                Extensions installed into the database. The values are the SQL
                extension names the pinned server packages provide.
              '';
            };
          };
        }
      );
      default = { };
      description = ''
        Workload databases, keyed by database name.
      '';
    };

    grants = lib.mkOption {
      type = lib.types.listOf (
        lib.types.submodule {
          options = {
            database = lib.mkOption {
              type = nameType;
              description = "Declared database the grant applies in.";
            };
            role = lib.mkOption {
              type = nameType;
              description = "Declared role that receives the grant.";
            };
            privileges = lib.mkOption {
              type = lib.types.nonEmptyListOf (
                lib.types.enum [
                  "CONNECT"
                  "USAGE"
                  "SELECT"
                  "INSERT"
                  "UPDATE"
                  "DELETE"
                ]
              );
              description = ''
                Privileges granted in the scope selected by `on`; each scope
                admits only its own subset.
              '';
            };
            on = lib.mkOption {
              type = lib.types.enum [
                "database"
                "schema"
                "all-tables"
                "all-sequences"
              ];
              description = ''
                Grant scope: the database, schema `public`, every table in
                `public`, or every sequence in `public`.
              '';
            };
          };
        }
      );
      default = [ ];
      description = ''
        Object grants applied to declared roles after schema initialization.
      '';
    };

    schemaInitUnits = lib.mkOption {
      type = lib.types.listOf lib.types.str;
      default = [ ];
      description = ''
        systemd units that initialize a workload's schema. The grant unit
        starts after every entry.
      '';
    };

    bootstrapSqlFile = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      default = pkgs.writeText "fabro-postgres-bootstrap.sql" bootstrapSqlText;
      description = ''
        Generated idempotent bootstrap SQL that `postgres-bootstrap.service`
        applies: each declared database's guarded ownership, database-level
        revocation and CONNECT grants, extensions, the `public` schema
        posture, and the owner's default privileges. Exposed so a check runs
        exactly the text the unit applies.
      '';
    };
  };

  config = lib.mkMerge [
    {
      assertions =
        nameAssertions "roles" "role" declaredRoleNames
        ++ nameAssertions "databases" "database" declaredDatabaseNames
        ++ roleAssertions
        ++ databaseAssertions
        ++ lib.concatLists grantAssertions;
    }

    # One server only: the module owns `postgresql.service`, the `postgres`
    # system account, and the data directory. `listen_addresses` is forced
    # empty because the module's `enableTCPIP = false` still writes
    # `localhost`; no firewall opening or Serve advertisement is added, so the
    # socket is the cluster's only reachable endpoint. Both authentication
    # files are generated from `fabro.postgres.roles`, so a declared role is
    # the only way to admit a workload connection. `ensureDatabases` and
    # `ensureUsers` are projected from the same declarations, so
    # `postgresql-setup` cannot create an object the interface did not
    # declare.
    (lib.mkIf cfg.enable {
      services.postgresql = {
        inherit (cfg) enable package dataDir;
        ensureDatabases = lib.attrNames cfg.databases;
        ensureUsers = roleUsers;
        extensions = ps: [
          ps.pg_textsearch
          ps.pgvector
          ps.pg_uuidv7
        ];
        authentication = lib.mkForce authenticationLines;
        identMap = lib.mkAfter identMapLines;
        settings = {
          listen_addresses = lib.mkForce "";
          unix_socket_directories = cfg.socketDir;
          shared_preload_libraries = "pg_textsearch";
          port = 5432;
        };
      };

      # The provisioning oneshot runs as the cluster superuser over the
      # socket, after `postgresql-setup` has created the declared databases
      # and roles and before every declared schema-initialization unit. It
      # applies the generated bootstrap SQL with the cluster's own `psql`, so
      # the client and server versions match; `ON_ERROR_STOP=1` fails the unit,
      # and the `\echo` markers plus `--echo-errors` put the failing
      # declaration and statement in the journal.
      systemd.services.postgres-bootstrap = {
        description = "Provision the declared PostgreSQL databases, extensions, and grants";
        wantedBy = [ "multi-user.target" ];
        requires = [
          "postgresql.service"
          "postgresql-setup.service"
        ];
        after = [
          "postgresql.service"
          "postgresql-setup.service"
        ];
        before = cfg.schemaInitUnits;
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          User = "postgres";
          Group = "postgres";
        };
        environment = {
          PGHOST = cfg.socketDir;
          PGPORT = toString config.services.postgresql.settings.port;
        };
        script = ''
          exec ${config.services.postgresql.finalPackage}/bin/psql -v ON_ERROR_STOP=1 --echo-errors -f ${cfg.bootstrapSqlFile}
        '';
      };
    })
  ];
}
