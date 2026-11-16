# Requirements Document

## Introduction

This feature makes the iii engine available from this repository as a pinned package and runs it on the Fabro guest as a loopback-only Tailscale Service. The problem statement, approach, and scope constraints live in `brief.md`.

## Boundary Context

- **In scope**: engine and worker derivations for `aarch64-darwin` even though no Darwin service runs; the AgentMemory attribute rename and its two consumers, with the AgentMemory iii version, URLs, digests, and platforms unchanged; the single engine-lifecycle worker entry that carries the loopback bind while the project-worker list stays empty; the engine service and `svc:iii` handler added to the guest's existing Serve oneshot.
- **Out of scope** (delta from `brief.md`): the 8 official JavaScript-bundle workers; the 3 binary workers that lack a required target (`harness-e2e`, `voice`, `ios-simulator`); the `registry-cli` executable and the 4 engine-kind registry entries; `x86_64` engine and worker targets; automatic version bumps of the engine or the catalog; the `install-total-recall-on-fabro-vm` iii 0.24 pin and worker set; starting, composing, or configuring any worker on the guest.
- **Adjacent expectations**: the `svc:iii` Tailscale Service already exists in the admin console and is granted to `tag:fabro`; the guest already registers as a tag-owned `tag:fabro` node and advertises its existing `svc:*` entries; the iii 0.26.0 release assets and the workers registry per-target tarballs stay published at their recorded URLs with unchanged digests; the guest image's systemd supports dynamic-user state directories; the Darwin hosts already evaluate the repository's overlays.

## Requirements

### Requirement 1: Pinned engine package

**Objective:** As the repo maintainer, I want the iii 0.26.0 engine packaged for both required platforms from immutable artifacts, so that the guest install and Darwin evaluations are reproducible.

#### Acceptance Criteria

1. The repository's package set shall provide an engine package at version 0.26.0.
2. When the engine package is evaluated for `aarch64-linux`, the package shall build successfully.
3. When the engine package is evaluated for `aarch64-darwin`, the package shall build successfully.
4. The engine package shall install the `iii` executable as its main program and shall install no worker executable.
5. When the packaged `iii` executable reports its version, it shall report version 0.26.0.
6. The engine package shall record the engine release revision it was built from.
7. The engine package shall resolve each platform artifact from an immutable URL whose SHA-256 digest is recorded in the repository.
8. If the engine package is evaluated for a platform other than `aarch64-linux` or `aarch64-darwin`, then evaluation shall fail with a message naming the unsupported platform.
9. While the recorded engine version and digests are unchanged, a build of the engine package shall fetch no unpinned artifact and shall not run the upstream installer.

### Requirement 2: Official worker catalog

**Objective:** As the repo maintainer, I want every official native-binary worker packaged for both required platforms, so that a future deployment can declare workers from one pinned catalog.

#### Acceptance Criteria

1. The repository's package set shall provide a worker catalog whose entries are addressed by worker name.
2. The catalog shall contain exactly 73 workers.
3. The catalog shall include every official worker that publishes a native binary for both `aarch64-linux` and `aarch64-darwin` and declares compatibility with engine 0.26.0.
4. The catalog shall exclude the 8 official JavaScript-bundle workers, the 3 binary workers without both required targets (`harness-e2e`, `voice`, `ios-simulator`), the `registry-cli` executable, and the 4 engine-kind registry entries.
5. When a cataloged worker's package is evaluated for `aarch64-linux`, the worker package shall provide that worker's executable.
6. When a cataloged worker's package is evaluated for `aarch64-darwin`, the worker package shall provide that worker's executable.
7. The package of each cataloged worker shall record the worker version it was built from and shall expose the same version on both required platforms.
8. The artifact of each cataloged worker shall resolve from an immutable URL whose SHA-256 digest is recorded in the repository.
9. The manifest entry of each cataloged worker shall declare engine compatibility with 0.26.0.
10. If a cataloged worker lacks an artifact or digest for one of the two required platforms, then evaluation shall fail with a message naming the worker and the missing platform.
11. The guest configuration shall start no cataloged worker.

### Requirement 3: AgentMemory engine pin separation

**Objective:** As the repo maintainer, I want the AgentMemory runtime to keep its pinned iii 0.11.5 engine under a distinct package name, so that the current engine can take the shared attribute without changing AgentMemory behavior.

#### Acceptance Criteria

1. The package set's `iii-engine` attribute shall resolve to the 0.26.0 engine package on both required platforms.
2. The AgentMemory runtime shall obtain iii 0.11.5 from a distinct package attribute.
3. The AgentMemory-pinned engine's package metadata shall continue to report iii version 0.11.5 and revision `iii/v0.11.5`.
4. When the AgentMemory host package is installed, the AgentMemory runtime's PATH shall include the iii 0.11.5 executable rather than the 0.26.0 engine.
5. When the AgentMemory host-matrix check is evaluated, it shall resolve the AgentMemory-pinned engine.
6. The AgentMemory-pinned engine derivation shall keep its version, source URLs, digests, supported platforms, and passthru metadata unchanged apart from its attribute name.
7. The repository shall contain no remaining reference to the AgentMemory-pinned engine under the `iii-engine` attribute name.

### Requirement 4: Declarative engine install on the guest

**Objective:** As the Fabro guest operator, I want the engine installed from the repository package on every switch, so that the engine version survives rebuilds and is never installed by hand.

#### Acceptance Criteria

