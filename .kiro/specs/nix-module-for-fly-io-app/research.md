# Research: nix-module-for-fly-io-app

## Fly Machines API configuration and token auth

- **Context**: Confirm the request shape needed to support complete machine configurations, including multiple containers, and verify that deployment can use a bearer token without an interactive CLI session.
- **Sources consulted**:
  - Fly.io Machines API, Machines resource: https://fly.io/docs/machines/api/machines-resource/ (accessed 2026-11-06).
  - Fly.io Multi-container Machines: https://fly.io/docs/machines/guides-examples/multi-container-machines/ (accessed 2026-11-06).
  - Fly.io Apps resource: https://fly.io/docs/machines/api/apps-resource/ (accessed 2026-11-06).
  - Fly.io Integrating flyctl: https://fly.io/docs/flyctl/integrating/ (accessed 2026-11-06).
- **Findings**:
  - The Machines resource supports creating machines with `POST /v1/apps/{app_name}/machines` and changing an existing machine with `POST /v1/apps/{app_name}/machines/{machine_id}`. Update requests require the full machine `config`, rather than a partial patch.
  - The machine config is a structured JSON object with recognized fields including `image`, `env`, `files`, `guest`, `init`, `mounts`, `processes`, `restart`, and `services`. This is a large and evolving API surface.
  - Multi-container Machines use a `containers` array and require Pilot as the init system. The Machines API request nests `containers` in `config`.
  - The Apps resource documents app create/get/list/delete operations, but no app-settings update endpoint. The Fly `flyctl deploy` flow is therefore the app settings deployment seam, with `fly.toml` rendered from the module settings.
  - Fly documents `FLY_API_TOKEN` for non-interactive CLI automation and accepts bearer token API requests.
- **Implications**: Keep the module's Machine config as an open attribute set serialized in full rather than mirroring every API key as a Nix option. Set Pilot when `containers` is present. Render app settings to `fly.toml` and use `flyctl deploy`; pass the runtime token without interactive login.

## Fly builders and Nixpacks

- **Context**: Validate the requirement that a Nix derivation be built remotely with Nixpacks on a Fly.io remote builder.
- **Sources consulted**:
  - Fly.io, Builders and Fly.io: https://fly.io/docs/reference/builders/ (accessed 2026-11-06).
  - Fly.io, Integrating flyctl: https://fly.io/docs/flyctl/integrating/ (accessed 2026-11-06).
  - Railway Nixpacks project README: https://github.com/railwayapp/nixpacks (accessed 2026-11-06).
- **Findings**:
  - Fly.io's builder documentation describes Dockerfile, Cloud Native Buildpacks, and prebuilt image modes. The `flyctl` automation guide documents remote Fly builds and prebuilt images, but neither documents Nixpacks as a Fly remote builder or a mechanism that accepts a Nix derivation as a build input.
  - Nixpacks describes itself as taking a source directory and producing an OCI-compliant image. The project README says it is in maintenance mode and recommends Railpack. That describes a source-to-image build and does not define a Nix derivation input contract.
- **Implications**: The requirement is retained as directed, but it is a delivery risk that must be validated before implementation claims compatibility. Implementers must not silently substitute ordinary Fly buildpacks, a local image build, or an unsupported builder path. If no integration that satisfies both the requirement and Fly's actual service behavior can be demonstrated, the implementation is blocked pending an upstream requirement decision.

## Platform names

- **Context**: Resolve the exact Nix system identifiers covered by the platform requirement.
- **Sources consulted**: The Nix platform names used in the repository's flake and architecture-specific configurations (`aarch64-darwin`, `x86_64-linux`, and `aarch64-linux`).
- **Findings**: These are the system identifiers corresponding to Darwin ARM, Linux x64, and Linux ARM in Nix.
- **Implications**: Platform validation targets exactly `aarch64-darwin`, `x86_64-linux`, and `aarch64-linux`; it checks that module evaluation and deployment client packaging work on each, not that the Fly runtime runs on those hosts.
