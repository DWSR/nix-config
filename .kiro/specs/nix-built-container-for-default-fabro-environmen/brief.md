# Brief: nix-built-container-for-default-fabro-environmen

## Problem
> As the operator of a Fabro environment, I want to have a container image defined in this repo that serves as the default sandbox environment so that I can use the same configuration management tooling for the sandbox environment as for the server itself. The container image should include anything required for Fabro to run (e.g. Git) as well as Nix in order to allow Nix-based development environments to be executed inside of the sandbox.

The operator of the `fabro-vm` guest runs Fabro workflows whose nodes execute inside a Docker sandbox. That sandbox uses Fabro's seeded `buildpack-deps:noble` image, which this repo does not define: the sandbox toolchain drifts from the server's, cannot be reproduced from the flake, and has no Nix, so Nix-based development environments cannot run inside a sandbox.

## Current State
- Fabro runs on the `fabro-vm` NixOS guest (`configurations/fabro-vm/`), which enables `virtualisation.docker` and `server.sandbox.providers.docker` (`fabro.nix`).
- `fabroSettings` sets `run.environment.id = "default"`; Fabro's install seeds `default` as a persisted docker environment with `image.docker = "buildpack-deps:noble"` (CPU 2, memory 4GB). Nothing in this repo overrides it.
- The guest service PATH ships `git`, `coreutils`, `curl`, and `jq` (`configurations/fabro-vm/fabro.nix`); the guest's OpenCode service ships `nix` (`configurations/fabro-vm/opencode.nix`). These are host services, not the Fabro sandbox image.
- The repo builds a qcow-efi VM image (`configurations/fabro-vm/image.nix`, `packages.aarch64-linux.fabro-vm-image`) but defines no OCI/container image and no Docker-load step.
- Fabro's docker provider honors only `image.docker` (a prebuilt image reference) and ignores `image.dockerfile`.

## Desired Outcome
- A Nix-built `aarch64-linux` container image, defined in this repo, shipping what Fabro needs to execute a run in a sandbox — `/bin/bash`, `git`, `coreutils`, `curl`, `jq`, CA certificates — plus a working Nix.
- The guest's Docker holds that image under a stable tag; Fabro's `default` environment references the tag, so every new run uses the repo-built sandbox with no manual step.
- The image rebuilds from the same flake/nixpkgs as the server and reloads on deploy, so the sandbox and server share one configuration-management toolchain.

## Approach
Define the image with `pkgs.dockerTools.buildImage` (or `buildLayeredImage`) as an `aarch64-linux` flake package referenced from the `fabro-vm` configuration, load it into the guest Docker from a systemd oneshot (`docker load` + `docker tag`), and point Fabro's `default` environment at the tag by declaring `[environments.default]` (`provider = "docker"`, `image.docker = "<tag>"`) in the generated `fabroSettings` `settings.toml`.

Rejected alternatives:
- **Pull a prebuilt image from a registry**: adds a publish/pull dependency and an external artifact for a single self-hosted guest; the issue asks for the image to be defined in this repo with the same Nix tooling.
- **Keep `buildpack-deps:noble` and add Nix via a Dockerfile**: Fabro's docker provider ignores `image.dockerfile`; only a prebuilt image reference is used.

## Scope
- **In**: the Nix OCI image definition and its `aarch64-linux` flake package; the bash/PATH/ENV contract the image must satisfy; inclusion of Nix in the image; the guest Docker load/tag mechanism; the declarative `default`-environment wiring to the image tag; and verification that a run uses the image and that Nix works inside it.
- **Out**: any non-default environment or catalog entry; publishing the image to a remote registry; changing Fabro's provider selection, resources, or network policy; the server and OpenCode host packages; and defining specific Nix dev shells.

## Boundary Candidates
- **Image definition**: base packages, bash/PATH/ENV contract, Nix inclusion and its store/daemon model, tag/name, and architecture.
- **Image delivery**: how the derivation reaches the guest Docker (build in-guest vs a Linux builder), the load/tag service, and store/GC retention.
- **Environment wiring**: how `default` is pointed at the tag, and which provider/resource/network fields the catalog carries.
- **Verification**: how a run is shown to use the image and how Nix execution inside a sandbox is proven.

## Out of Boundary
- Per-language or per-project sandbox images.
- A remote container registry or multi-host image distribution.
- Fabro sandbox network isolation policy beyond the existing `allow_all` default.
- Redefining Fabro's agent tools or the OpenCode host environment.

## Upstream / Downstream
- **Upstream**: `configurations/fabro-vm/` (`fabro.nix` `fabroSettings`, `default.nix` Docker enablement), `overlays/fabro.nix`, `flake.nix` (`nixosConfigurations.fabro-vm`, `packages.aarch64-linux`), `pkgs.dockerTools`, and Fabro's environments feature and docker provider.
- **Downstream**: additional repo-defined environments, per-run environment overrides, and future sandbox images that extend this one.

## Existing Spec Touchpoints
- **Extends**: none.
- **Adjacent**: `opencode-nono-sandbox` (mac OpenCode sandboxing; different host and mechanism); `docs/opencode-fabro-vm-handoff.md` (the guest service layout this image complements).

## Constraints
- `aarch64-linux` only: the VZ guest is native-arm64 and the image must match.
- No Linux builder on the mac; the image builds in-guest during `lima-vm-deploy`/`nixos-rebuild`.
- Fabro evaluates every sandbox command with `/bin/bash` in a non-login shell, so the image must provide `/bin/bash` and bake `PATH`/`ENV` into its config.
- Fabro's docker environment schema exposes no volume mounts, so Nix must function inside the container without host bind mounts.
- Fabro must honor `[environments.default]` from `settings.toml` on every server start (fabro `0.386.0-nightly.0`); the design verifies this because the environment catalog otherwise persists in SQLite.
- Declarative through Nix; no imperative image build as the source of truth.
