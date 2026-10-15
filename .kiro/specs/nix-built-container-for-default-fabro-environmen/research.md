# Research & Design Decisions

## Summary

- **Feature**: `nix-built-container-for-default-fabro-environmen`
- **Discovery Scope**: Complex integration (new flake input + Linux-only image
  derivation + guest systemd wiring + Fabro REST reconciliation + Podman
  engine configuration).
- **Key Findings**:
  - `nix-snapshotter`'s `buildImage` emits an **OCI archive** whose single layer
    contains only empty `/nix/store/<path>` mountpoints plus rootfs symlinks;
    the real store contents are supplied by the snapshotter at run time. Loaded
    into a plain engine (Podman) the store paths are empty until a real
    `/nix/store` is bind-mounted over them — which is exactly the host-store
    sharing Requirement 5 mandates. The image archive is a store-path
    *manifest*, not a self-contained rootfs.
  - Fabro exposes server-managed environments through
    `/api/v1/environments/{id}` with ETag/`If-Match` optimistic concurrency; the
    seeded `default` environment is ordinary persisted SQLite state, so a
    settings declaration alone does not track a rebuild. Reconciliation must
    GET the revision then conditionally PUT.
  - NixOS 26.05 generates `/etc/containers/containers.conf` from
    `virtualisation.containers.containersConf.settings`, which supports a
    `[containers] mounts` list applied to every container — the only
    repo-owned seam for host-store/daemon sharing (Fabro's environment schema
    has no mount field).
  - `switch-to-configuration` in the pinned nixpkgs is the Rust
    `switch-to-configuration-ng`; a systemd unit that fails during a `switch`
    sets `exit_code = 4` and exits non-zero, so a failing loader oneshot fails
    the switch.

## Research Log

### nix-snapshotter `buildImage` interface and output

- **Context**: The brief requires building the sandbox image with
  `pdtpartners/nix-snapshotter` and identifying it by content digest.
- **Sources Consulted**:
  - `https://github.com/pdtpartners/nix-snapshotter` (README)
  - `package.nix` (buildImage signature)
  - `pkg/nix2container/build.go`, `generate.go`, `export.go`
  - `cmd/nix2container/build.go`, `load.go`
  - `docs/architecture.md`
- **Findings**:
  - Signature (overlay-provided `pkgs.nix-snapshotter.buildImage`):
    `{ name, tag ? "latest", resolvedByNix ? false, fromImage ? null,
    copyToRoot ? null, config ? {} }`. It returns a `runCommand` whose
    `outPath` is `nix-image-<baseName>.tar`, with passthru `{ name, tag,
    image, copyToRegistry, copyToContainerd }`.
  - `copyToRoot` is a derivation (or list); store-path prefixes are stripped so
    contents land at the image `/`. `pkgs.buildEnv { paths; pathsToLink =
    ["/bin"]; }` is the documented way to place binaries in `/bin`.
  - `config` is an OCI image config (Go `ocispec.ImageConfig`: `Env`, `Cmd`,
    `WorkingDir`, `Entrypoint`, ...) serialized to JSON.
  - `Build` sets `Architecture = runtime.GOARCH`, `OS = runtime.GOOS` of the
    **build host** — building on the aarch64-linux guest yields an
    aarch64-linux image.
  - `writeNixClosureLayer` (generate.go) writes, for every store path in the
    runtime closure, an **empty directory** (or empty file), and for each
    `copyToRoot` entry a symlink from the rootfs path to the store path. The
    layer is therefore tiny; real content is bind-mounted by the snapshotter.
  - `tarDir` sets `archive.WithModTimeUpperBound(time.Time{})` (epoch 0) and
    forces uid/gid 0, so layers are bit-reproducible.
  - `Export` (export.go) uses containerd `core/images/archive.Export` with
    `WithManifest(desc, ref)`.
- **Implications**: The image is a store-path manifest; it is only runnable
  when `/nix/store` is present in the container (host bind mount). The image
  derivation is content-addressed, so identical inputs reproduce the archive.

### OCI archive layout and manifest digest

- **Context**: The digest derivation must extract a stable content digest from
  the archive.
- **Sources Consulted**: containerd `core/images/archive/exporter.go`.
- **Findings**: `Export` writes an OCI image layout tar (`oci-layout`,
  `index.json` = `ocispec.ImageIndexFile`, `blobs/sha256/...`) and, unless
  `WithSkipDockerManifest` is set, a Docker-compatible `manifest.json`.
  `WithManifest(desc, ref)` adds the manifest descriptor (with the
  `org.opencontainers.image.ref.name` annotation set to `ref`) to the index.
  The manifest digest is `index.json` → `.manifests[0].digest`.
- **Implications**: The digest derivation untars `index.json` and reads
  `.manifests[0].digest`; the reference is `<name>@<digest>`. `manifest.json`'s
  `Config` entry is the config (image ID) digest, available as a fallback.

### Podman load of an OCI archive

- **Context**: The loader must make the image resolvable by digest.
- **Sources Consulted**: `podman-load`/containers.conf documentation; the
  archive contents above.