1. When the guest configuration is switched, the guest shall install the 0.26.0 engine from the repository package through its system package set.
2. The guest's installed engine executable shall resolve to the repository engine package's store path.
3. While the recorded engine version and digests are unchanged, the guest shall install no engine binary from a release download, the upstream installer, or a hand-placed file.
4. The guest configuration shall run no upstream installer, compose command, or other imperative engine installation step during activation.

### Requirement 5: Engine service identity and lifecycle

**Objective:** As the Fabro guest operator, I want the engine supervised as an unprivileged dynamic service, so that it starts at boot and keeps its state across restarts and switches.

#### Acceptance Criteria

1. When the guest boots, the guest shall start the engine as a systemd service and keep it enabled across reboots.
2. The engine service shall run as a `DynamicUser` and shall declare no static system account.
3. The engine service shall keep its runtime state in a systemd `StateDirectory` under `/var/lib`, outside the virtiofs share, and shall retain that state across service restarts and configuration switches.
4. When the engine service exits unexpectedly, the guest shall restart it.
5. The engine service shall read its configuration from a read-only store path.
6. The engine service shall require no secret, credential, or token from the guest's secret store.
7. If the service's configuration or state directory is unavailable at start, then the guest shall mark the unit failed and name the cause in the unit journal.
8. The engine service shall run the `iii` executable from the store package rather than a downloaded or hand-placed binary.
9. While the engine runs, the engine shall not check for updates or download replacement binaries.

### Requirement 6: Listener and worker scope

**Objective:** As the Fabro guest operator, I want a single loopback listener with no project workers, so that the engine is reachable only through its Tailscale Service.

#### Acceptance Criteria

1. While the engine runs, the engine shall listen only on `127.0.0.1:49134`.
2. The engine shall expose no listener on `0.0.0.0`, on the guest's tailnet address, or on any other interface.
3. When the running engine is inspected, the engine shall report zero project workers.
4. The rendered engine configuration shall declare no project worker.
5. The only worker entry the rendered engine configuration may declare shall be the engine-lifecycle worker manager that owns the loopback listener.
6. The engine configuration shall bind the worker manager to `127.0.0.1:49134` and shall not bind it to a wildcard or tailnet address.
7. The engine configuration shall leave the deprecated stream worker disabled.

### Requirement 7: Tailnet Service exposure

**Objective:** As a tailnet client, I want the engine published as `svc:iii` through Tailscale Serve, so that I can reach it from tailnet devices without an exposed guest port.

#### Acceptance Criteria

1. When the guest is up and registered on the tailnet, the guest shall advertise `svc:iii` at `https=443` forwarding to the engine's loopback listener.
2. When a tailnet client connects to the `svc:iii` endpoint, the guest shall forward the connection to `127.0.0.1:49134` with TLS terminated by Tailscale Serve.
3. The `svc:iii` endpoint shall be reachable at `iii.tuxedo-musical.ts.net` and shall serve the engine over WebSocket at `wss://iii.tuxedo-musical.ts.net`.
4. The `svc:iii` advertisement shall be re-applied on every boot and shall converge to the same handler when it is already applied.
5. The guest shall leave the existing `svc:fabro`, `svc:litellm`, and `svc:opencode` advertisements unchanged.
6. The guest shall advertise no engine endpoint other than `svc:iii`.
7. If the `svc:iii` advertisement fails, then the guest shall mark the Serve unit failed and record the error in the unit journal while leaving the existing advertisements applied.
8. While the guest has not yet joined the tailnet, the guest shall keep the engine running on loopback and shall apply the `svc:iii` advertisement once registration completes.
9. While the `svc:iii` Service is absent or not granted to the guest's tag, the guest shall not expose the engine on any other interface or port.
10. The guest shall not create the `svc:iii` Service and shall not modify tailnet ACLs, DNS names, certificates, or device approval.

### Requirement 8: Evaluated verification

**Objective:** As the repo maintainer, I want every package, catalog, unit, listener, and Serve assertion in `nix flake check`, so that a regression fails the build instead of the deployment.

#### Acceptance Criteria

1. When `nix flake check` evaluates the repository, the checks shall verify that the engine package builds for `aarch64-linux` and `aarch64-darwin` and reports version 0.26.0.
2. When `nix flake check` evaluates the repository, the checks shall verify that the worker catalog contains exactly 73 entries, that each entry provides both required platform artifacts, and that each entry declares engine compatibility with 0.26.0.
3. When `nix flake check` evaluates the repository, the checks shall verify that the catalog excludes the JavaScript-bundle workers, `harness-e2e`, `voice`, `ios-simulator`, `registry-cli`, and the engine-kind registry entries.
4. When `nix flake check` evaluates the repository, the checks shall verify that the `iii-engine` attribute resolves the 0.26.0 engine and that the AgentMemory runtime still resolves iii 0.11.5 under its distinct attribute.
5. When `nix flake check` evaluates the repository, the checks shall verify that the guest installs the engine through its system package set and that the engine service is enabled at boot, runs as a `DynamicUser`, uses a `StateDirectory`, and reads a store-path configuration.
6. When `nix flake check` evaluates the repository, the checks shall verify that the rendered engine configuration declares no project worker, keeps the stream worker disabled, and binds no wildcard or tailnet address.
7. When `nix flake check` evaluates the repository, the checks shall verify that the guest advertises `svc:iii` at `https=443` to `127.0.0.1:49134` and leaves the existing `svc:*` handlers unchanged.
8. When `nix flake check` evaluates the repository, the checks shall verify that the engine service declares no secret material.
9. While the checks run on a host without a Linux builder, the guest checks shall complete through pure evaluation of the guest configuration.
10. If a check fails, then the check message shall name the missing or misconfigured element.
