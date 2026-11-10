# Implementation Plan

- [ ] 1. Add the portable Linux builder host

- [ ] 1.1 Define and register the NixOS builder host
  - Create `configurations/linux-builder/default.nix` for native `aarch64-linux`, with Nix remote-build support, a dedicated non-root `builder` account, and trust limited to that account.
  - Configure OpenSSH with persistent host-key paths, declare SOPS runtime secrets for authorized keys and the Tailscale OAuth credential, and materialize authorized keys at runtime; do not place secret values in the Nix store.
  - Configure the stable `linux-builder.tuxedo-musical.ts.net` endpoint and dedicated tailnet tag; support at least four concurrent remote jobs and explicitly avoid extra execution platforms.
  - Add Nix store garbage collection/optimization and keep all Lima-specific modules and provisioning outside the portable host.
  - Add `nixosConfigurations.linux-builder` to `flake.nix` using the existing NixOS flake pattern.
  - Done when the host and its flake output evaluate for `aarch64-linux`, advertise only native builds, and require neither Lima nor secret values for evaluation.
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Provision the builder as a separate personal-host Lima guest

- [ ] 2.1 Add the builder-specific Lima adapter and instance configuration
  - Create `home-manager/common/lima-linux-builder.nix` with a separate instance identity and rendered Lima configuration, modeled on existing NixOS guest conventions without changing `lima-vm.nix`.
  - Reuse the pinned NixOS release image defaults and native aarch64 architecture; configure `linux-builder` with 4 CPUs, `8GiB` memory, and `128GiB` disk, and enable it from the personal-host Home Manager configuration.
  - Import the adapter from `home-manager/common/default.nix` and preserve the existing Fabro Lima guest configuration.
  - Done when the personal host renders the specified resources for a distinct builder instance and its existing Fabro instance remains unchanged.
  - _Requirements: 2.1, 2.2, 2.3_

- [ ] 2.2 Implement the builder VM lifecycle and deployment wrapper
  - Add a builder-specific launchd supervisor and deploy command following the existing Lima start and tar-over-SSH NixOS deployment conventions.
  - Deploy the locked repository flake output `linux-builder` into the guest; keep instance lifecycle and image provisioning outside the portable host module.
  - Ensure launchd starts the instance at load, restarts unexpected failures, and honors a clean stop without modifying the existing Fabro supervisor.
  - Done when the separate adapter exposes a deploy command and rendered lifecycle configuration for the `linux-builder` guest.
  - _Depends: 1.1, 2.1_
  - _Requirements: 2.4_

- [ ] 2.3 Publish the builder host-key pin
  - Add the checked-in public host key at `certificates/linux-builder/ssh_host_ed25519_key.pub` from the provisioned guest's persistent `/var/lib/ssh/ssh_host_ed25519_key.pub`; never generate, mint, or commit the private host key.
  - Treat the pin as operator-supplied public trust material: when the value is unavailable, record `environment-blocked: secret-material-blocked <name> (<source>)` rather than substituting a key.
  - Done when the checked-in pin matches the guest's published host key and is available as the shared trust input for both client records.
  - _Depends: 2.2_
  - _Requirements: 3.1, 3.2_

- [ ] 3. Wire Fabro Linux dispatch and enforce no local builds

- [ ] 3.1 Extend the Fabro machines renderer for both builder records
  - Extend `scripts/fabro-darwin-machines.nix` to validate Linux endpoint, `aarch64-linux`, job count, runtime key path, and pinned public host-key input.
  - Atomically render the Linux record alongside the existing Darwin record; retain the Darwin record's values and ordering, set mode `0600`, and never read or emit a private-key value.
  - Set the Linux machine record to `max-jobs = 4` and `speed-factor = 1`; never put private key contents in the record.
  - Done when fixture runs produce both records and invalid/missing Linux inputs fail without replacing the prior complete output.
  - _Requirements: 3.1, 3.3, 4.1, 4.3_

- [ ] 3.2 Configure Fabro's Linux client credentials, dispatch, and build policy
  - Declare Fabro's dedicated Linux client key as a root-only SOPS runtime secret and add its operator 1Password source to `scripts/fabro-sync-from-1password.nix`.
  - Extend `configurations/fabro-vm/darwin-dispatch.nix` to pass Linux machine inputs to the existing renderer/service, retaining its runtime builders path, substitutes, ordering, and Darwin entry.
  - Set `nix.settings.max-jobs = 0` while retaining distributed builds, so unavailable remote builders fail rather than compiling locally.
  - Done when evaluation exposes the Linux runtime key path, both machine systems, the existing daemon ordering, and zero local build jobs without any key value in the store.
  - _Depends: 3.1_
  - _Requirements: 3.1, 3.3, 4.1, 4.2, 4.3_

- [ ] 4. Configure the personal Mac Linux client

- [ ] 4.1 Add the Linux machine record and dedicated client key wiring
  - Update `configurations/common-darwin/default.nix` to use a `pkgs.writeText` builders file referenced through `@file`, containing both the existing Darwin record and the Linux `ssh-ng` record with `aarch64-linux`, 4 jobs, and speed factor 1.
  - Declare the personal Linux client private key in its own root-owned SOPS secret and reference only its runtime path and the pinned public builder host key in the machine record.
  - Preserve personal-host `max-jobs = 0`, the existing Darwin endpoint, and the local binary cache distributed-build policy.
  - Done when the personal Darwin configuration evaluates with both target systems and contains no private key value in the generated builders file or Nix store.
  - _Depends: 2.3_
  - _Requirements: 3.2, 3.3_

