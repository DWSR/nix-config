# Negative evaluation fixture for the combined Linux remote-builder check.
# Applying it with a non-default argument defeats Fabro's no-local-build policy:
#
#   import ./fabro-policy.nix { maxJobs = 2; }
{
  maxJobs ? 0,
}:
{ lib, ... }:
{
  nix.settings.max-jobs = lib.mkForce maxJobs;
}
