# Requirements Document

## Introduction

The `nix-built-container-for-default-fabro-environmen` feature defines the default Fabro sandbox image in this repository and points Fabro's `default` environment at it, replacing the seeded `buildpack-deps:noble` image. See `brief.md` for the problem, selected approach, and scope.

## Boundary Context

- **In scope**: The repo-built sandbox image and its `aarch64-linux` package; the `/bin/bash`, `PATH`, environment, and toolchain contract the image must satisfy; Nix inside the image; delivery of the image into the guest Docker under a stable tag; the declarative wiring of Fabro's `default` environment to that tag; and verification that a run uses the image and that Nix works inside it.
- **Out of scope**: Publishing the image to a remote registry or distributing it across hosts; per-language or per-project sandbox images; changing Fabro's provider selection, run resource allocation, or network policy; the server and OpenCode host packages; defining specific Nix development shells; and any non-default environment or catalog entry.
- **Adjacent expectations**: The `fabro-vm` guest keeps Docker enabled and runs the `fabro` server service; Fabro's docker provider consumes only a prebuilt image reference (it ignores any in-repo Dockerfile); the repository's flake and nixpkgs revision remain the build substrate; and the guest's existing systemd and sops-nix layout is unchanged.

## Requirements

### Requirement 1: Repository-defined sandbox image
**Objective:** As the operator of a Fabro environment, I want the default sandbox image defined in this repository, so that the sandbox uses the same configuration management tooling as the server.

#### Acceptance Criteria
1. The repository shall define the default Fabro sandbox image in the repository's Nix configuration.
2. The repo-built sandbox image shall be an `aarch64-linux` container image.
3. The repo-built sandbox image shall build from the repository's flake and nixpkgs revision, the same inputs the `fabro-vm` server builds from.
4. The repo-built sandbox image shall be loadable into the guest Docker.
5. The repo-built sandbox image shall not depend on a remote container registry.

### Requirement 2: Sandbox runtime contract
**Objective:** As the operator of a Fabro environment, I want the repo-built sandbox image to provide the runtime Fabro needs, so that runs execute inside the sandbox without missing tools.

#### Acceptance Criteria
1. The repo-built sandbox image shall provide `/bin/bash`.
2. While Fabro evaluates sandbox commands in a non-login shell, the repo-built sandbox image shall resolve `/bin/bash` without a login shell or user profile.
3. The repo-built sandbox image shall make `git`, `coreutils`, `curl`, and `jq` available on the default `PATH`.
4. The repo-built sandbox image shall provide CA certificates for TLS-verified network access.
5. The repo-built sandbox image shall bake its default `PATH` and environment into the image configuration, so a non-login shell sees them.

### Requirement 3: Nix inside the sandbox
**Objective:** As the operator of a Fabro environment, I want Nix available inside the sandbox, so that Nix-based development environments can execute inside a run.

#### Acceptance Criteria
1. The repo-built sandbox image shall provide a working `nix` command.
2. When a run executes a Nix command inside the sandbox, the sandbox shall evaluate and build the derivation.
3. While the sandbox exposes no host volume mounts, the sandbox shall keep Nix functional.

### Requirement 4: Image delivery to the guest Docker
**Objective:** As the operator of a Fabro environment, I want the repo-built sandbox image in the guest Docker under a stable tag, so that Fabro starts sandboxes without a manual image step.

#### Acceptance Criteria
1. When the `fabro-vm` configuration is deployed, the guest Docker shall hold the repo-built sandbox image under a stable tag.
2. When the repo-built sandbox image changes, the guest Docker shall hold the updated image under the same stable tag after the next deploy.
3. The guest Docker shall make the tagged image available without an operator running a manual image load or tag step.
4. The guest Docker shall take the tagged image from the repository's Nix build output rather than an imperative image build.
5. If the repo-built sandbox image cannot be loaded into the guest Docker, the deploy shall fail with an error identifying the sandbox image.

### Requirement 5: Default environment wiring
**Objective:** As the operator of a Fabro environment, I want Fabro's `default` environment to reference the repo-built sandbox image, so that every new run uses it with no manual selection.

#### Acceptance Criteria
1. The `fabro-vm` server configuration shall declare the `default` environment with the docker provider and the stable tag of the repo-built sandbox image.
2. When a new run starts without an explicit environment, the Fabro server shall execute the run in the repo-built sandbox image.
3. When the Fabro server starts, the Fabro server shall apply the declared `default` environment from its configuration regardless of any previously persisted environment catalog.
4. The default environment wiring shall preserve the existing docker provider selection, run resource allocation, and network policy.

### Requirement 6: Verification
**Objective:** As the repository maintainer, I want the sandbox image and its wiring verified, so that drift is caught before it reaches a run.

#### Acceptance Criteria
1. When repository checks run, they shall verify that the repository defines the repo-built sandbox image as an `aarch64-linux` package.
2. When repository checks run, they shall verify that the guest Docker delivery is wired to the stable tag.
3. When repository checks run, they shall verify that the Fabro `default` environment references the stable tag.
4. When a run executes in the sandbox, the run shall report the repo-built sandbox image as its environment.
5. When a Nix command executes inside the sandbox, the sandbox shall evaluate and build successfully.
