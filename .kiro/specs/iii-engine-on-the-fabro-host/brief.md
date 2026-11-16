# Brief: iii-engine-on-the-fabro-host

## Problem

> As an agentic developer, I want to experiment with moving from Fabro to iii as a workflow engine so that I can have more control over my software factory.
>
> Requirements:
>
> * A package for the iii engine must be created that support aarch64-linux and aarch64-darwin
> * Packages for the "official" workers from the iii-hq/workers repository must be created that support aarch64-linux and aarch64-darwin
> * The iii engine must be installed declaratively via the package
> * The iii engine must run as a DynamicUser
> * The iii engine must be run with no workers declared in its configuration
> * The iii engine must be run using systemd
> * The iii engine must only listen on loopback
> * The iii engine must be served over Tailscale as `svc:iii`

The software factory runs on the Fabro host, but iii exists in this repository only as an
AgentMemory dependency: a Darwin-only, version-pinned engine. Evaluating iii there today means
hand-downloading Linux binaries and hand-writing a unit, so the experiment cannot be reproduced
from the Nix configuration or survive a VM rebuild.

## Current State

- The Fabro host is `nixosConfigurations.fabro-vm` (`flake.nix:3922`), a NixOS Lima guest composed
  from `configurations/fabro-vm/`: fabro, LiteLLM, OpenCode, API bridge, sandbox, and Tailscale.
- `overlays/agentmemory.nix` defines `pkgs.iii-engine` as iii 0.11.5 from GitHub release tarballs,
  restricted to `aarch64-darwin` and `x86_64-darwin`. `home-manager/common/agentmemory.nix:20`
  adds it to AgentMemory's runtime PATH, and `flake.nix:1854` uses it in the AgentMemory host
  matrix check.
- No Linux engine package, worker package set, systemd unit, engine configuration, or `svc:iii`
  exists. The only other iii references are the total-recall spec, which expects iii 0.24 on the
  same guest.
- `configurations/fabro-vm/tailscale.nix:64` advertises the existing applications as Tailscale
  Services through one `tailscale serve --service=...` oneshot; all handlers proxy a loopback HTTP
  listener at `--https=443`.
- iii 0.26.0 is the current stable engine. Official workers publish per-target binary tarballs
  through the workers registry; the `iii-hq/workers` GitHub releases attach no worker assets.

## Desired Outcome

- `pkgs.iii-engine` is iii 0.26.0 and evaluates/builds on both `aarch64-linux` and
  `aarch64-darwin`.
- `pkgs.iii-workers.<name>` provides every official native-binary worker that publishes both
  required targets: 73 of the 76 official binary workers today.
- `nixos-rebuild switch` on the guest installs the engine through `environment.systemPackages` and
  starts `iii.service` as a `DynamicUser` from the store binary.
- The running engine advertises zero project workers and its only listener is
  `127.0.0.1:49134`.
- The guest advertises `svc:iii` at `https=443` to that loopback listener, so tailnet clients reach
  the engine as `wss://iii.tuxedo-musical.ts.net`.
- `nix flake check` asserts the package platforms, the 73-worker catalog, the unit's
  `DynamicUser`/state/config, the absence of non-loopback binds, and the `svc:iii` Serve entry.

## Approach

Own the packaging and the deployment wiring in this repository; upstream ships release binaries
but no Nix package, NixOS module, or stable flake.

- Add `overlays/iii.nix` exporting `iii-engine` from the 0.26.0 release tarballs (single `iii`
  binary, `aarch64-linux` glibc and `aarch64-darwin` assets, digest-pinned) and `iii-workers`, a
  manifest-driven package set built by one generic derivation from the registry's immutable
  per-target tarball URL + SHA-256 pairs.
- Rename the existing Darwin-only derivation to `agentmemory-iii-engine` and update its two
  consumers, freeing the `iii-engine` attribute for the current engine without changing
  AgentMemory's runtime version.
- Add `configurations/fabro-vm/iii.nix`, imported from `configurations/fabro-vm/default.nix`,
  rendering a YAML config with `iii-worker-manager` bound to `127.0.0.1:49134` and no project
  workers, then running `iii --config <store path> --no-update-check` with
  `DynamicUser = true`, a `StateDirectory`, and the guest's existing hardening style.
- Add `iii-engine` to the guest's `environment.systemPackages` and add an `svc:iii` handler to the
  existing `tailscale-serve` oneshot.
