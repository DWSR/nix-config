# Requirements Document

## Introduction

The `mac-nix-remote-builder` feature defines a self-contained macOS `aarch64-darwin` host that serves Nix remote builds, together with the personal-host Lima macOS guest that runs it. See `brief.md` for the problem, selected approach, and scope.

## Boundary Context

- **In scope**: the Builder Host Configuration and the packages and settings it declares; the dedicated Builder User, its builder authorization, and host-identity trust; the Nix remote-builder endpoint; the builder-host Secret Store; the Personal Host's Builder Lima Guest definition and launchd lifecycle; the one-touch Deploy Command; and the repository checks plus the runtime Readiness Check.
- **Out of scope**: client-side dispatch (`nix.buildMachines`) on any client; binary-cache serving, substitution, retention, and publication owned by `local-binary-cache`; dedicated Apple hardware imaging; changes to the existing NixOS `fabro` Lima instance; `x86_64` or other foreign-architecture builders; and Apple ID or licensing automation beyond guest boot.
- **Adjacent expectations**: the Personal Host's Apple Silicon and Virtualization.framework, the existing `virtualisation.limaVM` launchd lifecycle pattern, nix-darwin, per-host sops-nix stores, and `local-binary-cache` substituters remain available and unchanged in ownership. The `local-binary-cache` assertion that the Personal Host does not enable global distributed builds stays intact.

## Requirements

### Requirement 1: Self-contained builder host configuration
**Objective:** As the repository maintainer, I want a self-contained macOS builder host configuration, so that a fresh `aarch64-darwin` machine serves remote builds without depending on the Personal Host.

#### Acceptance Criteria
1. The Builder Host Configuration shall declare the Builder Host's users, packages, and services.
2. The Builder Host Configuration shall provide every package and setting the Builder Host requires to serve remote builds.
3. The Builder Host Configuration shall not require any file shared from the Personal Host.
4. The Builder Host Configuration shall not encode Lima image provisioning, guest boot, or First Run Experience behavior.
5. Where the Builder Host Configuration is evaluated, it shall target `aarch64-darwin`.
6. The Builder Host shall reclaim Nix store space on a declared schedule.

### Requirement 2: Dedicated builder user and access trust
**Objective:** As the builder operator, I want a dedicated non-privileged builder identity, so that clients can submit builds without receiving administrative access.

#### Acceptance Criteria
1. The Builder Host Configuration shall define a dedicated non-privileged Builder User.
2. The Builder User shall hold no administrative or root privileges.
3. The Remote Builder shall accept build connections only as the Builder User.
4. The Builder Host Configuration shall declare the authorized builder identities that may connect to the Builder User.
5. If a client presents an identity that is not authorized, then the Builder Host shall refuse the connection.
6. The Builder Host shall present a host identity that a client can verify before connecting.
7. If the required builder authorization material is unavailable, then the Builder Host shall not accept build connections and shall report the missing material.

### Requirement 3: Nix remote-builder endpoint
**Objective:** As a client, I want the builder to expose a standard Nix remote-builder endpoint, so that I can adopt it without custom integration.

#### Acceptance Criteria
1. The Builder Host shall expose a Nix remote-builder endpoint for `aarch64-darwin` derivations.
2. The Remote Builder shall accept standard Nix remote-builder connections without custom client integration.
3. When an authorized client submits an `aarch64-darwin` build, the Remote Builder shall perform that build on the Builder Host.
4. When a build completes, the Remote Builder shall make the produced outputs available to the requesting client.
5. If a requested derivation targets a system other than `aarch64-darwin`, then the Remote Builder shall reject the build request.
6. The Builder Host shall keep the Remote Builder available without an interactive login.

### Requirement 4: Builder-host secret delivery
**Objective:** As the builder operator, I want the builder to take its secrets from its own secret store, so that secret values never enter the Nix store.

#### Acceptance Criteria
1. The Builder Host shall obtain its declared runtime secrets from a builder-host Secret Store.
2. The Secret Store shall be decryptable only by the Builder Host's own key.
3. The Builder Host Configuration shall not place secret values in the Nix store.
4. When the Builder Host activates, it shall materialize its declared secrets at their runtime paths.
5. If a required secret cannot be decrypted, then the Builder Host shall fail activation with an error identifying the missing secret.
6. The Secret Store shall be separate from the Personal Host's secret stores.

### Requirement 5: Personal-host builder guest and lifecycle
**Objective:** As the Personal Host owner, I want the builder macOS guest managed by the Personal Host, so that the guest starts and stays running without manual intervention.

#### Acceptance Criteria
1. The Personal Host shall define the Builder Lima Guest using the latest released macOS.
2. The Personal Host shall manage the Builder Lima Guest through a launchd lifecycle.
3. When the Personal Host starts, the Builder Lima Guest shall start without an interactive login.
4. If the Builder Lima Guest exits unexpectedly, then the Personal Host shall restart it.
5. When the Builder Lima Guest is stopped cleanly, the Personal Host shall leave it stopped.
6. The Builder Lima Guest's macOS provisioning, including the First Run Experience skip, shall be declared by the Personal Host and not by the Builder Host Configuration.
7. The Builder Lima Guest definition shall be independent of the existing NixOS `fabro` Lima instance.

### Requirement 6: One-touch deploy and bootstrap
**Objective:** As the builder operator, I want a single deploy command, so that a fresh macOS becomes the Builder Host without any file shared from the Personal Host.

#### Acceptance Criteria
1. The Deploy Command shall set up the Builder Host on a fresh macOS in a single invocation.
2. When the Deploy Command runs against a macOS without Nix, it shall bootstrap Nix before applying the Builder Host Configuration.
3. The Deploy Command shall apply the Builder Host Configuration to the Builder Host over SSH.
4. The Deploy Command shall stream the repository to the Builder Host.
5. The Deploy Command shall not require any file shared from the Personal Host.
6. If the repository inputs required by the Deploy Command are not locked, then the Deploy Command shall fail before changing the Builder Host.
7. If the Builder Host is unreachable, then the Deploy Command shall fail with an error identifying the connection failure.
8. When the Deploy Command completes, the Builder Host shall run the applied configuration.

### Requirement 7: Declarative verification and readiness
**Objective:** As the repository maintainer, I want builder behavior checked automatically, so that drift is caught without a live build.

#### Acceptance Criteria
1. When repository checks evaluate the Builder Host Configuration, the Repository Checks shall verify the Builder User, the remote-builder endpoint, and the Secret Store wiring.
2. When repository checks evaluate the Personal Host, the Repository Checks shall verify the Builder Lima Guest definition and its launchd lifecycle.
3. If the Builder Host Configuration omits the dedicated Builder User, the remote-builder endpoint, or the builder-host Secret Store, then the Repository Checks shall fail.
4. When the Readiness Check runs against a running Builder Host, it shall report whether the Builder Host can accept `aarch64-darwin` remote builds.
5. If the Builder Host cannot accept `aarch64-darwin` remote builds, then the Readiness Check shall return a nonzero result.
6. If rendered configuration artifacts contain secret values, then the Repository Checks shall fail.
