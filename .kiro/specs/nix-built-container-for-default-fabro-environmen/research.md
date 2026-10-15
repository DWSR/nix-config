# Research: nix-built-container-for-default-fabro-environmen

External facts gathered while designing the repo-built default Fabro sandbox
image. Everything below is sourced from the upstream Fabro documentation
(consulted 2026-10-15) and the repository; no repository code was modified by
this research.

## Summary

- Fabro separates **environments** (reusable desired config: provider, image,
  resources, network, lifecycle, labels, env) from **sandboxes** (per-run
  runtime instances).
- The `default` environment is seeded on install as an ordinary persisted
  Docker environment whose image is `buildpack-deps:noble` (CPU 2, memory 4GB,
  network `allow_all`).
- For the Docker provider, `image.docker` is the container image and
  `image.dockerfile` is a warning-only, ignored field. This confirms the brief's
  claim that the Docker provider honors only a prebuilt `image.docker`
  reference.
- Fabro requires `/bin/bash` in the image, evaluates every sandbox command in a
  **non-login** shell, and verifies Bash at initialization and on resume. Login
  profiles are not sourced, so anything they would set must be baked into the
  image's `ENV`.
- Upstream documents an auto-migration of `[environments.*]` tables in the
  server's active `settings.toml` into SQLite on startup. This is the main
  uncertainty behind requirement 5.3 and is recorded as a risk in `design.md`.

## Environment definition schema

Source: <https://docs.fabro.sh/execution/environments.md>

Server-managed environments live in the server SQLite database and are managed
through the web UI or `/api/v1/environments`. The same fields nest under
`[environments.<slug>]` in workflow/project TOML:

```toml
[environments.fabro-dev]
provider = "daytona"

[environments.fabro-dev.image]
docker = "python:3.11-slim"          # Docker: the container image

[environments.fabro-dev.resources]
cpu = 8
memory = "16GB"
disk = "20GB"

[environments.fabro-dev.network]
mode = "allow_all"                    # allow_all | block | cidr_allow_list
allow = []

[environments.fabro-dev.lifecycle]
preserve = false
stop_on_terminal = true
auto_stop = "30m"

[environments.fabro-dev.labels]
repo = "fabro-sh/fabro"

[environments.fabro-dev.env]
NODE_ENV = "development"
```

Runs select an environment by slug:

```toml
[run.environment]
id = "default"
```

## Seeded `default` environment

