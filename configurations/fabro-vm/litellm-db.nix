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
_: {
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
}
