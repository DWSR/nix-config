# Implementation Plan

- [ ] 1. Make the Fabro Guest daemon the only Darwin dispatch client

- [x] 1.1 (P) Implement the runtime machines-file renderer
  - Create `scripts/fabro-darwin-machines.nix` as a `writeShellApplication` implementing the design CLI: `--output`, `--host-name`, `--ssh-user`, `--system`, `--max-jobs`, `--speed-factor`, `--client-key`, `--host-key`.
  - Emit exactly `ssh-ng://<ssh-user>@<host> <system> <client-key-path> <max-jobs> <speed-factor> - - <base64 host key>`, base64-encoding the host key file contents and never emitting `-` for the host key.
  - Read the client key only by path; write atomically (temp file + `mv`, mode `0600`, owner root) so no partial line can be read.
  - Fail with exit 1 naming the offending path when either file is missing or empty, and write nothing in that case.
  - Done when a temp-directory run writes the expected line with mode `0600`, and each missing/empty key case exits nonzero naming its path while leaving the output unchanged.
  - _Requirements: 3.2, 6.1, 6.2, 6.6, 6.7, 6.12_
  - _Boundary: Machines Renderer_

- [x] 1.2 Add the `fabro.darwinBuilder` option surface and unit wiring
  - Create `configurations/fabro-vm/darwin-dispatch.nix` with the option contract from the design: `enable` (default false), `machine.{hostName,sshUser,system,maxJobs,speedFactor}`, `clientKeyPath`, `hostKeyPath`, `machinesFile`.
  - Default `machine.hostName` to the builder tailnet FQDN and `machine.system` to `aarch64-darwin`; keep a single machine entry so `aarch64-linux` requests never match it.
  - Set `nix.distributedBuilds = true`, `nix.settings.builders = "@${cfg.machinesFile}"`, and `nix.settings.builders-use-substitutes = true`; leave `nix.buildMachines` empty so no eval-time `/etc/nix/machines` appears.
  - Add `systemd.services.fabro-darwin-builders` (oneshot, `RuntimeDirectory`, after `sops-install-secrets.service`, before `nix-daemon.service`), make `nix-daemon.service` want/after it without requiring it, and add the `0600` root tmpfiles entry for `machinesFile`.
  - Leave sandbox mounts, the sandbox image environment, and the guest's `tailscale.nix` untouched so every sandbox keeps the daemon path without per-environment configuration.
  - Done when a standalone evaluation shows the option defaults, `distributedBuilds`, the `@` builders path, `builders-use-substitutes`, the unit ordering, and the tmpfiles rule, with no dispatch wrapper around Nix's own ssh-ng errors.
  - _Requirements: 1.1, 1.2, 1.3, 1.5, 1.6, 1.7, 2.7, 3.1, 3.2, 3.3, 3.6, 6.11, 7.5, 7.6_
  - _Depends: 1.1_

- [x] 1.3 Enable dispatch on `fabro-vm` and declare the build-session secrets
  - Add `./darwin-dispatch.nix` to `configurations/fabro-vm/default.nix` imports and set `fabro.darwinBuilder.enable = true;`.
  - Declare `sops.secrets."build-client-key"` and `sops.secrets."build-host-key"` at mode `0400`, owner/group `root`, at the design's runtime paths, with `restartUnits` for `fabro-darwin-builders.service` and `nix-daemon.service`.
  - Add both names to `fabro.onePasswordSecrets` with the design's 1Password URIs so `fabro-sync-from-1password` refreshes them.
  - Done when the evaluated guest exposes both secrets with their runtime paths and `0400` mode, the option is enabled, and no secret value appears in any store path.
  - _Requirements: 6.8, 6.9, 6.10, 6.11_
  - _Depends: 1.2_

- [ ] 2. Put the Builder Host on the tailnet under its own tag

- [x] 2.1 (P) Implement the launchd tailnet authentication wrapper
  - Create `scripts/mac-builder-tailscale-auth.nix` as a `writeShellApplication` with the CLI contract: `--auth-key-file`, `--hostname`, `--tag`, `--tailscale`, optional `--interval`, `--once`.
  - Each iteration verify the credential file is non-empty, read `tailscale status --json`, and branch on `BackendState`: `Running` does nothing; `NeedsLogin`/`NeedsMachineAuth`/`Stopped` run `tailscale up` with `--auth-key=<secret>?ephemeral=false&preauthorized=true`, `--advertise-tags`, `--hostname`, and `--accept-dns=false`.
  - On a missing or empty credential, log the runtime path and fail the iteration without ever invoking `tailscale up`.
  - Default mode repeats iterations forever with retries (a failed iteration logs and continues); `--once` performs one iteration and exits nonzero unless the node is `Running` or re-authenticated.
  - Done when `--once` against a stub `--tailscale` shows no `up` for `Running`, the exact `up` arguments for `NeedsLogin`, no `up` plus the named path for a missing credential, and a nonzero result for an unresponsive daemon.
  - _Requirements: 4.1, 4.3, 4.8, 4.9, 4.10, 4.11_
  - _Boundary: Tailnet Auth Wrapper_

