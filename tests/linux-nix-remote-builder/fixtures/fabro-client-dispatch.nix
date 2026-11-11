# Negative evaluation fixture for the combined Linux remote-builder check.
# Applying it with a non-default argument perturbs one Fabro Linux route field:
#
#   import ./fabro-client-dispatch.nix { system = "aarch64-darwin"; }
#   import ./fabro-client-dispatch.nix { hostName = "linux-builder.example.ts.net"; }
#   import ./fabro-client-dispatch.nix { maxJobs = 3; }
#   import ./fabro-client-dispatch.nix { clientKeyPath = "/tmp/linux-builder-client-key"; }
{
  system ? "aarch64-linux",
  hostName ? "linux-builder.tuxedo-musical.ts.net",
  maxJobs ? 4,
  clientKeyPath ? "/run/secrets/linux-builder-client-key",
}:
{ lib, ... }:
{
  fabro.darwinBuilder.linuxMachine = {
    system = lib.mkForce system;
    hostName = lib.mkForce hostName;
    maxJobs = lib.mkForce maxJobs;
  };
  fabro.darwinBuilder.linuxClientKeyPath = lib.mkForce clientKeyPath;
}
