# Requirements Document

## Introduction
The `create-a-linux-nix-remote-builder-instance` feature makes a Linux remote builder available to the repository's Nix hosts. See `brief.md` for the problem, selected approach, and scope.

## Boundary Context
- **In scope**: The Linux Builder's supported build capability; its Personal Host Lima VM resources; Linux build dispatch from the Fabro Guest and `Brandons-MacBook-Pro`; Fabro's prohibition on local builds; and configuration validation for these behaviors.
- **Out of scope**: Replacing or changing the existing Darwin builder or its Darwin dispatch; support for other Linux architectures or builder pools.
- **Adjacent expectations**: The Personal Host continues to manage Lima VM lifecycle, and the existing `aarch64-darwin` build path remains available.

## Requirements

### Requirement 1: Linux Builder capability
**Objective:** As a Nix user, I want a Linux remote builder for `aarch64-linux` derivations, so that Linux builds can run on a Linux host.

#### Acceptance Criteria
1. When a client submits an `aarch64-linux` derivation to the Linux Builder, the Linux Builder shall perform the build and make its outputs available to that client.
2. If a client submits a derivation for a platform other than `aarch64-linux`, then the Linux Builder shall not accept it as a supported build.
3. The Linux Builder shall run NixOS and shall be usable independently of the Personal Host's Lima provisioning and lifecycle configuration.

### Requirement 2: Personal Host Linux Builder VM
**Objective:** As the Personal Host owner, I want the Linux Builder provisioned as a Lima VM with the specified resources, so that it has a consistent environment for remote builds.

#### Acceptance Criteria
1. When the Personal Host configuration defines the Linux Builder VM, it shall allocate 4 CPUs.
2. When the Personal Host configuration defines the Linux Builder VM, it shall allocate 8 GiB of memory.
3. When the Personal Host configuration defines the Linux Builder VM, it shall allocate 128 GiB of disk space.
4. The Personal Host shall manage the Linux Builder VM using the repository's established VM lifecycle conventions.

### Requirement 3: Linux build dispatch from Nix clients
**Objective:** As a Nix user, I want the Fabro Guest and `Brandons-MacBook-Pro` to use the Linux Builder for Linux derivations, so that both hosts can build `aarch64-linux` outputs remotely.

#### Acceptance Criteria
1. When the Fabro Guest requests an `aarch64-linux` derivation, it shall dispatch the build to the Linux Builder.
2. When `Brandons-MacBook-Pro` requests an `aarch64-linux` derivation, it shall dispatch the build to the Linux Builder.
3. When either client requests an `aarch64-darwin` derivation, the existing Darwin build path shall remain available and unchanged by the Linux Builder configuration.

### Requirement 4: Fabro no-local-build policy
**Objective:** As a Fabro operator, I want Fabro to use remote builders instead of building locally, so that Fabro's local resources are not used for Nix builds.

#### Acceptance Criteria
1. When Fabro requests a derivation supported by a configured remote builder, Fabro shall dispatch the build remotely and shall not perform the build locally.
2. If no configured remote builder can accept a requested build, then Fabro shall report the build failure without performing the build locally.
3. When Fabro requests an `aarch64-darwin` derivation, Fabro shall continue to use the existing Darwin build path.

### Requirement 5: Configuration validation
**Objective:** As a repository maintainer, I want checks for the Linux Builder and its client wiring, so that configuration regressions are detected before use.

#### Acceptance Criteria
1. When repository configuration checks run, they shall verify that the Linux Builder is a NixOS host supporting `aarch64-linux`.
2. When repository configuration checks run, they shall verify that the Personal Host's Linux Builder VM has 4 CPUs, 8 GiB of memory, and 128 GiB of disk space.
3. When repository configuration checks run, they shall verify that the Fabro Guest and `Brandons-MacBook-Pro` dispatch `aarch64-linux` builds to the Linux Builder.
4. When repository configuration checks run, they shall verify that Fabro does not perform local builds and retains its existing Darwin build path.
5. If a required Linux Builder, VM resource, client dispatch, or Fabro build-policy setting is missing or incorrect, then the corresponding repository configuration check shall fail.