- Extend the `fabro-vm-guest-eval` assertion chain and add package-level checks for both systems.

The config's single `workers:` entry is an engine-lifecycle listener, not a project worker: iii
0.26 refuses project workers in `config.yaml` (`UNSUPPORTED_CONFIG_WORKERS`) and its worker
manager defaults to `0.0.0.0:49134`, so the loopback requirement is only expressible through that
entry. With the entry present, the project-worker list is empty.

Rejected: the install script or `iii compose`/`compose::add` — both download and mutate state
imperatively, which breaks reproducibility and the no-workers requirement; sourcing workers from
GitHub releases — those releases carry no assets; running the engine as root or the cidata user —
the issue requires `DynamicUser` and the engine needs no virtiofs share; enabling the deprecated
`iii-stream` worker — it adds a second listener and defaults to a non-loopback bind.

## Scope

- **In**: iii 0.26.0 engine package for `aarch64-linux` and `aarch64-darwin`; the 73-worker
  package set with a pinned manifest; the `agentmemory-iii-engine` rename and its two consumers;
  the guest systemd unit, rendered configuration, state directory, and package install; the
  `svc:iii` Serve entry; package, render, and guest-eval checks.
- **Out**: starting, composing, or configuring any worker; the 8 official JavaScript bundles; the 3
  binary workers that lack one required target (`harness-e2e`, `voice`, `ios-simulator`); the
  `registry-cli` executable and the 4 engine-kind registry entries; Fabro-to-iii workflow
  migration; Darwin launchd services; `x86_64` targets; automatic version bumps.

## Boundary Candidates

- Engine artifact package and its version/digest metadata.
- Worker catalog: manifest data and the generic per-worker derivation.
- AgentMemory pin migration to a distinct attribute.
- Guest unit and configuration rendering (identity, state, listeners).
- Tailscale Service exposure.
- Verification: package checks, config render assertions, guest eval assertions.

## Out of Boundary

- Worker lifecycle orchestration (`worker-compose.yaml`, the Compose daemon, `iii compose`).
- Per-worker configuration, secrets, databases, queues, and cron schedules.
- Creating the `svc:iii` Service, tailnet ACLs, DNS, certificates, and device approval.
- iii authentication, RBAC, TLS termination, or exposure beyond the tailnet.
- Replacing Fabro, porting workflows, or running iii on the Darwin workstations as a service.

## Upstream / Downstream

- **Upstream**: iii 0.26.0 GitHub release assets, the workers registry API and its CDN digests,
  nixpkgs, the Lima guest image, and the open-source `tailscaled` on the guest.
- **Downstream**: `install-total-recall-on-fabro-vm` (its iii 0.24 pin and worker set must move to
  this engine and catalog), future worker-deployment specs, a Fabro-to-iii migration, and Darwin
  worker services.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `install-total-recall-on-fabro-vm` (expects guest iii 0.24 plus database, queue, and
  cron workers); `agentmemory-opencode-migration` and the AgentMemory runtime (pin iii 0.11.5);
  `install-rex-in-fabro-vm` and `personal-tailscale-service` (guest module and Serve patterns);
  `postgres-cluster-on-the-fabro-host-for-litellm-a` (future database-worker backend).

## Constraints

- The engine is pinned to 0.26.0; every cataloged worker must declare engine compatibility with
  0.26.0 and publish `aarch64-unknown-linux-gnu` and `aarch64-apple-darwin` artifacts.
- All artifacts come from immutable URLs pinned by SHA-256 in the repository; builds and evals do
  no downloading of unpinned versions and never run the iii installer.
- iii 0.26 permits only engine-lifecycle workers in `config.yaml`; project workers belong in
  worker-compose and none are declared here.
- The worker manager must bind `127.0.0.1:49134`; `iii-stream` stays disabled; no listener may
  bind `0.0.0.0` or a tailnet address.
- `DynamicUser` cannot write the Lima virtiofs share, so runtime state lives in a systemd
  `StateDirectory` and the config is a read-only store path.
- No iii secrets are required. The tailnet ACL is the only access boundary; `svc:iii` must already
  exist in the admin console for the Serve oneshot to advertise it.
- The AgentMemory runtime keeps iii 0.11.5 and its `iiiVersion`/`iiiRevision` passthru metadata;
  only the attribute name changes.
