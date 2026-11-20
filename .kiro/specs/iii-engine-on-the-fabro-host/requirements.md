# Requirements Document

## Introduction

This feature gives the Fabro guest a fresh, pinned iii 0.26.0 engine package and a package catalog of the official iii binary workers, then installs and supervises the engine as a loopback-only systemd service published to the tailnet as `svc:iii`. See `brief.md` for the problem statement, approach, and scope constraints.

## Boundary Context

- **In scope**: the fresh `iii` 0.26.0 engine package and the `iii-workers` package set for `aarch64-linux` and `aarch64-darwin`; the pinned worker manifest; the guest's declarative engine install, systemd service, rendered configuration, and state directory; the `svc:iii` Serve advertisement; and the evaluated package, render, and guest checks.
- **Out of scope** (delta from `brief.md`): installing any cataloged worker on the guest or any other host; Home Manager or launchd wiring for the engine or workers on the Darwin workstations; a per-worker Tailscale Service or Serve handler; engine data migration, backup, or capacity planning; and worker-manager tuning beyond its loopback listen address.
- **Adjacent expectations**: the `svc:iii` Tailscale Service already exists in the admin console and is granted to the guest's `tag:fabro`; the guest already registers as a tag-owned node, runs the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` Serve oneshot, and has TLS terminated by its open-source `tailscaled`; the iii 0.26.0 release assets and the workers registry per-target artifacts remain available at immutable, digest-pinned URLs; the guest already supports `nixos-rebuild switch`, systemd `DynamicUser` services, and a writable system state directory; and no iii secret material is introduced, because the tailnet ACL is the only access boundary.

## Requirements

### Requirement 1: Fresh pinned iii engine package

**Objective:** As an agentic developer, I want a repo-owned iii 0.26.0 engine package for both required platforms, so that I can evaluate the engine reproducibly without reusing AgentMemory's runtime.

#### Acceptance Criteria

1. The repository shall provide an `iii` engine package pinned to iii 0.26.0.
2. When the `iii` package is built for `aarch64-linux`, the package shall provide the `aarch64-unknown-linux-gnu` iii engine executable.
3. When the `iii` package is built for `aarch64-darwin`, the package shall provide the `aarch64-apple-darwin` iii engine executable.
4. The `iii` package shall declare `aarch64-linux` and `aarch64-darwin` as its only supported platforms.
5. The `iii` package shall obtain each platform artifact from an immutable URL whose SHA-256 digest is recorded in the repository.
6. The `iii` package shall expose version and source-revision metadata that identify iii 0.26.0.
7. While the pinned engine version and artifact digests are unchanged, the `iii` package shall not download an unpinned engine artifact or run the iii installer.
8. The `iii` package shall be independent of AgentMemory's `iii-engine` derivation.

### Requirement 2: Official binary worker catalog

**Objective:** As an agentic developer, I want the official iii binary workers packaged for both required platforms, so that future worker deployment can select them from the repository instead of downloading binaries by hand.

#### Acceptance Criteria

1. The repository shall provide an `iii-workers` package set covering every official binary worker from the `iii-hq/workers` repository that publishes both an `aarch64-unknown-linux-gnu` artifact and an `aarch64-apple-darwin` artifact for iii 0.26.0.
2. The `iii-workers` package set shall contain exactly 73 worker packages.
3. The `iii-workers` package set shall exclude the binary workers `harness-e2e`, `voice`, and `ios-simulator`.
4. When a cataloged worker package is built for `aarch64-linux`, the package shall provide that worker's `aarch64-unknown-linux-gnu` executable.
5. When a cataloged worker package is built for `aarch64-darwin`, the package shall provide that worker's `aarch64-apple-darwin` executable.
6. The `iii-workers` package set shall expose each cataloged worker only for `aarch64-linux` and `aarch64-darwin`.
7. The `iii-workers` package set shall record each worker's per-target artifact URL and SHA-256 digest in a pinned manifest in the repository.
8. The `iii-workers` package set shall declare iii 0.26.0 as the compatible engine version for every cataloged worker.
9. While the pinned manifest is unchanged, worker package builds shall not download an unpinned worker artifact, run `iii compose`, or run the iii installer.
10. The `iii-workers` package set shall exclude the eight official JavaScript worker bundles, `registry-cli`, and the four engine-kind registry entries.

