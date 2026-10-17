# Brief: mac-nix-remote-builder

## Problem

> As a Nix user, I want a Nix configuration defined for a MacOS machine that is dedicated to Nix remote builds for darwin aarch64 so that agents making updates to configurations in this repository are able to natively build derivations for this platform and architecture.
>
> The initial target will be a Lima VM running macOS hosted by the personal host in lieu of dedicated Apple hardware.
>
> The host configuration must:
> - Not be strongly coupled to Lima implementation details (such as how it skips First Run Experience)
> - Include all software packages and configuration required to fully setup the host
> - Use sops-nix for secrets
> - Be "one touch" for setup (e.g. a single shell script to deploy)
> - Require nothing shared from the host (assumption is that the host will be on dedicated hardware eventually)
> - Use a dedicated non-privileged user for the nix builder
>
> The personal host configuration must:
> - Use Lima with the latest released version of macOS
> - have launchd services to manage the VM lifecycle

The repository's agents run on `aarch64-linux` (the fabro-vm guest and its sandbox),
so nothing in the current build path can produce `aarch64-darwin` derivations. The
only darwin hosts are interactive laptops, and neither is declared as a builder.

## Current State

- The flake exposes exactly one `darwinConfigurations` entry,
  `Brandons-MacBook-Pro` (flake.nix), and one NixOS guest,
  `nixosConfigurations.fabro-vm`. No darwin builder host exists.
- `home-manager/common/lima-vm.nix` manages a single Lima instance on the personal
  host: rendered YAML, a `limactl start --foreground` launchd supervisor, a
  `lima-vmctl` wrapper, and a tar-over-SSH `lima-vm-deploy`. It is NixOS-specific:
  it defaults to the pinned `nixos-lima` release images, injects a podman-group and
  hostname `provision`, and deploys with `nixos-rebuild switch`. It has no macOS
  guest mode.
- No darwin remote-builder endpoint exists anywhere: no dedicated builder user, no
  builder SSH trust, and no `nix.buildMachines`. `local-binary-cache` asserts
  `nix.distributedBuilds = false` wherever its publisher is enabled, so the personal
  host cannot itself be the client.
- sops-nix per-host stores exist (`.sops.yaml`, `secrets/*.yaml`, per-host age
  recipients), but no builder-host recipient or store.
- A prior `shopify-remote-builder` spec (since removed) delegated laptop builds to
  the personal host over `ssh-ng://`; it was client-side delegation, not a
  dedicated darwin builder host, and is not this feature.

## Desired Outcome

A macOS `aarch64-darwin` machine, running as a Lima macOS guest on the personal
host, is declared by a self-contained nix-darwin configuration that installs and
configures everything it needs, takes its secrets from sops-nix, runs its Nix
daemon behind a dedicated non-privileged builder user, and is set up by one deploy
command against a fresh macOS with no files shared from the personal host. The
personal host owns the Lima macOS guest and keeps it running through launchd. The
builder exposes a standard Nix remote-builder endpoint that a client can adopt
without custom code.

## Approach

Add a `darwinConfigurations.<builder>` host configuration for the macOS machine. It
is Lima-agnostic: it declares users, packages, OpenSSH, Nix daemon trust, and GC,
and receives its secrets from a builder-host sops-nix store. A dedicated
non-privileged user is the SSH identity the builder daemon accepts builds from.

Manage the builder as a second Lima instance on the personal host, reusing the
existing launchd lifecycle pattern from `virtualisation.limaVM`. The macOS-specific
Lima YAML and boot provisioning — including the First Run Experience skip the issue
calls out — live in the personal-host configuration, never in the guest's nix-darwin
configuration.

Ship a single one-touch deploy shell application that bootstraps Nix on a fresh
macOS and applies the host configuration over SSH, streaming the repository the way
`lima-vm-deploy` streams into the NixOS guest, so the host shares nothing from the
personal host. Clients reach the builder as an ordinary `ssh-ng://` remote store;
wiring a specific client (the fabro-vm agent environment) is a downstream concern.

## Scope

- **In**: The macOS builder's nix-darwin configuration (packages and settings
  required to fully set up the host); the dedicated non-privileged builder user and
  its SSH access plus host-key trust; Nix daemon settings that let the host serve
  `aarch64-darwin` remote builds; a builder-host sops-nix secret store; the
  personal-host Lima macOS guest definition (latest released macOS) and its launchd
  lifecycle; the one-touch deploy/bootstrap script; render/eval tests and a
  readiness smoke check.
- **Out**: Client or agent consumption wiring (`nix.buildMachines` on the fabro-vm,
  its sandbox, or CI); binary-cache serving, substitution, GC, and publication
  (`local-binary-cache` owns those); dedicated Apple hardware imaging; changes to the
  existing NixOS fabro Lima instance; `x86_64` or other foreign-architecture
  builders; Apple ID or licensing automation beyond what guest boot requires.

## Boundary Candidates

- Builder host nix-darwin configuration and packages.
- Personal-host macOS Lima guest definition and lifecycle.
- One-touch deploy/bootstrap for a fresh macOS host.
- Builder access and trust: dedicated user, SSH, daemon trust, host keys.
- sops-nix secret delivery for the builder host.
- Declarative validation and runtime readiness checks.

## Out of Boundary

- `nix.buildMachines` and any other client-side dispatch configuration.
- Global distributed builds on the personal host; its cache-publisher assertion
  stays intact.
- Replacing or reconfiguring Attic, substituters, or retention.
- Making the builder a public or tailnet-wide service beyond its LAN/VM endpoint.
- Guaranteeing a future move to dedicated Apple hardware; only the Lima-agnostic
  host configuration is in scope.

## Upstream / Downstream

- **Upstream**: the `virtualisation.limaVM` launchd lifecycle and rendered-YAML
  patterns, nix-darwin, sops-nix per-host stores, the personal host's Apple Silicon
  and Virtualization.framework, and `local-binary-cache` substituters.
- **Downstream**: agent/client `nix.buildMachines` wiring in the fabro-vm or its
  sandbox, repository checks that build darwin derivations, and eventual dedicated
  Apple hardware deployment.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `local-binary-cache` (substituters, GC, and the
  `nix.distributedBuilds = false` publisher assertion); the fabro-vm specs
  (`nix-built-container-for-default-fabro-environmen`) whose guest and sandbox are
  the likely future client; `personal-tailscale-service` for exposure patterns (the
  builder stays LAN/VM-local); the removed `shopify-remote-builder` as a
  client-delegation precedent.

## Constraints

- `aarch64-darwin` only; the builder architecture must match the target.
- Lima's macOS guest support is newer than its Linux guest path and requires the VZ
  driver on Apple Silicon plus a macOS image; pin the Lima version and the macOS
  release, using the latest released macOS per the issue.
- The guest's nix-darwin configuration must not encode Lima specifics (image
  provisioning, First Run Experience skip, virtiofs); those belong to the
  personal-host configuration.
- The one-touch deploy must run against a fresh macOS with no preinstalled Nix and
  no files shared from the personal host.
- Secrets come from sops-nix to runtime paths; no secret value enters the Nix store.
- The builder user is non-privileged; the client gets no admin or root access.
- The builder must speak the standard Nix remote-builder protocol (`ssh-ng://`) so
  clients need no custom integration.
