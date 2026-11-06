# Research: Fly.io app module

## Scope and sources

This note records the external Fly.io behavior used to choose the deployment boundary and image-build contract. Research performed on 2026-11-06; docs may evolve and the implementation should pin/verify its `flyctl` interface.

### Fly Machines API

- The Machines resource exposes Machine configuration in the `config` object and uses JSON REST endpoints such as `POST /v1/apps/{app_name}/machines` and `POST /v1/apps/{app_name}/machines/{machine_id}`. API requests authenticate with `Authorization: Bearer ${FLY_API_TOKEN}`. Source: [Machines API: Machines](https://fly.io/docs/machines/api/machines-resource/), sections “Create a Machine”, “Update a Machine”, and “Machine config object properties”.
- Machine updates require the complete Machine config rather than a partial update. The API may reject create/update and clients must handle failure. Source: [Machines API: Machines](https://fly.io/docs/machines/api/machines-resource/), section “Update a Machine”.
- Fly Apps are a grouping of Machines and shared app configuration/resources. The Apps API documents app create/get/list/delete and uses the same bearer token authentication. Source: [Machines API: Apps](https://fly.io/docs/machines/api/apps-resource/), “Create a Fly App” and “Get app details”.
- Multi-container Machines are represented as a `containers` array inside the Machine's API `config`; each item is a `ContainerConfig` with its own image, environment, health checks, startup commands, files, and dependencies. Fly documents Pilot as the required init system. Source: [Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/), sections “Defining Containers” and “Using the Machines API”.
- The documented multi-container `fly.toml` path uses `[experimental] machine_config = 'cli-config.json'` plus `container = '<name>'`; the JSON has a root `containers` array and may contain other Machine fields. `fly deploy` replaces the named container with the app image. Source: [Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/), sections “Using fly launch & fly deploy” and “Using the Machines API”.

### Fly remote build path

- `fly deploy` has `--remote-only` (also its default) to build on a remote builder, and `--nixpacks` to select Nixpacks. It has `--image` for deploying an existing image and `--access-token` as a global CLI option. Source: [fly deploy](https://fly.io/docs/flyctl/deploy/), “Options” and “Global Options”.
- Fly docs describe image, Dockerfile, and buildpacks as the image-build options. Nixpacks is available from the CLI option and is to be explicitly selected for the Nix derivation context; do not rely on implicit local Docker or other builders. Source: [Builders and Fly.io](https://fly.io/docs/reference/builders/), introductory paragraph; [fly deploy](https://fly.io/docs/flyctl/deploy/).
- In the designed contract, Nix evaluates a derivation whose output is a source/build-context directory. The Fly remote builder, not the Nix evaluator, runs Nixpacks against that context to produce the deployable image. This keeps the requirement's "remote builder only" and "Nixpacks" constraints coherent; it does not claim Fly runs Nix derivations.

### Authentication and configuration

- Current flyctl source's `hasExternallySuppliedToken` checks `FLY_ACCESS_TOKEN` and `FLY_API_TOKEN` before interactive session handling. The adapter sets `FLY_API_TOKEN` in the child environment and omits `--access-token` to keep the credential out of process arguments. Source: [flyctl internal/command/command.go](https://github.com/superfly/flyctl/blob/master/internal/command/command.go), `hasExternallySuppliedToken`.
- `fly.toml` documents app identity, runtime settings, build, services, VM, checks, processes, files, and other app configuration. Source: [App configuration (fly.toml)](https://fly.io/docs/reference/configuration/).
- The pinned nixpkgs activation script wraps each activation snippet with an ERR trap that records a nonzero status, and exits with the aggregate status before the final activation success point. Source: [nixpkgs activation-script.nix at locked revision `36fd15bbb657815e2028e31d715c2e43a1230c91`](https://github.com/NixOS/nixpkgs/blob/36fd15bbb657815e2028e31d715c2e43a1230c91/nixos/modules/system/activation/activation-script.nix).
- Fly says Machines API create/update requests can fail and clients own handling failure. The module's deployment action must propagate a nonzero result rather than mark activation successful. Source: [Machines API: Machines](https://fly.io/docs/machines/api/machines-resource/), “Create a Machine” and “Update a Machine”.