### Requirement 3: AgentMemory runtime isolation

**Objective:** As the repo maintainer, I want the new engine and worker packages to leave AgentMemory's pinned iii runtime alone, so that AgentMemory consumers keep working while iii is evaluated.

#### Acceptance Criteria

1. The AgentMemory `iii-engine` package shall remain at iii 0.11.5.
2. The AgentMemory `iii-engine` package shall keep its existing derivation and attribute name.
3. The AgentMemory `iii-engine` package shall keep its existing Darwin platform support.
4. The AgentMemory overlay and its consumers shall remain unchanged by this feature.
5. The AgentMemory host-matrix check shall remain unchanged by this feature.
6. The `iii` engine package and the `iii-workers` package set shall use package attributes distinct from `iii-engine`.
7. When the repository is evaluated on a Darwin host, each AgentMemory consumer shall resolve the `iii-engine` 0.11.5 derivation declared by the AgentMemory overlay.
8. The `iii` and `iii-workers` packages shall not consume AgentMemory's `iii-engine` derivation, source artifacts, patches, npm dependencies, `iiiVersion` metadata, or `iiiRevision` metadata.

### Requirement 4: Declarative guest installation and supervision

**Objective:** As the Fabro guest operator, I want the iii engine installed and supervised from the guest configuration, so that a rebuild reproduces the running engine without hand-written files.

#### Acceptance Criteria

1. When the guest configuration is evaluated, the guest's declarative system package set shall include the `iii` engine package.
2. When the guest configuration is evaluated, the guest shall define `iii.service`.
3. When the guest switches configuration, the guest shall install the engine executable from the Nix store without a manual download or hand-placed binary.
4. The `iii.service` shall execute the engine executable provided by the `iii` package.
5. When the guest boots, the guest shall start `iii.service` and keep it enabled across reboots.
6. When `iii.service` exits unexpectedly, the guest shall restart it.
7. The `iii.service` shall run as a systemd `DynamicUser`.
8. The `iii.service` shall not declare a static service account.
9. The `iii.service` shall read its engine configuration from a read-only Nix store path.
10. The `iii.service` shall keep runtime state in a systemd state directory that survives service restarts, guest reboots, and configuration switches.
11. The engine's runtime state shall not reside on the host-mounted Lima state share.
12. The `iii.service` shall run with the engine's update check disabled.
13. When the rendered engine configuration changes and the guest switches configuration, `iii.service` shall restart and use the new configuration.
14. If the engine fails to start, then the guest shall mark `iii.service` failed and record the failure in the unit journal.
15. The `iii.service` shall execute the engine under a repository-owned supervisor process that remains the unit's main process.
16. The `iii.service` shall use systemd's notification service type and shall restart the unit when the supervisor stops sending watchdog keep-alives.
17. The supervisor shall report service readiness only after the engine process owns a listening socket on `127.0.0.1:49134`.
18. The supervisor shall send systemd watchdog keep-alives while the engine process is running.
19. The supervisor shall forward termination signals to the engine process and exit with the engine's status.

### Requirement 5: Empty worker configuration and loopback-only listener

**Objective:** As the Fabro guest operator, I want the engine to advertise no project workers and listen only on loopback, so that the experiment adds no externally reachable engine listener.

#### Acceptance Criteria

1. The rendered engine configuration shall declare no project worker.
2. When the engine starts, the engine's project-worker list shall be empty.
3. The engine's worker manager shall bind to `127.0.0.1:49134`.
4. The engine shall expose no listener other than `127.0.0.1:49134`.
5. The engine shall not bind any listener to `0.0.0.0` or to a tailnet address.
6. The engine shall leave `iii-stream` disabled.
7. Where the engine configuration declares its single engine-lifecycle listener, that entry shall not add a project worker.
8. If the rendered engine configuration names a project worker, then the engine shall refuse to start and record the unsupported-worker error in the unit journal.
9. If the engine cannot bind `127.0.0.1:49134`, then the supervisor shall fail readiness and the guest shall mark `iii.service` failed and record the bind error in the unit journal within the configured readiness timeout.

