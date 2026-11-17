# `litellm-db-init`: the schema-initialization contract check
# (spec postgres-cluster-on-the-fabro-host-for-litellm-a, task 5.4;
# Requirements 5.6-5.10, 7.4, 7.5, 7.8, 7.12, 8.15).
#
# The check starts the guest's own PostgreSQL 18.6 package — the same
# `services.postgresql.finalPackage` with the three extension packages the
# guest runs — on a temporary Unix socket directory and a non-default port. It
# creates the declared `litellm` database and both roles, applies the guest's
# generated `fabro.postgres` bootstrap and grant SQL, and runs the installed
# `litellm-db-init` script twice. The second run must leave the catalog
# byte-identical, the application role must hold exactly the proxy's DML
# privileges, and a destructive fixture change must fail the script without
# dropping data.
#
# `flake.nix` passes the installed script and the guest's schema from
# `self.nixosConfigurations.fabro-vm`, so a script, schema, view, or grant
# change that leaves the guest fails this check. `run.sh` asserts, and
# `postgres-scratch/cluster.sh` owns the shared initdb/pg_ctl/socket helpers.
{
  pkgs,
  postgresql,
  litellmDbInit,
  litellmSchema,
  bootstrapSql,
  objectGrantsSql,
  databaseNames,
  roleNames,
}:
pkgs.runCommand "litellm-db-init"
  {
    nativeBuildInputs = [
      postgresql
      pkgs.bash
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.gnused
    ];

    # The guest's generated provisioning SQL, installed script, pinned schema,
    # and declared identities: the check applies and runs the identical store
    # paths the guest's units apply and run.
    BOOTSTRAP_SQL = "${bootstrapSql}";
    OBJECT_GRANTS_SQL = "${objectGrantsSql}";
    LITELLM_DB_INIT = "${litellmDbInit}";
    LITELLM_SCHEMA = "${litellmSchema}";
    DECLARED_DATABASES = pkgs.lib.concatStringsSep " " databaseNames;
    DECLARED_ROLES = pkgs.lib.concatStringsSep " " roleNames;

    PG_BINDIR = "${postgresql}/bin";
    CLUSTER_SH = "${../postgres-scratch/cluster.sh}";
  }
  ''
    if ! bash ${./run.sh}; then
      echo "litellm-db-init: the schema-initialization check failed" >&2
      exit 1
    fi
    touch "$out"
  ''