Source: <https://docs.fabro.sh/execution/environments.md> (`GET
/api/v1/environments/default`):

```json
{
  "id": "default",
  "provider": "docker",
  "image": { "docker": "buildpack-deps:noble", "dockerfile": null },
  "resources": { "cpu": 2, "memory": "4GB", "disk": null },
  "network": { "mode": "allow_all", "allow": [] },
  "lifecycle": { "preserve": false, "stop_on_terminal": true, "auto_stop": null },
  "labels": {},
  "env": {}
}
```

`default` is a normal persisted environment: deleting it removes the default run
target until it is recreated. `local` is synthetic and unpersisted.

## Docker provider field mapping

Source: <https://docs.fabro.sh/execution/environments.md> ("Provider mappings").

| Environment field | Docker behavior |
| - | - |
| `image.docker` | Docker image |
| `image.dockerfile` | Warning; ignored |
| `resources.cpu` | `cpu_quota = cpu * 100000` |
| `resources.memory` | Container memory limit |
| `resources.disk` | Warning; ignored |
| `network.mode = "allow_all"` | Docker default bridge |
| `network.mode = "block"` | Docker `none` network |
| `network.mode = "cidr_allow_list"` | Error |
| `labels` | Warning; ignored |
| `lifecycle.auto_stop` | Warning; ignored |
| `env` | Container environment |
| `cwd` | Warning; ignored |

## Docker image requirements (runtime contract)

Source: <https://docs.fabro.sh/execution/environments.md> ("Docker").

- "The image must provide `/bin/bash`; Fabro evaluates every sandbox command
  with it and has no `sh` fallback."
- "Commands run in a **non-login** shell, so login profiles (`/etc/profile.d/*.sh`,
  `~/.bash_profile`, and `nvm`/`rbenv`/`sdkman` initializers) are not sourced —
  put anything they set into the Dockerfile's `ENV` instead."
- "Fabro verifies Bash during initialization and again on resume, and fails with
  remediation rather than reporting the sandbox ready."
- Docker is clone-based: a run with a GitHub origin is cloned into the provider
  workspace (depth 100 by default).

## `settings.toml` scope

Source: <https://docs.fabro.sh/administration/server-configuration.md>.

- `[environments.<slug>]` and `[run.environment]` are listed under "Shared run
  defaults" and are documented as layering "through `.fabro/project.toml` /
  `workflow.toml`".
- `[server.sandbox.providers.docker].enabled` controls whether the Docker
  provider may launch; the bundled `docker` provider defaults to enabled.
- `[run.model]` and the rest of the `[run.*]` sections in `settings.toml` "act
  as defaults for every run".

## Settings.toml environment auto-migration (risk)

Source: <https://docs.fabro.sh/execution/environments.md> (Warning block).

> "Similarly, `[environments.*]` tables in the server's active `settings.toml`
> are auto-migrated on startup. Existing sibling `environments/*.toml` files are
> then treated as a legacy import source: Fabro imports missing environment IDs
> into SQLite once and renames the directory to
> `environments.imported-<timestamp>.bak`."

Interpretation and impact on requirement 5.3:

- If `[environments.default]` in `settings.toml` is imported into SQLite **once**
  and the SQLite row then wins, a later `settings.toml` edit would not change the
  persisted `default`, and the declarative-wins guarantee (R5.3) would not hold.
- If the table is re-applied (layered) on every startup, R5.3 holds directly.
- The documentation is not explicit about which behavior the pinned build
  (`0.386.0-nightly.0`, tagged 2026-10-14) implements. The brief asserts the
  pinned server honors `[environments.default]` on every start; `design.md`
  therefore makes the declarative `settings.toml` declaration the primary
  mechanism, gates R5.3 behind an explicit startup verification, and records the
  auto-migration behavior as a risk with a fallback (remove/refresh the persisted
  `default` row so the settings-declared one applies).

## `dockerTools` image build facts (nixpkgs)

- `pkgs.dockerTools.buildLayeredImage { name; tag; contents; config; extraCommands; }`
  produces a deterministic, `docker load`-able tar at `$out`. `contents` are
  merged into the image root (`buildEnv` semantics), so a package's `bin/*`
  lands at `/bin/*` — `pkgs.bashInteractive` therefore provides `/bin/bash`.
- `pkgs.closureInfo { rootPaths = contents; }` emits a `registration` file that
  `nix-store --load-db` consumes, so the shipped closure can be registered as
  valid in the container's store database.
- The image tar derivation is referenced by the systemd load unit, which makes it
  a GC root on the guest.

## Repository facts confirmed

- `configurations/fabro-vm/fabro.nix` builds `fabroSettings` with
  `pkgs.formats.toml` and installs it to `<FABRO_HOME>/settings.toml` on every
  `fabro.service` start (`ExecStartPre` `install`); `run.environment.id =
  "default"`; `server.sandbox.providers.docker.enabled = true`.
- `configurations/fabro-vm/default.nix` sets `virtualisation.docker.enable =
  true` and is the module that imports `fabro.nix`; the guest is
  `aarch64-linux`.
- `flake.nix` exposes `packages.aarch64-linux.fabro-vm-image` and the inline
  `fabro-vm-guest-eval` check; there are no `aarch64-linux` checks (the flake's
  `systems` are darwin only), so repository checks over the image are eval-only
  on the mac and the image is built in-guest during `lima-vm-deploy`.
- `home-manager/common/lima-vm.nix` ships `lima-vm-deploy`, which streams the
  tree into the guest and runs `nixos-rebuild switch --sudo --flake
  '<scratch>#fabro-vm'` in-guest.