- **Findings**: `podman load` accepts OCI-archive and docker-archive inputs.
  The nix2container archive is an OCI layout (`index.json`), whose index
  descriptor carries the manifest digest; loading it records that digest as
  the image RepoDigest (docker-archive loads record no manifest digest because
  that format has none). This is the load-bearing assumption for digest
  references.
- **Implications**: The loader loads the archive and **verifies** that
  `<name>@<digest>` resolves (`podman image exists`); a divergence fails the
  loader (and thus the switch) instead of silently referencing a mutable tag.
  This is a runtime verification checkpoint, not a design assumption.

### Fabro environments API

- **Context**: The `default` environment must track the built image digest.
- **Sources Consulted**:
  - `https://docs.fabro.sh/execution/environments.md`
  - `https://docs.fabro.sh/api-reference/environments/replace-environment.md`
    (OpenAPI fragment)
- **Findings**:
  - Server-managed environments live in SQLite; `/api/v1/environments` manages
    them. Install seeds `default` (`provider = "docker"`,
    `image.docker = "buildpack-deps:noble"`, cpu 2, memory 4GB). `local` is
    synthetic and unpersisted.
  - `GET /api/v1/environments/{id}` → `Environment` with `revision` (64-hex)
    and an `ETag` header.
  - `PUT /api/v1/environments/{id}` requires `If-Match: "<revision>"` and a
    body (`ReplaceEnvironmentRequest`, no `id`) with required `provider`,
    `image`, `resources`, `network`, `lifecycle`, `labels`, `env`. Returns 200
    + new ETag. Errors: 400, 404, 409 (revision/protected), 422, 428 (missing
    `If-Match`), 500.
  - `image.docker` is a plain string; a digest reference is valid.
  - `[environments.*]` tables in `settings.toml` are auto-migrated into SQLite
    **only for missing IDs**, so a declaration does not overwrite the persisted
    `default`.
  - The Docker provider requires `/bin/bash`; it runs `bash -c` in a
    **non-login** shell, so the image `Env.PATH` must carry the tool path.
- **Implications**: Reconciliation is GET → compare → conditional PUT. The
  environment schema has no mount field, confirming engine-level host-store
  sharing is the only seam.

### NixOS Podman / containers.conf

- **Context**: Host-store and daemon sharing must apply to every sandbox
  container.
- **Sources Consulted**:
  - nixpkgs `04f2338dd72b93278448fb3e3e5cd71af207edb9`
    `nixos/modules/virtualisation/containers.nix`,
    `.../podman/default.nix`
  - `containers.conf(5)` (`containers/common`).
- **Findings**:
  - `virtualisation.podman.enable = true` sets
    `virtualisation.containers.enable = true` and generates
    `/etc/containers/containers.conf` from
    `virtualisation.containers.containersConf.settings` (TOML freeform).
  - `[containers] mounts` is a list of mount specs:
    `"type=bind,source=<dir>,destination=<dir>,<options>"`, applied to every
    container. `[containers] env` sets container env, `[engine] env` sets
    engine env.
- **Implications**: Add the `/nix/store` read-only bind and the Nix daemon
  socket bind under `[containers] mounts`; this is global and needs no
  per-environment configuration.

### switch-to-configuration failure semantics

- **Context**: Requirement 3.6 requires a load failure to fail the switch.
- **Sources Consulted**: nixpkgs
  `pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs` (pinned rev).
- **Findings**: On `switch`, the Rust implementation sets `exit_code = 4` for
  units that fail to start and exits with it; failed units are also reported.
  New `wantedBy = multi-user.target` units are pulled in when the target is
  restarted during the switch.
- **Implications**: A systemd oneshot that runs `podman load` and exits
  non-zero on failure satisfies Requirement 3.6 without an activation script.

### Fabro-side constraints from the repository

- **Context**: Anchor the design in the real guest config.
- **Sources Consulted**: `configurations/fabro-vm/{default,fabro,image}.nix`,
  `flake.nix` (fabro-vm `nixosSystem`, `fabro-vm-guest-eval` check,
  `packages.aarch64-linux.fabro-vm-image`), `docs/opencode-fabro-vm-handoff.md`.
- **Findings**:
  - The guest is `nixosConfigurations.fabro-vm` (aarch64-linux), with
    `virtualisation.podman.{enable,dockerSocket,dockerCompat}` and
    `run.environment.id = "default"` in the generated `settings.toml`.
  - `fabro.service` runs as the Lima cidata user `brandonmcnama`, consumes
    `sops.templates."fabro-env"` (which already carries `FABRO_DEV_TOKEN`),
    and requires `podman.socket` + `litellm.service`.
  - The `fabro-vm-guest-eval` flake check is a **pure eval** over
    `self.nixosConfigurations.fabro-vm.config` (aarch64-linux evaluable from
    darwin); building `fabro-vm-image` needs a Linux builder.
  - Repo conventions: nixfmt-rfc-style, statix/deadnix clean, Node
    `node --test` harnesses under `tests/<spec>/` wrapped in `runCommand`
    checks, scripts under `scripts/*.nix` as `writeShellApplication`.
