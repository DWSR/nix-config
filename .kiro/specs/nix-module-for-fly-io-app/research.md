# Research: nix-module-for-fly-io-app

## Summary

- The updated `brief.md` replaces remote Nixpacks builds with a local, pinned `nix-snapshotter` build/push path. The user accepted a `dockerTools` self-contained base passed through the pinned builder API.
- Fly supports token-authenticated registry publication followed by `fly deploy --image`; multi-container image replacement uses `machine_config` and `container` selection.
- Flake apps provide a stable local deployment entry point per app; stock deploy-rs and Colmena do not deploy API-only Fly app hosts.
- A snapshotter-only Nix closure layer is not self-contained on Fly. Full Machine API fidelity cannot be promised by `flyctl deploy` alone.
- The pinned publisher runs on Linux. The user accepted Linux-only flake app invocation and chose an operator guarantee against out-of-band Fly deployments, not an enforcement guard.

## Research Log

### Image build and publish

- Pinned input: `flake.nix` / `flake.lock` pin `pdtpartners/nix-snapshotter` revision `8e875fb8eeb28947e2b4c3e7552f511d8d1f405a`; `configurations/fabro-vm/sandbox-image.nix` uses `buildImage`, but the resulting local image depends on host `/nix/store` mounts from `configurations/fabro-vm/sandbox.nix`.
- The pinned builder's Nix layer contains store symlinks and empty mount points, not the store closure. `buildImage.fromImage` can import a self-contained image produced by `dockerTools`; keep the snapshotter-specific closure layer empty. This is source-based feasibility, not a Fly boot test: https://github.com/pdtpartners/nix-snapshotter/blob/8e875fb8eeb28947e2b4c3e7552f511d8d1f405a/package.nix
- `buildImage.copyToRegistry` publishes OCI archives and uses Docker-compatible credentials from `DOCKER_CONFIG`; it does not read `FLY_API_TOKEN` directly. Fly's `fly auth docker` uses the Fly token as registry password. A runtime-only temporary Docker config can bridge the single token: https://docs.fly.io/security/tokens/ ; https://github.com/pdtpartners/nix-snapshotter/blob/65f7f0546596d2a60fc1987a1b04ef7a145211bd/pkg/dockerconfigresolver/dockerconfigresolver.go
- Fly documents `registry.fly.io/<app>:<tag>` and `fly deploy --app <app> --image <reference>` for existing images: https://docs.fly.io/blueprints/using-the-fly-docker-registry/ ; https://docs.fly.io/launch/deploy/
- Registry availability must be checked before skipping a push: unchanged derivation identity is not proof that an earlier tag still exists. Authentication or network failures during inspection are not evidence of a missing image. The user chose failure without republishing when a previously published image disappears and the host retains its publication record. The user explicitly chose automatic first publish, accepting that lost state or a new host can republish an unchanged image.

### Fly configuration and deployment tools

- Fly Machines API accepts complete Machine `config` objects; update requires a complete config. Multi-container Machines use `containers` and Pilot: https://fly.io/docs/machines/api/machines-resource/ ; https://docs.fly.io/machines/guides-examples/multi-container-machines/
- Fly `fly.toml` supports `[experimental].machine_config` and a named container for image replacement. Its conversion code overwrites selected machine fields, so `flyctl deploy` alone cannot guarantee arbitrary Machines API fields remain intact. App settings can use `flyctl deploy`; full Machine reconciliation needs the direct API or a proved lossless alternative: https://github.com/superfly/flyctl/blob/master/internal/appconfig/machines.go
- Fly Launch manages Machines with its ownership metadata; API-created Machines are unmanaged. App config cannot be applied by a documented app-settings-only API. The user chose `flyctl deploy` followed by full API reconciliation/verification of all declared Machines on each invocation; external `flyctl deploy` is operator-prohibited but not programmatically blocked: https://fly.io/docs/launch/deploy/#machines-not-managed-by-fly-launch ; https://fly.io/docs/machines/api/apps-resource/
- The pinned `copyToRegistry` invokes a Linux-only publisher; a Linux build machine or VM must also execute the push, not merely build the archive: https://github.com/pdtpartners/nix-snapshotter/blob/8e875fb8eeb28947e2b4c3e7552f511d8d1f405a/package.nix
- Nix flake `apps.<system>.<name>.program` exposes a runnable deployment command; `nix run '.#deploy-<app>'` can be invoked independently or from an external orchestration script: https://nix.dev/manual/nix/latest/command-ref/new-cli/nix3-run
- Stock deploy-rs uses SSH even for `localhost` custom activation. Colmena requires NixOS host profiles; `apply-local` cannot address independent app targets from Darwin: https://github.com/serokell/deploy-rs/blob/master/src/deploy.rs ; https://github.com/nix-community/colmena/blob/main/src/command/apply_local.rs
- NixOps4 has per-resource `apply <path>` and a local exec provider but is still in development. NixOps 2 supports resource plugins but is low-maintenance. Morph and Nixinate retain SSH/NixOS host activation: https://nixops.dev/manual/development/providers/local/exec.html ; https://github.com/NixOS/nixops/blob/master/doc/plugins/authoring.rst ; https://github.com/DBCDK/morph/blob/master/README.md ; https://github.com/MatthewCroughan/nixinate

---

## Gap Analysis

| Requirements | Existing asset | Gap |
|---|---|---|
| 1, 2 | No Fly app module; pinned Fly CLI only in personal Home Manager config | Missing: reusable declaration, rendering, and complete Machine reconciliation |
| 3 | `sandbox-image.nix` builds a local OCI archive; `fabro-sandbox-image-load.nix` loads it locally | Missing: self-contained Fly image, registry publication, remote availability detection, and stable content identity |
| 4 | `flake.nix` exports system-specific `apps`, but no Fly deployment command | Missing: per-app app generation and local command failure propagation tests |
| 5, 6 | Fly CLI user install and runtime-only secret patterns in `sandbox.nix` | Missing: token-only registry/CLI/API wiring, confidential temporary credentials, and redaction tests |

- **Extend existing components**: reuse Fabro sandbox image and loader. Rejected: their guest-store mount and Podman load lifecycle do not work on Fly.
- **Create entirely new components**: separate builder, module, deploy client. Viable but would duplicate the pinned image-builder wiring.
- **Hybrid**: new Fly module and per-app flake runtime, reuse pinned `nix-snapshotter` API and `dockerTools` packaging, modify `flake.nix` exports. Best fit for ownership and existing inputs; belongs as a design decision in `design.md`.
- **Effort**: L/XL, because build/publish, app settings, Machine reconciliation, and per-app output generation cross several systems. **Risk**: High, because Fly image boot and non-lossy Machine application are not demonstrated by existing code.
- **Validation gates**: prove self-contained image boots on Fly; test registry auth with one token on Linux; prove full Machine fields survive repeated `flyctl deploy` plus direct API reconciliation; test automatic first publish, intact-state remote image loss, state loss, and script-visible failure.
