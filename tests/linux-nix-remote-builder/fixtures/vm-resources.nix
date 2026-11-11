# Negative evaluation fixture for the combined Linux remote-builder check.
# Applying it with one non-default argument perturbs exactly that personal-host
# Lima resource:
#
#   import ./vm-resources.nix { cpus = 2; }
#   import ./vm-resources.nix { memory = "4GiB"; }
#   import ./vm-resources.nix { disk = "64GiB"; }
{
  cpus ? 4,
  memory ? "8GiB",
  disk ? "128GiB",
}:
{ lib, ... }:
{
  home-manager.users.brandonmcnama.virtualisation.limaLinuxBuilder = {
    cpus = lib.mkForce cpus;
    memory = lib.mkForce memory;
    disk = lib.mkForce disk;
  };
}