### Requirement 6: Tailnet service exposure

**Objective:** As a tailnet user, I want the engine published as `svc:iii`, so that I can reach it from other tailnet devices without exposing it beyond the tailnet.

#### Acceptance Criteria

1. When the guest is up and registered on the tailnet, the guest shall advertise `svc:iii` through Tailscale Serve with HTTPS on port 443, proxying to `127.0.0.1:49134`.
2. The advertised endpoint shall be reachable over the tailnet at `wss://iii.tuxedo-musical.ts.net` with TLS terminated by Tailscale Serve.
3. When the guest boots, the guest shall re-apply the `svc:iii` advertisement and shall converge to the same handler when it is already applied.
4. The guest shall leave the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` advertisements unchanged.
5. If the `svc:iii` advertisement fails, then the guest shall mark the Serve unit failed and record the error in the unit journal while leaving the existing advertisements applied.
6. While the `svc:iii` Service is absent or not granted to the guest's tag, the guest shall not expose the engine on any other interface or port.
7. While the guest has not yet joined the tailnet, the guest shall keep the engine on loopback and apply the `svc:iii` advertisement once registration completes.
8. The guest shall expose the engine over the tailnet only through the `svc:iii` Serve handler.

### Requirement 7: Evaluated verification

**Objective:** As the repo maintainer, I want automated checks over the packages, rendered guest configuration, and exposure, so that a regression fails evaluation instead of the deployment.

#### Acceptance Criteria

1. When `nix flake check` evaluates the repository, the checks shall verify that the `iii` package evaluates for `aarch64-linux` and `aarch64-darwin` at iii 0.26.0 with pinned artifacts.
2. When `nix flake check` evaluates the repository, the checks shall verify that the `iii-workers` package set contains exactly 73 worker packages.
3. When `nix flake check` evaluates the repository, the checks shall verify that each cataloged worker package evaluates for both required targets.
4. When `nix flake check` evaluates the repository, the checks shall verify that each cataloged worker declares compatibility with iii 0.26.0.
5. When `nix flake check` evaluates the repository, the checks shall verify that AgentMemory still resolves `iii-engine` 0.11.5 and that its host-matrix check remains in place.
6. When `nix flake check` evaluates the repository, the checks shall verify that the guest's declarative package set includes `iii`.
7. When `nix flake check` evaluates the repository, the checks shall verify that `iii.service` runs as a `DynamicUser` with a state directory.
8. When `nix flake check` evaluates the repository, the checks shall verify that `iii.service` reads its configuration from a read-only store path.
9. When `nix flake check` evaluates the repository, the checks shall verify that the rendered engine configuration declares zero project workers.
10. When `nix flake check` evaluates the repository, the checks shall verify that the rendered engine configuration exposes only `127.0.0.1:49134`.
11. When `nix flake check` evaluates the repository, the checks shall verify that the rendered engine configuration contains no `0.0.0.0` or tailnet bind.
12. When `nix flake check` evaluates the repository, the checks shall verify that the guest's Serve unit advertises `svc:iii` at HTTPS port 443 to `127.0.0.1:49134`.
13. When `nix flake check` evaluates the repository, the checks shall verify that the guest leaves the existing `svc:*` entries unchanged.
14. While the checks run on a host without a Linux builder, the guest checks shall complete through pure evaluation of the guest configuration.
15. If a check fails, then the check message shall name the missing or misconfigured element.
16. When `nix flake check` evaluates the repository, the checks shall verify that `iii.service` is a notification service with a finite watchdog interval, readiness timeout, and stop timeout, and that its main process is the supervisor.
17. When `nix flake check` evaluates the repository, the checks shall verify that the unit's command line invokes the supervisor with the loopback listen address and the engine executable with the read-only configuration.
18. When `nix flake check` evaluates the repository, the checks shall verify that `iii.service` does not configure an abstract `NotifySocket`.
