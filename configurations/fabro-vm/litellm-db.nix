# The fixed system accounts for the LiteLLM database wiring.
#
# `litellm` runs the proxy and `litellm-migrator` runs the schema
# initialization; peer authentication over the Unix socket maps each account
# to its own database role with no stored credential. Both are plain system
# accounts in their matching groups: no DynamicUser, no privileged
# supplementary group, and no workload unit on the `postgres` account.
_: {
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
