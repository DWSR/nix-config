# `postgres-scratch`: the scratch-cluster contract check
# (spec postgres-cluster-on-the-fabro-host-for-litellm-a, task 5.3;
# Requirements 2.8, 3.3, 3.4, 3.6, 4.6, 4.7, 8.10-8.15).
#
# The check starts the guest's own PostgreSQL 18.6 package — the same
# `services.postgresql.finalPackage` with the three extension packages the
# guest runs — on a temporary Unix socket directory and a non-default port. It
# proves the socket-only and extension contract against a real server, then
# applies the guest's generated `fabro.postgres` bootstrap and grant SQL twice
# against the declared fixture databases and roles and compares the schemas.
#
# `flake.nix` passes the generated SQL and the declared names from
# `self.nixosConfigurations.fabro-vm`, so an extension or declaration that
# leaves the guest fails this check; `run.sh` asserts, and `cluster.sh` owns
# the initdb/pg_ctl/socket/TCP helpers.
{
  pkgs,
  postgresql,
  bootstrapSql,
  objectGrantsSql,
  databaseNames,
  roleNames,
}:
pkgs.runCommand "postgres-scratch"
  {
    nativeBuildInputs = [
      postgresql
      pkgs.bash
      pkgs.coreutils
      pkgs.diffutils
      pkgs.gnugrep
      pkgs.gnused
    ];

    # The guest's generated provisioning SQL and declared identities: the check
    # applies the identical files the provisioning units apply and creates the
    # same databases and roles `postgresql-setup` would create.
    BOOTSTRAP_SQL = "${bootstrapSql}";
    OBJECT_GRANTS_SQL = "${objectGrantsSql}";
    DECLARED_DATABASES = pkgs.lib.concatStringsSep " " databaseNames;
    DECLARED_ROLES = pkgs.lib.concatStringsSep " " roleNames;

    PG_BINDIR = "${postgresql}/bin";
    CLUSTER_SH = "${./cluster.sh}";
  }
  ''
    if ! bash ${./run.sh}; then
      echo "postgres-scratch: the scratch-cluster check failed" >&2
      exit 1
    fi
    touch "$out"
  ''