- [x] 2.2 Declare builder tailnet membership, credential, and auth daemon
  - Create `configurations/mac-builder/tailscale.nix` with `services.tailscale.enable = true` on the default open-source `pkgs.tailscale`; add no macOS app, `tailscale serve`, or `--ssh`.
  - Declare `sops.secrets."builder-tailscale-oauth-secret"` at mode `0400`, owner `root`, group `wheel`, at the design's default runtime path; declare no other tailnet credential and read nothing from the fabro store.
  - Register `launchd.daemons.mac-builder-tailscale-auth` running the wrapper with the credential path, `--hostname mac-builder`, and `--tag tag:mac-builder`, with `RunAtLoad`, `KeepAlive`, `ThrottleInterval = 30`, `ProcessType = "Background"`, and logs under `/var/log/`.
  - Keep the host nix-darwin-only: no Home Manager and no join through the personal host's tailnet node.
  - Done when the evaluated `darwinConfigurations.mac-builder` shows the effective `com.tailscale.tailscaled` LaunchDaemon, the auth LaunchDaemon and its exact arguments, and the secret path/mode, with no auth-key option and no Tailscale SSH.
  - _Requirements: 3.5, 3.7, 3.8, 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.12, 4.13, 4.14, 6.5_
  - _Depends: 2.1_

- [x] 2.3 Import builder membership while preserving the stock remote-builder endpoint
  - Add `./tailscale.nix` to `configurations/mac-builder/default.nix` imports and change nothing in the `nix-builder` user, `services.openssh`, GC/optimise, `trusted-users`, or the `builder-authorized-keys` activation.
  - Confirm the endpoint stays Nix's own sshd plus daemon path: no custom API, queue, scheduler, or extra service, and the daemon still starts under launchd without an interactive login.
  - Confirm the new module does not disturb the existing sops darwin activation ordering or the LAN-forward scripts `mac-builder-deploy` and `mac-builder-readiness`.
  - Done when the host evaluates with the module imported, `extra-platforms` stays unset, root SSH login stays disabled, and the deploy/readiness scripts' evaluated output is unchanged.
  - _Requirements: 4.12, 5.1, 5.2, 5.5, 5.6, 5.7_
  - _Depends: 2.2_

- [x] 3. (P) Restrict the Builder Host to public caches and Darwin only
  - Create `configurations/mac-builder/substituters.nix` setting `nix.settings.substituters` to exactly `https://cache.nixos.org/` and `https://nix-community.cachix.org` with `trusted-public-keys` for exactly those two caches, and import it from `configurations/mac-builder/default.nix`.
  - Add no `extra-substituters`, no Attic or private-cache URL, no cache credential file, and no `post-build-hook`, so the builder never publishes outputs.
  - Assert `extra-platforms` stays unset, `nixpkgs.hostPlatform == "aarch64-darwin"`, and no private-cache host appears in the evaluated substituter or key sets.
  - Done when the evaluated host shows the exact substituter/key sets and each assertion fails for a fixture that adds a private cache host or an extra platform.
  - _Requirements: 5.3, 5.4, 7.1, 7.2, 7.3, 7.4, 7.7_
  - _Boundary: Builder Cache Policy_

- [ ] 4. Document operator material and the tailnet contract

- [x] 4.1 Document the builder OAuth credential provisioning
  - Add the 1Password source `op://Infrastructure/Mac Builder Tailscale Credentials/Client Secret`, the `auth_keys` scope with the `tag:mac-builder` tag, the builder-key edit command, and the `sops -d --extract` verification to `secrets/README.md`.
  - Confirm the design's `## Operator Provisioning` entry and the evaluated `builder-tailscale-oauth-secret` declaration agree on name, runtime path, and consumer.
  - Do not mint, decrypt, or print the credential; the operator creates it in the Tailscale console and 1Password.
  - Done when `secrets/README.md` documents the source, scope/tag, edit flow, and verification, and the design and declaration agree with no plaintext credential in the working tree.
  - _Requirements: 4.3, 4.4, 4.6, 4.7_

