# Implementation Plan

- [ ] 1. Flake input and guest plumbing
- [x] 1.1 Add the pinned `nix-snapshotter` input and thread it into the guest
  - Add the `nix-snapshotter` flake input following `nixpkgs` and record its locked `rev`/`narHash` in `flake.lock`.
  - Add `inputs.nix-snapshotter.overlays.default` to the fabro-vm `nixpkgs.overlays` list so `pkgs.nix-snapshotter` resolves, and pass the input through `specialArgs`.
  - Confirm the guest config evaluates cleanly on darwin and `pkgs.nix-snapshotter.buildImage` resolves to a function.
  - _Requirements: 2.2, 2.3_

- [ ] 2. Sandbox image and digest derivations
- [x] 2.1 Define `fabro.sandboxImage` options and the image archive derivation
  - Create `configurations/fabro-vm/sandbox-image.nix` exposing `fabro.sandboxImage.{enable,name,tag,contents,imageConfig,copyToRoot,archive,digest}` (archive/digest read-only) and import it from `configurations/fabro-vm/default.nix`.
  - Build `archive` with `pkgs.nix-snapshotter.buildImage` over `copyToRoot = pkgs.buildEnv { pathsToLink = [ "/bin" ]; }` carrying `bashInteractive`, `git`, `coreutils`, and `nix`; pin `name`/`tag`.
  - Set `imageConfig = { Env = [ "PATH=/bin" "NIX_REMOTE=daemon" ]; Cmd = [ "/bin/bash" ]; WorkingDir = "/"; }`.
  - Confirm the derivation is an `aarch64-linux` `nix-image-*.tar` whose `copyToRoot` resolves to the four named packages and whose config carries the PATH/Cmd invariants.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.4_

- [x] 2.2 Add the OCI manifest-digest derivation
  - Add `digest = pkgs.runCommand ... { nativeBuildInputs = [ pkgs.jq pkgs.coreutils ]; }` extracting `tar -xOf ${archive} index.json | jq -r '.manifests[0].digest'`.
  - Emit exactly one `sha256:<hex>` line to `$out`; fail the build when `index.json` is missing or the value is not `sha256:`-prefixed.
  - Confirm a fixture archive yields a single `sha256:` line, a malformed archive fails the derivation, and the digest is only read at run time (no IFD).
  - _Requirements: 2.5, 2.6_

- [ ] 3. Local image loader
- [x] 3.1 (P) Implement the loader script
  - Create `scripts/fabro-sandbox-image-load.nix` as a `writeShellApplication` (`runtimeInputs = [ pkgs.podman pkgs.coreutils ]`).
  - Run `podman load -i ${archive}`; read `digest=$(cat ${digest})`, form `ref="${name}@${digest}"`, and verify with `podman image exists "$ref"`, failing with the ref on mismatch.
  - Write the digest to `/run/fabro-sandbox/digest` (mode 0644), retain the local `<name>:<tag>` tag, and issue no push/registry call.
  - Confirm the script text performs the load, the digest-reference check, and the digest write, and contains no registry/push invocation.
  - _Boundary: Sandbox Image Loader_
  - _Requirements: 3.1, 3.3, 3.5, 3.6_

- [x] 3.2 Declare the loader unit and gate `fabro.service` on it
  - Create `configurations/fabro-vm/sandbox.nix` with `fabro-sandbox-image-load.service` (`Type = "oneshot"`, `RemainAfterExit`, `wantedBy = [ "multi-user.target" ]`, `after`/`requires = [ "podman.socket" ]`, `RuntimeDirectory = "fabro-sandbox"`) and import it from `default.nix`.
  - Embed the archive and digest store paths in `ExecStart` so a contents change rewrites the unit (reloading the image) and an unchanged image leaves the unit untouched.
  - Add `fabro.service` `after`/`wants` for the loader so the image is loaded before Fabro can use it.
  - Confirm the rendered unit is a oneshot referencing both store paths and that `fabro.service` orders after the loader.
  - _Requirements: 3.1, 3.2, 3.4, 3.6_

- [ ] 4. Environment reconciler
- [ ] 4.1 (P) Implement the reconciliation script
  - Create `scripts/fabro-sandbox-env-reconcile.nix` as a `writeShellApplication` (`runtimeInputs = [ pkgs.curl pkgs.jq pkgs.coreutils ]`) that builds `ref="${name}@$(cat /run/fabro-sandbox/digest)"`.
  - GET `/api/v1/environments/default` with `Authorization: Bearer $FABRO_DEV_TOKEN`; on 404 report `declared=<ref> persisted=<missing>`; read `revision` and `.image.docker`.
  - Exit 0 unchanged when `.image.docker == ref`; otherwise PUT with `If-Match: "<revision>"` and a body from `jq 'del(.id, .revision) | .image.docker = $ref'`; any other status reports both references and the HTTP status.
  - Confirm the script text issues a GET, compares `.image.docker`, sends `If-Match` on the PUT, and names declared/persisted on failure.
  - _Boundary: Environment Reconciler_
  - _Requirements: 4.1, 4.2, 4.4, 4.5, 4.6_
  - _Blocked: Implement stage for task 4.1 failed without a usable status report (no impl_blocker/impl_summary/review_findings); re-run implement with a status report to unblock._

