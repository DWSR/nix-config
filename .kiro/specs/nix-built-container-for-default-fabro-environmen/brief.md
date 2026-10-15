# Brief: nix-built-container-for-default-fabro-environmen

## Problem

> As the operator of a Fabro environment, I want to have a container image defined in this repo that serves as the default sandbox environment so that I can use the same configuration management tooling for the sandbox environment as for the server itself.
>
> The image must:
>
> * include anything required for Fabro to run (e.g. Git) as well as Nix in order to allow Nix-based development environments to be executed inside of the sandbox.
> * be built using https://github.com/pdtpartners/nix-snapshotter to enable a future de-duplication of content between the container registry and the Nix store when a CRI-O driver is merged.
> * be loaded into the local Podman instance whenever its contents change (no pushing to a registry)
> * be reproducible
>
> Fabro must be configured to:
>
> * refer to the built image by checksum rather than a mutable tag
> * re-configured to refer to a new checksum whenever the image contents change
> * configure the environment with access to the host's nix store/nix daemon to reuse its contents between invocations

The `fabro-vm` guest is the operator's Fabro host, but its default sandbox is still Fabro's seeded upstream image. Sandbox tooling therefore diverges from the Nix-managed guest, and Nix-based development environments cannot run inside the sandbox.

## Current State

- Fabro runs as a systemd service on the NixOS guest `fabro-vm` (`configurations/fabro-vm/fabro.nix`); Podman serves the Docker API at `/run/docker.sock`, and `server.sandbox.providers.docker` is enabled (`default.nix`).
- `run.environment.id = "default"` selects the server-managed `default` environment. Fabro seeds it as `buildpack-deps:noble`: no Nix, no guaranteed Git, pulled from Docker Hub on first use.
- No sandbox image is defined in this repo; the flake has no `nix-snapshotter` input and no OCI image derivation.
- Sandbox containers do not see the guest's `/nix/store` or Nix daemon.
- Server-managed environments live in Fabro's SQLite catalog on the `/var/lib/fabro` state share and are managed through `/api/v1/environments`; `settings.toml` `[environments.*]` is an import layer over that catalog.

## Desired Outcome

- A sandbox image derivation defined in this repo, built with `nix-snapshotter`, providing `/bin/bash`, Git, coreutils, and Nix.
- The image is a pure, pinned Nix derivation, so identical inputs reproduce the same image and digest.
- Each guest switch loads the image into the local Podman store when its contents change; nothing is pushed to a registry.
- Fabro's `default` environment references the image by digest, and a rebuild that changes the image updates that digest.
- Sandbox containers reach the guest's Nix store and daemon, so Nix-based environments reuse store paths instead of building a second store.

## Approach

- Build the image with `pkgs.nix-snapshotter.buildImage` as an `aarch64-linux` derivation: `copyToRoot` carries bash, git, coreutils, and nix, and `config` sets image metadata (working directory, PATH). A companion Nix derivation extracts the manifest digest from the produced OCI archive.
- Add `nix-snapshotter` as a pinned flake input following nixpkgs. The image is `aarch64-linux`, so it builds on the guest's own Nix; the macOS host has no Linux builder, mirroring `fabro-vm-image`.
- A guest systemd oneshot loads the archive into Podman. Its `ExecStart` embeds the archive's store path, so a contents change rewrites the unit and reloads the image on switch.
- Declare the digest in the guest's Fabro settings and reconcile the persisted `default` environment to it through `/api/v1/environments/default` (GET the revision, then an idempotent PUT) on every switch; a persisted catalog is not updated by a rebuild alone.
- Give sandbox containers the host Nix store through the container engine, not Fabro: Podman `containers.conf` `[containers] mounts` bind-mounts `/nix/store` read-only and `/nix/var/nix/daemon-socket` into every container. Fabro's environment schema has no mount field, so this is the only repo-owned seam.
- Keep a local tag for storage; Fabro resolves the immutable digest.

## Scope

- **In**: `nix-snapshotter` flake input and image derivation; image contents (bash, git, coreutils, nix); digest derivation; the guest systemd load unit; `default`-environment digest wiring and reconciliation; Podman default Nix-store/daemon mounts; eval checks and a runtime smoke check.
- **Out**: CRI-O/containerd driver integration and registry-store dedup; any registry push; per-workflow or additional environments; Daytona and other providers; the `fabro-vm-image` boot image; replacing Podman; sandbox network policy.

## Boundary Candidates

- Image contents and the nix-snapshotter build (the derivation and its config).
- Image publication: load unit, change detection, local Podman storage.
- Digest computation and Fabro environment wiring/reconciliation.
- Host Nix store and daemon sharing at the container-engine layer.
- Verification: eval assertions and an end-to-end sandbox smoke check.

## Out of Boundary

- De-duplicating registry and Nix store content (the future CRI-O driver).
- Sandbox hardening or network isolation; the Nix daemon is exposed to sandboxed agents by design.
- GC interaction: host GC can remove a store path a sandbox still needs.
- Fabro upgrades beyond the pinned `0.386.0-nightly.0`.

## Upstream / Downstream

- **Upstream**: the `fabro-vm` guest config (Podman, Fabro settings, systemd), the fabro overlay, `nix-snapshotter` and its pinned flake input, and the guest-side Nix builder.
- **Downstream**: workflow authors and `run.environment.id = "default"` consumers, who gain a Nix-capable sandbox; a future CRI-O spec that can drop the embedded layers.

## Existing Spec Touchpoints

- **Extends**: none.
- **Adjacent**: `local-binary-cache` (Nix store retention, unrelated mechanism); the `fabro-vm` work, which shipped by direct commits rather than a spec.

## Constraints

- `aarch64-linux` only; the image cannot build on the macOS host.
- Fabro's environment schema has no mount field, so host-store sharing must be engine-level.
- The `default` environment is persisted SQLite state; a settings declaration alone does not guarantee the digest tracks a rebuild.
- `nix-snapshotter` is a containerd plugin; today its output is loaded as an OCI archive, and its dedup value is deferred.
- The image must provide `/bin/bash`; Fabro has no `sh` fallback.
- Pin the `nix-snapshotter` input and the image tag; reproducible digests require normalized OCI timestamps.