- [ ] 4.2 Document build-session key provisioning and rotation
  - Add key generation (`ssh-keygen -t ed25519`), the two 1Password fields, `nix run '.#fabro-sync-from-1password'`, the `builder-authorized-keys` append, rotation, and `sops -d --extract` verification to `secrets/README.md`.
  - Confirm the design's `## Operator Provisioning` entries and the guest `sops.secrets` plus builder authorized-key declarations agree.
  - Do not generate, read, or write a secret value; the operator owns the key pair.
  - Done when `secrets/README.md` covers generation, both 1Password fields, sync, authorized-key append, rotation, and verification, with no secret value in the working tree.
  - _Requirements: 6.1, 6.2, 6.8, 6.9, 6.10_
  - _Depends: 1.3, 4.1_

- [ ] 4.3 Document the tailnet grant, builder identity, and operation steps
  - Create `configurations/mac-builder/README.md` with the required console-side `tagOwners` and grant snippet for `tag:fabro` to `tag:mac-builder` on `tcp:22`, and state that the ACL governs reachability only while SSH keys authenticate the session.
  - Record the builder machine name `mac-builder` and its MagicDNS name, the dedicated OAuth client with its scope and tag, the runtime credential path, and that the guest is never addressed through the LAN forward or a DHCP address.
  - Link to `secrets/README.md` for build-key provisioning and rotation instead of duplicating it, and document the `fabro-darwin-build-smoke` invocation.
  - Done when the README contains the grant, tag ownership, credential setup, and smoke steps, and a reader can apply the console change without reading the spec.
  - _Requirements: 3.4, 3.7, 3.8, 6.4, 6.5_
  - _Depends: 4.1, 4.2_

- [ ] 5. Verify dispatch, trust, and cache behaviour

- [ ] 5.1 Implement and install the Darwin Build Smoke command
  - Create `scripts/fabro-darwin-build-smoke.nix` and install it through the `fabro.darwinBuilder` module's `environment.systemPackages` as `fabro-darwin-build-smoke`; accept an optional `IMAGE_REF` defaulting to `<name>@$(cat /run/fabro-sandbox/digest)`.
  - Step 1 preflight: both secret paths readable and non-empty and the machines file contains an `aarch64-darwin` entry, naming any missing path.
  - Step 2: `podman run --rm <ref> /bin/bash -c '<nix build …>'` requesting the design's trivial `aarch64-darwin` derivation whose builder is `/bin/sh` and whose output is one file.
  - Step 3: confirm the printed store path exists in the guest store and report it.
  - Done when a run with a missing material path fails the preflight step naming that path with a nonzero result, a stubbed successful run prints each step banner and the store path, and the package appears in the evaluated guest system packages.
  - _Requirements: 6.12, 8.5, 8.6, 8.7_
  - _Depends: 1.2, 1.3_

- [ ] 5.2 (P) Add the shared harness and guest dispatch checks
  - Create `tests/fabro-darwin-builds/helpers.js` reusing the `nixEvalJson`/`nixEvalFailure` pattern from `tests/mac-nix-remote-builder/helpers.js`, plus the `package.json` that `node --test` needs.
  - `guest-dispatch.test.js`: assert the `fabro.darwinBuilder` option values, `nix.distributedBuilds`, `builders = "@<path>"` outside the store, `builders-use-substitutes`, the renderer unit and its ordering, the tmpfiles rule, and both `sops.secrets` entries.
  - Assert the sandbox invariants unchanged: exactly the store, daemon-socket, and tmpfs `[containers]` mounts; image `Env` with `NIX_REMOTE=daemon`; no key path, builder key, or tailscale membership in the image or sandbox wiring.
  - Done when the suite passes on the real configuration and each assertion fails when its element is removed.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.2, 3.3, 8.1, 8.4_
  - _Boundary: Guest Dispatch Tests_
  - _Depends: 1.3_