- **Implications**: Image/digest derivations are evaluable on darwin but built
  on the guest; the digest must not be forced at eval time (IFD would demand a
  Linux builder on darwin), so it is consumed at run time by the loader.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|---|---|---|---|---|
| Engine-level store mount + nix-snapshotter archive | Load the OCI archive into Podman; bind-mount host `/nix/store` into every container | Matches the brief; no Fabro schema change; no registry | Archive alone is not self-contained; relies on host store retention | Selected |
| Bake a self-contained rootfs (`dockerTools.buildImage`) | Standard OCI image with real layer contents | Runs without host store | Duplicates the store; violates the nix-snapshotter requirement; large layers | Rejected |
| Fabro-side mounts | Add a mount field to the environment | Per-environment control | Fabro's schema has no mount field | Rejected (out of boundary) |
| Declare the digest in `settings.toml` | Static digest in server settings | Simple | Requires IFD; breaks pure eval on darwin; ignored for existing `default` | Rejected |

## Design Decisions

### Decision: Image identity is the OCI manifest digest from `index.json`

- **Context**: Fabro must reference the image by content digest.
- **Alternatives Considered**:
  1. Manifest digest from the OCI index.
  2. Config digest (image ID) from `manifest.json`.
  3. Mutable tag.
- **Selected Approach**: Extract `index.json` → `.manifests[0].digest` in a
  companion derivation; reference `<name>@sha256:<digest>`.
- **Rationale**: Matches the brief, identifies the whole image, and is what an
  OCI-layout `podman load` records as the RepoDigest.
- **Trade-offs**: Requires the loader to verify resolvability; the config
  digest remains available if a format quirk surfaces.
- **Follow-up**: The loader asserts `podman image exists <ref>`; the smoke check
  confirms a run by digest.

### Decision: Digest is a build artifact consumed at run time, not eval time

- **Context**: Embedding the digest in `settings.toml` would force the
  aarch64-linux digest derivation during evaluation (IFD), which the darwin
  host cannot build.
- **Alternatives Considered**:
  1. IFD into settings — breaks the darwin eval check.
  2. Runtime resolution by the loader/reconciler.
- **Selected Approach**: The loader embeds the archive and digest derivation
  **store paths**, loads the image, records the digest under
  `/run/fabro-sandbox/digest`, and the reconciler reads it.
- **Rationale**: Keeps the guest configuration purely evaluable on darwin while
  making the digest available to the guest at run time (Requirement 2.6).
- **Trade-offs**: The environment's image is owned by the reconciler rather
  than declared in `settings.toml`.

### Decision: Host-store sharing is global containers.conf mounts

- **Context**: Requirement 5 needs every sandbox container to see the store and
  daemon without per-environment config.
- **Selected Approach**: `containersConf.settings.containers.mounts` with
  `type=bind,source=/nix/store,destination=/nix/store,ro` and the daemon socket
  directory bind (read-write, so the socket is usable).
- **Rationale**: Fabro's environment schema has no mount field; containers.conf
  applies to every container.
- **Trade-offs**: The daemon is exposed to sandboxed agents by design (brief
  Out of Boundary).

## Risks & Mitigations

- **Podman records no manifest digest for the loaded archive** — the loader
  verifies `podman image exists <ref>` and fails the switch; the config digest
  is available from the same archive if the reference form must change.
- **Host GC removes a store path a sandbox still needs** — explicitly out of
  boundary; the image and its store paths are GC roots via the image and the
  system closure.
- **Digest reference accepted by Fabro but not resolvable locally** — the
  reconcile verifies the loader-recorded digest before PUT; the smoke check
  runs a container by digest.
- **No Linux builder on the host** — image/digest derivations are only built
  in-guest; the darwin check is pure eval.

## References

- [pdtpartners/nix-snapshotter](https://github.com/pdtpartners/nix-snapshotter) —
  `buildImage`, OCI archive output, layer semantics.
- [containerd archive exporter](https://github.com/containerd/containerd/blob/main/core/images/archive/exporter.go) —
  OCI layout `index.json` and manifest digest.
- [Fabro Environments](https://docs.fabro.sh/execution/environments.md) —
  server-managed environments, seeded `default`, provider mappings.
- [Fabro Replace environment](https://docs.fabro.sh/api-reference/environments/replace-environment.md) —
  `PUT /api/v1/environments/{id}` with `If-Match`.
- [containers.conf(5)](https://github.com/containers/common/blob/main/docs/containers.conf.5.md) —
  `[containers] mounts`.
- [NixOS containers module](https://github.com/NixOS/nixpkgs/blob/04f2338dd72b93278448fb3e3e5cd71af207edb9/nixos/modules/virtualisation/containers.nix) —
  `containersConf.settings`.
- [switch-to-configuration-ng](https://github.com/NixOS/nixpkgs/blob/04f2338dd72b93278448fb3e3e5cd71af207edb9/pkgs/by-name/sw/switch-to-configuration-ng/src/main.rs) —
  exit code 4 on failed units.
