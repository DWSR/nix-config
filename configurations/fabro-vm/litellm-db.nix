# The fixed system accounts and database declarations for the LiteLLM
# database wiring.
#
# `litellm` runs the proxy and `litellm-migrator` runs the schema
# initialization; peer authentication over the Unix socket maps each account
# to its own database role with no stored credential. Both are plain system
# accounts in their matching groups: no DynamicUser, no privileged
# supplementary group, and no workload unit on the `postgres` account.
#
# The `litellm` database is declared through the shared `fabro.postgres`
# interface only. The migration role owns the database and every object the
# schema-initialization step creates; the separate application role receives
# CONNECT, `public` schema USAGE, and the table/sequence DML the proxy needs,
# with no CREATE anywhere and no cluster-admin attribute. The interface cannot
# express a password, SUPERUSER, CREATEDB, or CREATEROLE.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The cluster's own client: `psql` and the server must come from the same
  # package so the script never talks to 18.6 through an older client.
  postgresql = config.services.postgresql.finalPackage;

  # LiteLLM's pinned proxy schema: the generated Prisma client and this init
  # step both read it from the same `litellm-db` closure.
  schemaPath = pkgs.litellm-db.passthru.schemaPath;

  viewsFile = ./postgres/litellm-views.sql;

  # The schema-initialization step, shared by the systemd unit and the
  # `litellm-db-init` repository check. `db push` applies the pinned schema as
  # the migration role without generating a client and never receives
  # `--accept-data-loss`, so a change that would drop data fails and prints
  # the diff. The cluster's own `psql` then creates or refreshes the eight
  # proxy views; `ON_ERROR_STOP=1` makes a failing statement fail the unit and
  # print the offending SQL. `--help` names both inputs for the check and an
  # operator.
  litellmDbInit = pkgs.writeShellApplication {
    name = "litellm-db-init";
    runtimeInputs = [ pkgs.coreutils ];
    text = ''
      usage() {
        cat <<'EOF'
      Usage: litellm-db-init [--help]

      Apply LiteLLM's pinned Prisma schema to the `litellm` database as
      `litellm_migrator`, then re-apply the proxy's eight views.

      Schema: ${schemaPath}
      Views:  ${viewsFile}
      EOF
      }

      if [ "''${1:-}" = "--help" ] || [ "''${1:-}" = "-h" ]; then
        usage
        exit 0
      fi
      if [ "''${#}" -ne 0 ]; then
        usage >&2
        exit 2
      fi

      echo "litellm-db-init: applying LiteLLM's Prisma schema"
      ${pkgs.litellm-prisma-cli}/bin/prisma db push --skip-generate --schema ${schemaPath}

      echo "litellm-db-init: applying the LiteLLM views"
      ${postgresql}/bin/psql -v ON_ERROR_STOP=1 -f ${viewsFile}
    '';
  };