- [ ] 5.3 (P) Add builder tailnet, endpoint, and cache checks
  - `builder-tailnet.test.js`: assert `services.tailscale` enabled with the open-source package, the `com.tailscale.tailscaled` LaunchDaemon, the auth LaunchDaemon arguments (`--hostname mac-builder`, `--tag tag:mac-builder`, `--accept-dns=false`), and the secret name/path/mode.
  - Assert the endpoint contract holds: `trusted-users = [ "nix-builder" ]`, `nix-builder` non-admin, `PermitRootLogin no`, no `extra-platforms`, and no custom build service.
  - Assert the evaluated `nix.settings.substituters`/`trusted-public-keys` are exactly the two public caches with no private-cache host, and drive `mac-builder-tailscale-auth --once` against a stub for the `Running`, `NeedsLogin`, missing-credential, and unresponsive cases.
  - Done when the suite passes and every assertion or behaviour case fails when its subject is changed.
  - _Requirements: 3.5, 3.7, 3.8, 4.1, 4.2, 4.5, 4.6, 4.9, 4.12, 4.14, 5.1, 5.2, 5.3, 5.4, 5.7, 7.1, 7.2, 7.3, 8.2_
  - _Boundary: Builder Tailnet Tests_
  - _Depends: 2.3, 3_

- [ ] 5.4 (P) Add secret-material and trust checks
  - `secret-material.test.js`: assert the machines file is rendered outside the store and `/etc`, `builders` references it by `@` path, the machines line carries the client key path rather than a key value, and no `environment.etc."nix/machines"` exists.
  - Render with poisoned secret values and assert only the runtime paths appear in the evaluated guest configuration and the builder activation text.
  - Assert the builder fails activation when `builder-authorized-keys` is missing or empty, that a client key outside that set is refused, and that the builder never treats tailnet node identity as session authentication.
  - Done when the suite passes on the real configuration and fails when a poisoned value replaces a path or an unauthorized key is accepted.
  - _Requirements: 6.3, 6.4, 6.5, 6.11, 6.13, 7.4, 8.3_
  - _Boundary: Secret Material Checks_
  - _Depends: 1.2, 2.3_

- [ ] 5.5 Register the `fabro-darwin-builds` flake check
  - Add `checks.<system>.fabro-darwin-builds` to `flake.nix` beside `mac-nix-remote-builder`, using the same `node --test tests/fabro-darwin-builds/` `runCommand` shape with Nix and Node native inputs and a writable source copy.
  - Done when `nix build .#checks.$(nix eval --impure --raw --expr builtins.currentSystem).fabro-darwin-builds` runs the complete suite.
  - _Requirements: 8.1, 8.2, 8.3, 8.4_
  - _Depends: 5.2, 5.3, 5.4_

- [ ] 5.6 Validate the live dispatch path and store resolution
  - Deploy and switch the builder; confirm it registers with `tag:mac-builder`, comes up from the OAuth credential without login, and that `mac-builder-readiness` over the LAN forward still passes.
  - Switch the guest; confirm `fabro-darwin-builders.service` rendered exactly one `0600` machines line, the daemon restarted, and `aarch64-linux` builds still run locally.
  - Run `fabro-darwin-build-smoke` from a sandbox; confirm the reported store path exists in the guest store and resolves inside the sandbox without any workflow change.
  - Done when each observation above is captured.
  - _Requirements: 1.4, 1.5, 3.1, 3.2, 6.6, 8.6_
  - _Depends: 1.3, 2.3, 3, 4.2, 5.1, 5.5_

- [ ] 5.7 Validate the live failure modes and recovery
  - Remove the guest's `build-client-key` and confirm a Darwin build fails naming that runtime path; restore it and confirm recovery.
  - Remove the builder's OAuth credential, let the auth daemon iterate, and confirm the iteration logs the credential path without running `tailscale up`; restore it and confirm the node rejoins.
  - Remove the guest's ACL access and confirm the refused connection plus the guest error naming the builder's tailnet name; restore the grant and confirm the build succeeds.
  - Done when each failure names its owning layer and each restoration returns the path to a successful Darwin build.
  - _Requirements: 1.6, 1.7, 3.5, 3.6, 3.7, 4.8, 6.7, 6.12_
  - _Depends: 5.6_

## Implementation Notes

- Task 1.1 and 1.2 share only the CLI contract, so the renderer can be implemented and reviewed before the module lands; the module must not re-implement key validation.
- Task 2.1's credential read happens every poll so a rotation or re-registration needs no operator; Task 2.2 only declares the wrapper's arguments.
- The operator provisions all external material in the design's `## Operator Provisioning` section; tasks 4.1 and 4.2 document it, and no task may read a secret value at evaluation time.
- Task 5.5 is the only change that turns the new suites into a required check; it must not pass by skipping absent files.
- Tasks 5.6 and 5.7 own the runtime evidence the offline checks cannot produce: tailnet reachability, the OAuth join, and sandbox store resolution.
