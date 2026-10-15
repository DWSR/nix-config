# Requirements Document

## Introduction

`nix-built-container-for-default-fabro-environmen` defines the repo-owned sandbox
image that becomes Fabro's `default` environment, the way it is built,
published, and referenced by digest, and how sandbox containers reach the
guest's Nix store and daemon. See `brief.md` for the problem, selected
approach, and scope.

## Boundary Context

- **In scope**: the sandbox image and its contents; the reproducible build and
  the digest that identifies it; loading the image into the guest's local
  Podman store on change without a registry; wiring and reconciling the
  `default` environment to the image digest; making the guest's Nix store and
  daemon reachable from sandbox containers at the container-engine layer; and
  verification through repository checks plus a runtime smoke check.
- **Out of scope**: CRI-O/containerd integration and content de-duplication
  between the registry and the Nix store; any registry push; per-workflow or
  additional environments; Daytona and other providers; the `fabro-vm-image`
  boot image; replacing Podman; and sandbox network policy or hardening.
- **Adjacent expectations**: the `fabro-vm` guest (Podman, Fabro settings,
  systemd, and the guest-side Nix builder), the fabro overlay, and the pinned
  `nix-snapshotter` input remain available and unchanged in ownership. The
  image builds on the guest's own Linux architecture; `run.environment.id =
  "default"` consumers are the downstream users of the reconciled environment.

## Requirements

### Requirement 1: Sandbox image contents
**Objective:** As the operator of a Fabro environment, I want the default sandbox image to carry the tooling Fabro and Nix-based development environments require, so that sandboxed workflows run without extra provisioning.

#### Acceptance Criteria
1. The Sandbox Image shall provide a Bash shell at `/bin/bash`.
2. The Sandbox Image shall provide Git.
3. The Sandbox Image shall provide coreutils.
4. The Sandbox Image shall provide Nix.
5. When a sandbox container starts from the Sandbox Image, the tools provided by the image shall be resolvable on the container's default command path.

### Requirement 2: Reproducible image build and identity
**Objective:** As the operator, I want identical inputs to produce an identical image, so that the image reference is a trustworthy, reproducible identity.

#### Acceptance Criteria
1. When the Sandbox Image Build runs twice from identical inputs, the build shall produce identical image contents.
2. The Sandbox Image Build shall build the image only from pinned inputs.
3. If the Sandbox Image Build inputs are not pinned, then the build shall fail instead of producing an unpinned image.
4. Where the guest runs `aarch64-linux`, the Sandbox Image Build shall produce an image for that architecture.
5. The Sandbox Image Build shall produce a content digest that identifies the built image contents.
6. The Sandbox Image Build shall make the image content digest available to the guest configuration.

### Requirement 3: Local image publication
**Objective:** As the operator, I want each guest switch to make the current image available in the local Podman store, so that Fabro can run the sandbox without a registry.

#### Acceptance Criteria
1. When the guest configuration switches and the Sandbox Image contents have changed, the Sandbox Image Loader shall load the new image into the local Podman store.
2. While the Sandbox Image contents are unchanged, the Sandbox Image Loader shall keep the local Podman image consistent with those contents.
3. The Sandbox Image Loader shall not push the Sandbox Image to any registry.
4. The Sandbox Image Loader shall load the Sandbox Image before the Fabro Default Environment can use it.
5. The Sandbox Image Loader shall keep a local tag for the loaded image.
6. If the Sandbox Image Loader cannot load the image, then it shall fail the guest configuration switch with an error identifying the load failure.

### Requirement 4: Fabro default environment digest wiring
**Objective:** As the operator, I want the Fabro default environment to reference the image by digest, so that sandbox runs use exactly the intended image.

#### Acceptance Criteria
1. The Fabro Default Environment shall reference the Sandbox Image by content digest rather than a mutable tag.
2. When the Sandbox Image contents change, the Fabro Default Environment shall reference the new content digest.
3. When the guest configuration switches, the Fabro Default Environment shall reconcile the persisted `default` environment to the declared content digest.
4. While the persisted `default` environment already matches the declared content digest, the reconciliation shall not change it.
5. Where the `default` environment already exists in the persisted catalog, the reconciliation shall update it rather than create a duplicate.
6. If reconciliation cannot update the persisted `default` environment, then it shall report an error identifying the declared and persisted digests.

### Requirement 5: Host Nix store and daemon sharing
**Objective:** As the operator, I want sandbox containers to reach the guest's Nix store and daemon, so that Nix-based environments reuse store paths instead of building a second store.

#### Acceptance Criteria
1. When a sandbox container starts, the Sandbox Host-Store Sharing shall mount the guest's Nix store into the container read-only.
2. When a sandbox container starts, the Sandbox Host-Store Sharing shall make the guest's Nix daemon reachable from the container.
3. The Sandbox Host-Store Sharing shall apply to every sandbox container Podman creates, without per-environment configuration.
4. While a sandbox container reuses a store path present in the guest's Nix store, the container shall not build that path.
5. The Sandbox Host-Store Sharing shall not make the guest's Nix store writable from sandbox containers.

### Requirement 6: Verification
**Objective:** As the repository maintainer, I want the sandbox image and its wiring checked from the guest configuration, so that image contents, publication, digest wiring, and host-store sharing do not drift silently.

#### Acceptance Criteria
1. When repository checks evaluate the guest configuration, the Repository Checks shall verify the Sandbox Image contents, the image content digest wiring, the Sandbox Image Loader, and the Sandbox Host-Store Sharing.
2. If any required element of the Sandbox Image configuration is absent, then the Repository Checks shall fail.
3. When the operator runs the Sandbox Smoke Check, the Sandbox Smoke Check shall start a sandbox container from the Sandbox Image and confirm the tools provided by the image run inside it.
4. When the operator runs the Sandbox Smoke Check, the Sandbox Smoke Check shall confirm a sandbox container reaches the guest's Nix store and Nix daemon.
5. If the Sandbox Smoke Check fails, then it shall report the failed step.