- [ ] 5. Integrate operator-managed secret and trust material

- [ ] 5.1 Add builder secret-store and sync-command wiring
  - Add a distinct `host_linux_builder` SOPS recipient/rule and builder secret declarations for authorized client public keys and Tailscale OAuth material; use the operator-provisioned recipient, never a placeholder.
  - Create `scripts/linux-builder-sync-from-1password.nix` to encrypt operator-supplied builder values into the builder store and the personal client key into the personal encrypted store; it must not generate or mint values.
  - Update `scripts/fabro-sync-from-1password.nix` for the Fabro client key without storing private keys in the repository.
  - Done when sync behavior is testable with fixture credentials/recipients and declarations refer only to runtime secret paths; no real secret is needed to run the checks.
  - _Requirements: 1.3, 3.1, 3.2_

- [ ] 5.2 Document bootstrap and external trust configuration
  - Update `secrets/README.md` with the design's operator provisioning, bootstrap order, key sources, sync commands, and verification steps for builder and client secrets.
  - Document the Tailscale tag ownership and SSH-only grants for Fabro and the personal Mac, plus host-key pin verification; state the builder-specific Tailscale OAuth credential source, `auth_keys` scope, and runtime consumption; point to the design's `## Operator Provisioning` section.
  - Include the post-provisioning live acceptance sequence for Linux builds from both clients, preserved Darwin dispatch, unsupported-platform rejection, and Fabro's no-local-fallback behavior.
  - Do not create, rotate, decrypt, or record secret values or pretend external Tailscale ACL changes are repository configuration.
  - Done when an operator can provision, verify external items, and perform the live acceptance checks using the documented sources and sequence without ambiguity.
  - _Requirements: 1.3, 2.4, 3.1, 3.2_

- [ ] 6. Add configuration regression checks

- [ ] 6.1 (P) Test the NixOS host and personal Lima adapter
  - Add host and Lima render tests under `tests/linux-nix-remote-builder/` using the repository's Nix evaluation and Node test patterns.
  - Assert NixOS platform, remote-build/SSH/Tailscale/SOPS wiring, host independence from Lima, instance identity, launchd lifecycle/deploy wiring, and the 4-CPU/`8GiB`/`128GiB` render without changing Fabro's existing guest.
  - Done when tests pass on the feature configuration and reject a wrong platform, changed resource, missing lifecycle wiring, or altered Fabro guest render.
  - _Boundary: Builder Host and Lima Render Tests_
  - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 5.1, 5.2_

- [ ] 6.2 (P) Test Fabro machine rendering and no-local-build policy
  - Add renderer tests for both machine records, Linux system/key/host-key fields, atomic output and permissions, and failures for missing or invalid inputs.
  - Evaluate Fabro to assert its Linux route, unchanged Darwin route, retained daemon ordering/substitute settings, and `max-jobs = 0`.
  - Done when tests fail for a missing Linux record, altered Darwin record, invalid key path, or nonzero Fabro local-job limit.
  - _Boundary: Fabro Dispatch Tests_
  - _Requirements: 3.1, 3.3, 4.1, 4.2, 4.3, 5.3, 5.4, 5.5_

- [ ] 6.3 (P) Test personal Mac dispatch and secret boundaries
  - Evaluate `Brandons-MacBook-Pro` and assert both machine records, the dedicated SOPS runtime key path, existing Darwin behavior, and unchanged cache policy.
  - Add poisoned-value checks for generated machine data and secret wiring; assert private key and OAuth values never appear in Nix store paths or rendered settings.
  - Done when tests reject a missing/wrong Linux machine or key path and detect any injected secret value.
  - _Boundary: Personal Mac and Secret Boundary Tests_
  - _Requirements: 3.2, 3.3, 5.3, 5.5_

- [ ] 6.4 Register and run the combined repository check
  - Register `checks.<system>.linux-nix-remote-builder` in `flake.nix` for the focused test suite and add negative evaluation fixtures for builder capability, VM resources, client dispatch, and Fabro policy.
  - Ensure each missing or incorrect required setting causes its corresponding check to fail while the existing Darwin path remains independently asserted.
  - Done when the flake check runs the focused suite and all planned negative fixtures fail for their named invariant.
  - _Depends: 6.1, 6.2, 6.3_
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 7. Validate provisioned remote build behavior
  - After operator provisioning and deployment described in the design's `## Operator Provisioning`, verify the builder registers with Tailscale and the pinned SSH host identity matches the guest.
  - Submit an `aarch64-linux` derivation from Fabro and `Brandons-MacBook-Pro`; verify each output returns from the Linux builder and Darwin builds still use the existing Darwin endpoint.
  - Verify an unsupported platform is not accepted by the Linux machine entry and a Linux build with the endpoint unavailable fails on Fabro without a local build.
  - Done when the live dispatch, returned outputs, Darwin preservation, unsupported platform, and no-fallback failure observations are recorded; this task does not provision secret values.
  - _Depends: 2.2, 3.2, 4.1, 5.1, 6.4_
  - _Requirements: 1.1, 1.2, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_