- [ ] 4.2 Declare the reconciler unit
  - Add `fabro-sandbox-env.service` to `sandbox.nix` (`Type = "oneshot"`, `RemainAfterExit`, `wantedBy = [ "multi-user.target" ]`, `after`/`requires = [ "fabro.service" "fabro-sandbox-image-load.service" ]`) running as root.
  - Set `EnvironmentFile = config.sops.templates."fabro-env".path` so the reconciler reads `FABRO_DEV_TOKEN` from the sops store.
  - Confirm the rendered unit is a oneshot ordered after both services and consumes the sops template path.
  - _Depends: 3.2_
  - _Requirements: 4.3, 4.5, 4.6_

- [ ] 5. Host Nix store and daemon sharing
- [ ] 5.1 Add global `containers.conf` mounts for the host store and daemon
  - In `sandbox.nix`, set `virtualisation.containers.containersConf.settings.containers.mounts` to `"type=bind,source=/nix/store,destination=/nix/store,ro"` and `"type=bind,source=/nix/var/nix/daemon-socket,destination=/nix/var/nix/daemon-socket"`.
  - Keep the mounts global (`[containers]`, not per-environment) so every Podman-created container receives them, with the store read-only.
  - Confirm the generated `/etc/containers/containers.conf` carries both mount entries and the store mount is `ro`.
  - _Depends: 3.2_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 6. Sandbox smoke check
- [ ] 6.1 (P) Implement the smoke script and install it in the guest
  - Create `scripts/fabro-sandbox-smoke.nix` as a `writeShellApplication` defaulting the reference to `localhost/fabro-sandbox@$(cat /run/fabro-sandbox/digest)`.
  - Probes: tools (`bash --version; git --version; command -v nix`), store (`test -e /nix/store; ls /nix/store`), daemon (`nix store ping`).
  - Print a step banner before each probe, exit non-zero naming the failed step, and add the script to `environment.systemPackages`.
  - Confirm the script text contains all three probes and a step-named failure path.
  - _Boundary: Sandbox Smoke Check_
  - _Depends: 2.2, 5.1_
  - _Requirements: 6.3, 6.4, 6.5_

- [ ] 7. Repository checks and flake outputs
- [ ] 7.1 Add the pinned-input check
  - Add `checks.<system>.fabro-sandbox-pinned` as a `runCommand` that reads `flake.lock` and asserts the `nix-snapshotter` node has `locked.rev` and `locked.narHash`.
  - Fail evaluation with a named message when the lock entry is absent or unpinned.
  - Confirm a fixture lock missing `rev`/`narHash` fails and the real lock passes.
  - _Depends: 1.1_
  - _Requirements: 2.2, 2.3, 6.1, 6.2_

- [ ] 7.2 Extend the guest-eval check with sandbox assertions
  - Add `assertMsg` chains to `fabro-vm-guest-eval`: `fabro.sandboxImage.enable`; the loader unit exists, is a oneshot, and its `ExecStart` references the archive and digest store paths; `fabro.service` is after/wants the loader; the reconciler unit exists, is a oneshot, is after `fabro.service` and the loader, and consumes the sops template; the containers mounts list holds the `/nix/store` ro bind and the daemon-socket bind; `run.environment.id == "default"`.
  - Update the check's summary string to describe the sandbox image, loader, reconciler, and host-store sharing.
  - Confirm `nix build .#checks.<darwin>.fabro-vm-guest-eval` passes and each assert fails with a named message when its element is removed.
  - _Depends: 2.1, 2.2, 3.2, 4.2, 5.1_
  - _Requirements: 6.1, 6.2_

- [ ] 7.3 Add the Node test harness and its flake check
  - Create `tests/fabro-sandbox/{helpers.js,image.test.js,wiring.test.js,package.json}` reusing the `tests/fabro-service` `nixEvalJson` pattern.
  - `image.test.js`: assert `imageConfig.Env` has `PATH=/bin` and `NIX_REMOTE=daemon`, `Cmd == [ "/bin/bash" ]`, `copyToRoot` names bash/git/coreutils/nix, and the digest derivation reads `index.json` and writes a `sha256:` line.
  - `wiring.test.js`: assert the loader/reconciler unit shape and ordering, the containers mounts, `run.environment.id`, and the reconciler script GET/compare/`If-Match` flow; register `checks.<system>.fabro-sandbox-tests` as a `node --test` `runCommand`.
  - Confirm `node --test tests/fabro-sandbox/` passes and `nix build .#checks.<darwin>.fabro-sandbox-tests` succeeds.
  - _Depends: 2.2, 3.2, 4.2, 5.1_
  - _Requirements: 6.1, 6.2_

- [ ] 7.4 Expose the image, digest, and smoke script as flake packages
  - Add `packages.aarch64-linux.fabro-sandbox-image`, `fabro-sandbox-image-digest`, and `fabro-sandbox-smoke` bound to the guest derivations.
  - Confirm each attribute evaluates on `aarch64-linux` and the smoke attribute resolves to the smoke script derivation.
  - _Depends: 2.2, 6.1_
  - _Requirements: 2.6, 6.3_

- [ ]* 7.5 (P) Verify reproducibility and end-to-end wiring on the guest
  - Build the image twice from identical inputs and confirm the digest is unchanged.
  - Run `nixos-rebuild switch`, confirm the loader records the digest and the reconciler sets `image.docker` to the digest reference, and run `fabro-sandbox-smoke` (tools, store, daemon) to success.
  - Confirm a contents change changes both the digest and the environment reference.
  - _Boundary: Full Feature Integration_
  - _Requirements: 2.1, 3.1, 4.2, 6.3, 6.4_
