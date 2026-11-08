# Brief: create-a-linux-nix-remote-builder-instance

## Problem

> As a Nix user, I want a Linux remote builder available for all my Nix instances so that Nix derivations targeting multiple architectures are able to be built as expected.
>
> This spec must:
>
> * create a Nix flake for a NixOS-based host that will be used as a remote builder
> * update the configuration for the Fabro and Brandons-MacBook-Pro hosts to target the new Linux builder
> * update the configuration for the Fabro host to disallow local builds in favour of always using the build target
>
> The Linux builder must:
>
> * run NixOS
> * be provisioned as a 4 core, 8 GB Lima VM with 128GB disk space in a similar fashion to other VMs
> * Not be strongly coupled to Lima features, similar to other VMs

Fabro workloads and the repository's NixOS guest need Linux derivations, but no Linux remote builder is configured. As a result, Linux builds run on the Fabro host itself, while the personal Mac's configured remote builder serves Darwin derivations only.

## Current State

- `nixosConfigurations.fabro-vm` is the repository's NixOS `aarch64-linux` guest. Its Nix settings do not configure a Linux build machine or disable local builds.
- `configurations/personal/home-manager/default.nix` manages the Fabro guest as a Lima VM, and `home-manager/common/lima-vm.nix` provides a launchd lifecycle and NixOS guest deployment pattern.
- `Brandons-MacBook-Pro` is a Darwin flake host. Its common Nix settings target the separate `mac-builder` for `aarch64-darwin`; no Linux builder is configured.
- The `mac-builder` Nix-darwin configuration and Fabro's Darwin dispatch provide the existing Darwin build path; they do not serve `aarch64-linux` builds.

## Desired Outcome

- A flake-declared NixOS `aarch64-linux` host is available as a remote builder.
- The personal host provisions it as a Lima VM with 4 CPUs, 8 GiB memory, and a 128 GiB disk, using the repository's existing VM lifecycle conventions.
- The Fabro and `Brandons-MacBook-Pro` Nix configurations can dispatch `aarch64-linux` builds to this builder.
- Fabro does not perform local builds; its Linux builds use the configured remote target.
- The existing `aarch64-darwin` builder remains available for Darwin derivations.

## Approach

- Declare the builder as a regular NixOS `aarch64-linux` flake configuration so its OS configuration is reusable outside Lima. Keep VM sizing, image provisioning, and Lima lifecycle in the personal-host configuration.
- Configure the Fabro guest and personal Mac to use the Linux builder for `aarch64-linux` builds. Set Fabro's local job limit to zero so builds for the configured target are not built locally; preserve the separate Darwin builder for Darwin derivations.
- Add configuration checks for the builder host, Lima resource settings, both clients' Linux builder wiring, and Fabro's no-local-build policy.

## Scope

- **In**: A NixOS `aarch64-linux` builder flake output; Lima VM provisioning with the specified resources; client builder configuration for `fabro-vm` and `Brandons-MacBook-Pro`; disabling local builds on Fabro; evaluation and configuration validation.
- **Out**: Changes to the existing macOS Darwin builder or Darwin dispatch behavior; `x86_64-linux`, additional builder architectures, and builder pools; unrelated Fabro services, sandbox behavior, or binary-cache policy.

## Boundary Candidates

- Reusable NixOS Linux builder configuration and its flake output.
- Personal-host Lima definition, resource allocation, and lifecycle.
- Nix remote-build configuration on Fabro and the personal Mac.
- Validation of host configuration, VM resources, and build dispatch policy.

## Out of Boundary

- Replacing the existing `mac-builder` or changing its `aarch64-darwin` role.
- Changes to the personal host's local binary cache or its distributed-build invariant.
- Non-Linux build targets, Linux cross-compilation, and build scheduling across multiple Linux machines.
- Broader changes to VM management or provisioning outside this builder.

## Upstream / Downstream

- **Upstream**: `nixosConfigurations.fabro-vm`, the personal host's `virtualisation.limaVM` lifecycle, Nix remote-builder settings, and the existing Darwin builder configuration.
- **Downstream**: Fabro workflows and repository checks that build `aarch64-linux` derivations, which can use the remote builder instead of consuming Fabro's local build resources.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `mac-nix-remote-builder` defines the separate Darwin builder host; `mac-builder-for-fabro-nix-darwin-builds` wires Fabro's Darwin dispatch. Preserve their `aarch64-darwin` behavior. The NixOS Lima guest and sandbox specs remain adjacent and out of scope.

## Constraints

- The Linux builder targets `aarch64-linux`, matching Fabro's existing NixOS platform and Lima's native Apple Silicon VM architecture.
- The Lima guest must receive 4 CPUs, 8 GiB memory, and 128 GiB disk.
- Keep NixOS guest configuration independent of Lima-specific boot and provisioning behavior.
- Fabro must not fall back to local Linux builds; keep the existing remote Darwin build path intact.
