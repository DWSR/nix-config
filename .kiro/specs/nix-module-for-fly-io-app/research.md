# Research Notes

Research date: 2026-11-07

## Fly Machines API

- The public Machines API base URL is `https://api.machines.dev`; requests authenticate with `Authorization: Bearer <fly_api_token>`. Documented response classes include 2xx success, 400 bad request, 401 missing/invalid token, 404 missing resource, 408 timeout, 422 validation failure, and 5xx service errors.
- Apps are created with `POST /v1/apps` using `app_name` and `org_slug` (plus optional `network` and `enable_subdomains`); `GET /v1/apps/{app_name}` checks app existence and returns its organization.
- Machines are created using `POST /v1/apps/{app_name}/machines` with a body that wraps the Machine API object under `config`; updates use `POST /v1/apps/{app_name}/machines/{machine_id}` and require the complete config (not a partial patch). The `GET .../machines` listing exposes existing Machine IDs/config; `GET .../machines/{id}/wait` can wait for `started` (default) or other supported states.
- Current multi-container Machines use `config.containers`, with each element a Fly `ContainerConfig` carrying its own image, env, health checks, commands, files, and dependencies. Fly documents this feature as requiring Pilot. Keep arbitrary Machine API fields available through a raw JSON configuration escape hatch so newer API fields are not dropped by typed convenience options.
- Machines API calls are rate-limited per action and machine/app identifier; reconcile sequentially and honor rate limits rather than firing unbounded parallel creates/updates.

Sources:
- https://fly.io/docs/machines/api/working-with-machines-api/
- https://fly.io/docs/machines/api/apps-resource/
- https://fly.io/docs/machines/api/machines-resource/
- https://fly.io/docs/machines/guides-examples/multi-container-machines/

## flyctl automation and registry

- `flyctl` supports noninteractive authentication using runtime `FLY_API_TOKEN`; it takes precedence over any saved interactive login. Its CI integration documentation recommends scoped deploy tokens where possible.
- Fly's private registry path is `registry.fly.io/<app-name>`. `fly auth docker` adds that registry to Docker's configured authenticated registries, but its documented behavior mutates the daemon user's Docker configuration. The deployment design should avoid storing the token or derived registry credential in a Nix store path or persistent config and should use a disposable per-deployment auth config/environment when pushing.
- Fly documents `docker manifest inspect registry.fly.io/<app-name>:<tag>` as an image-existence check; its docs also state there is no API to list all registry tags, and that images/tags become visible when used by releases. This supports an exact deterministic-tag probe rather than broad tag listing.
- `flyctl` supports direct prebuilt-image deployment; its default deploy build is remote, so the Nix module must not invoke that implicit remote image-build path for derivation-backed images.
- Skopeo supports copying an `oci-archive:<path>` OCI tar directly to `docker://registry.fly.io/<app>:<tag>` and accepts a dedicated `--dest-authfile` path. It does not require a Docker daemon for this copy path.
- Docker supports `docker login --password-stdin` to keep passwords out of argv/history/log files; this is a generic registry CLI interface. Fly-specific registry auth still needs validation against the pinned `flyctl`/registry behavior at implementation time.

Sources:
- https://fly.io/docs/flyctl/integrating/
- https://fly.io/docs/blueprints/using-the-fly-docker-registry/
- https://fly.io/docs/flyctl/cmd/fly_auth_docker/
- https://docs.docker.com/reference/cli/docker/login/

## Repository integration findings

- `flake.nix` pins `pdtpartners/nix-snapshotter` and applies `inputs.nix-snapshotter.overlays.default` to the `nixosConfigurations.fabro-vm` module set. `configurations/fabro-vm/sandbox-image.nix` calls `pkgs.nix-snapshotter.buildImage` and extracts the OCI manifest digest; it is a local image-build precedent, not a registry-push implementation.
- The repository defines `nixosConfigurations.fabro-vm` in `flake.nix` and has no deploy-rs or Colmena output or existing Fly module. The module introduced by this spec must be importable by external NixOS flakes; the exported module wrapper can apply the repository-pinned snapshotter overlay and work through normal NixOS activation so remote deployment wrappers can surface its exit status.

Sources:
- `flake.nix`
- `configurations/fabro-vm/sandbox-image.nix`
- `scripts/fabro-sandbox-image-load.nix`
- `configurations/fabro-vm/sandbox.nix`
