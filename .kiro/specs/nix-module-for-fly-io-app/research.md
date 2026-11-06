# Research: nix-module-for-fly-io-app

## Fly Machines API contract

- **Source**: [Working with the Machines API](https://fly.io/docs/machines/api/working-with-machines-api/) (consulted 2026-11-06).
- **Findings**: The public API base is `https://api.machines.dev`; requests use `Authorization: Bearer <fly_api_token>`. The documented status codes include 2xx success, 401 for missing/invalid token, 4xx for request errors, and 5xx for Fly infrastructure errors. The page documents API action rate limits of 1 request/second per action and machine/app identifier, with short bursts up to 3 requests/second.
- **Implications**: The deploy operation uses the token at runtime, treats non-2xx as a failed deployment, and serializes same-app operations with bounded handling for rate limits.

## App resource and Machine configuration

- **Sources**: [Apps resource](https://fly.io/docs/machines/api/apps-resource/), [Machines resource](https://fly.io/docs/machines/api/machines-resource/), and the [Machines API OpenAPI document](https://fly.io/docs/api/machines/openapi.json) (consulted 2026-11-06).
- **Findings**: `POST /v1/apps` creates an app with `name` and `org_slug`, and supports create-time `network` and `enable_subdomains`. The OpenAPI `App` response exposes `name`, `network`, and `organization.slug`, but does not expose `enable_subdomains`; `/v1/apps/{app_name}` has only `GET` and `DELETE`, no update operation. Machine create/update use the Machines API and Machine update requires the full config rather than a partial patch. Machine list responses paginate with the `fly-next-cursor` header.
- **Implications**: App `name`, organization, and network can be checked against the response; if any differ, deployment fails with explicit migration instructions. `enable_subdomains` can only be specified at creation and cannot be drift-checked or updated after the app exists, so it is create-only state. Machine config changes use the full declared config on the API update operation and Machine listing must consume all pages before reconciliation.

## Multi-container Machines

- **Source**: [Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/) (consulted 2026-11-06).
- **Findings**: Fly documents the Machines API `containers` array with per-container image and configuration, and states that the feature requires Pilot as the init system. For the API create body, the array is nested under `config.containers`; other Machine configuration such as `guest` and `services` can be included in the same config object.
- **Implications**: The Nix module preserves a complete raw Machine config and its container array instead of narrowing the option model to a single container. Configs using multiple containers must include Fly's required Pilot configuration as prescribed by the API.

## Token-only automation and Fly registry

- **Sources**: [Integrating flyctl](https://fly.io/docs/flyctl/integrating/) and [`fly auth docker`](https://fly.io/docs/flyctl/cmd/fly_auth_docker/) (consulted 2026-11-06).
- **Findings**: `FLY_API_TOKEN` authenticates flyctl without interactive login and takes precedence over saved login credentials. `fly auth docker` adds `registry.fly.io` to Docker's authenticated registries and accepts `--access-token`. Fly's registry guide documents `registry.fly.io/<app>` image references and pushing images to that registry.
- **Implications**: Registry authentication is performed from the same runtime Fly token; the module neither requires a saved flyctl login nor creates another credential. Registry auth state must be isolated to an ephemeral runtime directory and removed after image publication.

## OCI archive publication

- **Source**: [skopeo-copy(1)](https://github.com/containers/podman-container-tools/blob/main/skopeo/docs/skopeo-copy.1.md) (consulted 2026-11-06).
- **Findings**: Skopeo documents `oci-archive:` and `docker://` image transports, `--authfile` for registry credentials, `--digestfile`, and retry options. It can copy an OCI archive to a registry without requiring a Docker daemon.
- **Implications**: A Nix image derivation has an explicit OCI archive output contract; the deploy helper publishes it with Skopeo using an auth file confined to runtime storage. The chosen Fly registry auth-file format and the exact locked Skopeo package behavior remain implementation verification items.
