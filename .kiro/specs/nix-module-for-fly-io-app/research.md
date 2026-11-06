# Research Notes: Fly.io App Module

External facts used by `design.md`. Documentation and source were read on
2026-11-06. These notes record the researched contract, not implementation
choices; the design states the chosen integration.

## Machines API configuration

- Fly's Machines API creates a Machine with `POST
  /v1/apps/{app_name}/machines`; the request's `config` contains the Machine
  configuration. Updates use `POST
  /v1/apps/{app_name}/machines/{machine_id}` and require the entire Machine
  config, not a partial patch. Machine `name` and `region` are immutable on
  update. Source: [Machines API reference](https://fly.io/docs/machines/api/machines-resource/).
- Multi-container Machines use a `containers` array in the Machine config;
  each container can carry its own image, environment, health checks, startup
  commands, files, and dependencies. Fly documents these Machines as using
  Pilot. The API create body nests the array under `config`. Source:
  [Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/).
- Fly documents `fly.toml` as an app configuration source and documents
  multi-container `machine_config` in the experimental TOML section, including
  a `container` selector for the container replaced by the app image during
  `fly deploy`. Source: [Multi-container Machines](https://fly.io/docs/machines/guides-examples/multi-container-machines/).
- The Apps resource documents app creation (`POST /v1/apps`) with `app_name`,
  `org_slug`, optional `network`, and `enable_subdomains`, and app lookup with
  `GET /v1/apps/{app_name}`. Source: [Apps API reference](https://fly.io/docs/machines/api/apps-resource/).

## Image and authentication behavior

- `flyctl` accepts `FLY_API_TOKEN` to authenticate scripted commands without
  an interactive login; the environment token takes precedence over a saved
  login. Its integration guide documents deploy tokens and use of `fly deploy
  --image` for an already-built image. Source: [Integrating flyctl](https://fly.io/docs/flyctl/integrating/).
- The official Fly registry guide documents image references of the form
  `registry.fly.io/<app-name>:<tag>`, pushing images to that registry, and
  deploying those images. Source: [Managing Docker Images with Fly.io's
  Private Registry](https://fly.io/docs/blueprints/using-the-fly-docker-registry/).
- `fly auth docker` obtains a registry credential through flyctl and writes
  Docker auth JSON to `$HOME/.docker/config.json` (mode `0600`); it does not
  use Docker's `DOCKER_CONFIG` override in the inspected source. The source
  command is defined with a required flyctl session. Isolate the CLI's HOME
  for this operation and remove it after the push; do not place its generated
  registry credential in a Nix store file. `skopeo copy` supports pushing an
  OCI archive using an explicit auth file, avoiding the need for a Docker
  daemon in the activation path. Source: [flyctl
  auth/docker.go](https://github.com/superfly/flyctl/blob/master/internal/command/auth/docker.go),
  [skopeo copy manual](https://github.com/containers/skopeo/blob/main/docs/skopeo-copy.1.md).
- Fly's `flyctl` integration guide states that FLY_API_TOKEN skips interactive
  authentication prompts and is used for commands. The design's interactive
  token provisioning is only a source for the activation process environment;
  it does not ask Kiro to create a token. Source: [Integrating flyctl](https://fly.io/docs/flyctl/integrating/).

## Boundaries of the research

- Skopeo's `oci-archive:<path>` source transport reads an OCI-layout tarball;
  `docker://registry.fly.io/<app>:<tag>` is the registry destination form.
  `skopeo copy --authfile <path> oci-archive:<path> docker://registry.fly.io/<app>:<tag>`
  therefore supplies the archive-to-registry operation without a Docker daemon.
  Source: [containers/image transports
  manual](https://github.com/containers/image/blob/main/docs/containers-transports.5.md)
  and [skopeo copy manual](https://github.com/containers/podman-container-tools/skopeo/blob/main/docs/skopeo-copy.1.md).
- The repo does not currently contain deploy-rs or Colmena inputs, a reusable
  NixOS Fly module, or a Fly deployment implementation. Those are new design
  elements, not existing repository APIs.
- Live app creation, image pushing, and Machine deployment were not run. The
  external-service behavior needs operator verification after implementation;
  pure evaluation and mocked deployment tests remain secret-independent.