in
{
  fabro.postgres = {
    databases.litellm.owner = "litellm_migrator";

    roles = {
      litellm_migrator.systemUser = "litellm-migrator";
      litellm_app.systemUser = "litellm";
    };

    # The application role's minimum proxy footprint: CONNECT on the database,
    # USAGE on schema `public`, read/write on every migration-created table and
    # view, and USAGE/SELECT on its sequences. The bootstrap and grant units
    # also revoke CREATE on the database and `public`, so the application role
    # cannot create, alter, or drop a persistent object.
    grants = [
      {
        database = "litellm";
        role = "litellm_app";
        privileges = [ "CONNECT" ];
        on = "database";
      }
      {
        database = "litellm";
        role = "litellm_app";
        privileges = [ "USAGE" ];
        on = "schema";
      }
      {
        database = "litellm";
        role = "litellm_app";
        privileges = [
          "SELECT"
          "INSERT"
          "UPDATE"
          "DELETE"
        ];
        on = "all-tables";
      }
      {
        database = "litellm";
        role = "litellm_app";
        privileges = [
          "USAGE"
          "SELECT"
        ];
        on = "all-sequences";
      }
    ];

    # `postgres-grants` runs after this unit, so the proxy receives the table
    # and sequence grants only once the migration role has created the schema.
    schemaInitUnits = [ "litellm-db-init.service" ];
  };

  users.groups.litellm = { };
  users.groups.litellm-migrator = { };

  users.users.litellm = {
    isSystemUser = true;
    group = "litellm";
    description = "LiteLLM proxy service account";
  };

  users.users.litellm-migrator = {
    isSystemUser = true;
    group = "litellm-migrator";
    description = "LiteLLM schema-initialization service account";
  };

  # Install the script as well as running it from the unit: `litellm-db-init`
  # stays importable by the `litellm-db-init` repository check (and runnable by
  # an operator), and the unit and the check execute the same store path.
  environment.systemPackages = [ litellmDbInit ];

  # The schema-initialization oneshot runs as the migration account after the
  # bootstrap unit has created the `litellm` database and both roles, and
  # before every unit that consumes the schema (the grant unit and the proxy).
  # It is a oneshot with `RemainAfterExit`, so a switch re-runs it only when
  # its configuration or dependencies change, and a failed Prisma or `psql`
  # invocation leaves the unit failed with the output in the journal. The
  # environment mirrors the design's unit matrix: Prisma connects through the
  # socket URL, `psql` through the `PG*` variables, and both use the pinned
  # engines from `litellm-prisma-engines` (never a download or a client
  # generation at run time).
  systemd.services.litellm-db-init = {
    description = "Initialize the LiteLLM database schema and views";
    wantedBy = [ "multi-user.target" ];
    requires = [ "postgres-bootstrap.service" ];
    after = [ "postgres-bootstrap.service" ];
    before = [ "postgres-grants.service" ];

    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      User = "litellm-migrator";
      Group = "litellm-migrator";
      ExecStart = lib.getExe litellmDbInit;
    };

    environment = {
      DATABASE_URL = "postgresql://litellm_migrator@localhost/litellm?host=/run/postgresql";
      PGHOST = "/run/postgresql";
      PGPORT = toString config.services.postgresql.settings.port;
      PGUSER = "litellm_migrator";
      PGDATABASE = "litellm";
      HOME = "/tmp";
      CHECKPOINT_DISABLE = "1";
      PRISMA_HIDE_UPDATE_MESSAGE = "1";
      PRISMA_SCHEMA_ENGINE_BINARY = "${pkgs.litellm-prisma-engines}/bin/schema-engine";
      PRISMA_QUERY_ENGINE_BINARY = "${pkgs.litellm-prisma-engines}/bin/query-engine";
      PRISMA_CLI_QUERY_ENGINE_TYPE = "binary";
    };
  };

  # The proxy runs as the fixed `litellm` account against the socket database.
  # It connects as `litellm_app` with peer authentication, so no password
  # appears in its environment or unit: the socket `host` parameter names the
  # cluster directory explicitly, and `PrivateUsers` must stay off or the peer
  # credentials would carry the namespace's UID instead of `litellm`. Schema
  # updates are disabled because the separate `litellm-db-init` unit owns
  # `prisma db push`; the proxy starts only after that unit and the grant unit
  # have succeeded, and only after the cluster itself is up.
  systemd.services.litellm = {
    requires = [
      "litellm-db-init.service"
      "postgres-grants.service"
      "postgresql.service"
      "postgresql-setup.service"
    ];
    after = [
      "litellm-db-init.service"
      "postgres-grants.service"
      "postgresql.service"
      "postgresql-setup.service"
    ];

    serviceConfig = {
      User = "litellm";
      Group = "litellm";
      DynamicUser = lib.mkForce false;
      PrivateUsers = lib.mkForce false;
    };
  };

  services.litellm = {
    package = pkgs.litellm-db;

    environment = {
      DATABASE_URL = "postgresql://litellm_app@localhost/litellm?host=/run/postgresql";
      DISABLE_SCHEMA_UPDATE = "true";
      PRISMA_QUERY_ENGINE_BINARY = "${pkgs.litellm-prisma-engines}/bin/query-engine";
    };
  };
}
