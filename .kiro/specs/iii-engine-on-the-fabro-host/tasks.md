# Implementation Plan

> **Phases**: task 1 renames the AgentMemory iii pin (behavior-preserving), task 2
> adds the 0.26.0 engine package, task 3 the 73-worker catalog, task 4 the guest
> module, task 5 the `svc:iii` Serve handler, task 6 the evaluated checks, and
> task 7 the running-guest verification.
>
> **Operator preconditions, not tasks**: the `svc:iii` Tailscale Service must
> already exist in the admin console and be granted to `tag:fabro`, and the guest
> must already be a registered `tag:fabro` node (design "Out of Boundary" and
> "Allowed Dependencies"). Nothing here creates a Service, ACL, DNS name,
> certificate, or device approval. The engine consumes no secret, so there is no
> provisioning task and no `sops` template to add.
>
> **Operator-gated verification**: task 7 runs against the running Lima guest and
> a second tailnet device, so it cannot complete in a build-only environment.
> Tasks 1-6 are secret-independent and complete without it.

- [ ] 1. AgentMemory engine pin separation

- [ ] 1.1 Rename the AgentMemory iii export and rewire its consumers
  - In `overlays/agentmemory.nix` export `agentmemory-iii-engine = iiiEngine` and drop the `iii-engine` attribute; keep `version = "0.11.5"`, both Darwin URLs and digests, the platform list, `passthru.sourceRevision`, and the `Unsupported iii-engine system: ${system}` guard unchanged
  - In `overlays/default.nix` bind the import as `agentmemoryIiiEngine` and keep merging it into `custom-packages` in the same position
  - In `home-manager/common/agentmemory.nix` select `pkgs.agentmemory-iii-engine` under the existing `hasAttr` guard and expose the resolved list as a read-only `programs.agentmemory.runtimeInputs` option (`types.listOf types.package`) for the check in task 6.5
  - In `flake.nix` replace `pkgs.iii-engine` with `pkgs.agentmemory-iii-engine` in the `agentmemory-opencode-matrix` `nativeBuildInputs`; keep deriving `iiiVersion`/`iiiRevision` from `cfg.package` passthru and change no launchd, PATH, or env line
  - Completed when `nix eval` shows `pkgs.agentmemory-iii-engine.version == "0.11.5"` and `.sourceRevision == "iii/v0.11.5"` for `aarch64-darwin` and `x86_64-darwin`, the personal host's `programs.agentmemory.runtimeInputs` contains that store path, and no evaluation path selects the 0.11.5 engine through `pkgs.iii-engine`
  - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.6_

- [ ] 1.2 (P) Update the AgentMemory assertions, matrix version proof, and ledger
  - Add an `iii --version` assertion reporting `0.11.5` to the `agentmemory-opencode-matrix` check derivation, before it runs `node tests/agentmemory-opencode/index.js`
  - Update `tests/agentmemory-opencode/package-contract.test.js` to assert the `agentmemory-iii-engine` export and its `pname`/`version`/`sourceRevision`, and `tests/agentmemory-opencode/validation-suite.test.js` to match `pkgs.agentmemory-iii-engine`; leave the `pkgs.iii-engine` 0.26.0 assertions to task 6.5, which runs after the engine package lands
  - Update the sentence in `docs/dead-nix-cleanup-ledger.md` that records the AgentMemory iii export
  - Completed when `node --test tests/agentmemory-opencode/package-contract.test.js tests/agentmemory-opencode/validation-suite.test.js` passes, no assertion resolves the 0.11.5 engine through `pkgs.iii-engine`, and the ledger names `agentmemory-iii-engine`
  - _Requirements: 3.5, 3.7_
  - _Boundary: flake.nix (AgentMemory matrix), tests/agentmemory-opencode, docs/dead-nix-cleanup-ledger.md_

- [ ] 2. Add the pinned iii 0.26.0 engine package
  - Create `overlays/iii.nix` exporting `iii-engine` as a `stdenvNoCC.mkDerivation` with `version = "0.26.0"` and `dontUnpack = true`, sourced from the two release tarballs and SHA-256 digests recorded in `research.md` (`iii-aarch64-unknown-linux-gnu.tar.gz`, `iii-aarch64-apple-darwin.tar.gz`)
  - Install exactly `bin/iii` from the tarball; use `autoPatchelfHook` with `stdenv.cc.cc.lib` and `dontStrip` on Linux, and `dontFixup` on Darwin so no ELF patching or stripping runs
  - Set `passthru.sourceRevision = "iii/v0.26.0"` and `meta = { mainProgram = "iii"; platforms = [ "aarch64-linux" "aarch64-darwin" ]; }`; throw `Unsupported iii-engine system: <system>` for every other system before the derivation is forced
  - Import the file in `overlays/default.nix` and merge it into `custom-packages`; add no installer, `builtins.fetchTarball`, mirror, or worker executable
  - Completed when the local required system builds `pkgs.iii-engine` with `bin` holding only `iii`, `bin/iii --version` prints `0.26.0`, the recorded `src.outputHash` is non-empty, and forcing `pkgs.iii-engine` for `x86_64-darwin` throws the named message (the both-platform build proof is task 6.1)
  - _Requirements: 1.1, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 3.1_

- [ ] 3. Official worker catalog

- [ ] 3.1 (P) Record the 73-entry worker manifest
  - Create `overlays/iii-workers.nix` as pure data: `{ engine = "0.26.0"; workers.<name> = { version; engine = "0.26.0"; executable; targets.<system> = { url; sha256; }; }; }`
  - Transcribe the 73 rows of `research.md`'s catalog snapshot: one `version`, one `executable` (`iii-acp` for `acp`, the worker name otherwise), and the `aarch64-linux`/`aarch64-darwin` URLs and SHA-256 digests verbatim as lowercase hex
  - Use the full `https://cdn.iii.cloud/workers/<name>/<version>/<asset>` URLs, quote the hyphenated target keys, and include none of the 8 bundles, `harness-e2e`, `voice`, `ios-simulator`, `registry-cli`, or the 4 engine-kind entries
  - Add a header comment naming the registry snapshot date (2026-11-16) and the membership rule so a catalog bump is a reviewable diff
  - Completed when `nix eval --json -f overlays/iii-workers.nix --apply 'x: builtins.attrNames x.workers'` returns exactly 73 names and every entry carries both target keys with a 64-character lowercase hex digest
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.8, 2.9_
  - _Boundary: overlays/iii-workers.nix (manifest data)_

- [ ] 3.2 Add the generic worker derivation and the `iii-workers` catalog
  - Extend `overlays/iii.nix` with `mkWorker name entry`, which reads `entry.targets.${system}` and throws `iii worker '<name>' has no <system> artifact (required: aarch64-linux, aarch64-darwin)` when the target key or its `url`/`sha256` is missing
  - Build each worker with the same `stdenvNoCC` + `fetchurl` + `dontUnpack` recipe as the engine, installing exactly `bin/${entry.executable}`; set `pname = "iii-worker-<name>"`, the entry's shared `version`, `passthru.iiiWorker`, and `meta = { mainProgram = entry.executable; platforms = builtins.attrNames entry.targets; }`
  - Expose `iii-workers = lib.mapAttrs mkWorker (import ./iii-workers.nix).workers`; add no registry lookup, `builtins.fetchTarball`, second version per worker, or build-time URL resolution
  - Completed when `pkgs.iii-workers.state` builds for the current system with exactly `bin/state`, `pkgs.iii-workers.acp` provides `bin/iii-acp`, and a manifest entry with a dropped target throws the named message
  - _Requirements: 2.1, 2.5, 2.6, 2.7, 2.10_
  - _Depends: 2, 3.1_

- [ ] 4. Guest engine module

- [ ] 4.1 (P) Add the `fabro.iii` settings seam and YAML render
  - Create `configurations/fabro-vm/iii.nix` with a read-only `fabro.iii.settings` option (`types.attrs`) defaulting to exactly one entry `{ name = "iii-worker-manager"; config = { host = "127.0.0.1"; port = 49134; }; }`, and a read-only `fabro.iii.yaml` option (`types.str`) defaulting to `lib.generators.toYAML { } config.fabro.iii.settings`
  - Render the file in the module let-block as `pkgs.writeText "iii-config.yaml" config.fabro.iii.yaml`, so the unit (task 4.2) and the checks read one store path
  - Declare no `modules` list, no `sandbox` key, no `iii-stream` entry, and no project worker; add no `enable` flag, free-form worker list, sops reference, or secret input
  - Import `./iii.nix` from `configurations/fabro-vm/default.nix` with a header comment naming the loopback listener and `svc:iii`
  - Completed when evaluating `nixosConfigurations.fabro-vm` shows `fabro.iii.settings.workers` with length 1 bound to `127.0.0.1:49134`, no `modules`/`sandbox` key, and a `fabro.iii.yaml` containing neither `0.0.0.0` nor a project worker name
  - _Requirements: 5.5, 6.1, 6.2, 6.4, 6.5, 6.6, 6.7_
  - _Boundary: configurations/fabro-vm/iii.nix, configurations/fabro-vm/default.nix (module import)_

- [ ] 4.2 Add the `iii.service` unit
  - Define `systemd.services.iii` in the same module with `wantedBy = [ "multi-user.target" ]`, `DynamicUser = true`, `StateDirectory = [ "iii" ]`, `WorkingDirectory = "/var/lib/iii"`, `environment.HOME = "/var/lib/iii"`, `Restart = "on-failure"`, and `RestartSec = 5`
  - Set `ExecStart = "${pkgs.iii-engine}/bin/iii --config ${configFile} --no-update-check"` using the task 4.1 store config; add no `ExecStartPre`, wrapper, installer, update step, or second `Exec*` entry
  - Apply the design's hardening (`ProtectSystem = "strict"`, `ProtectHome = true`, `PrivateTmp = true`, `NoNewPrivileges = true`, `RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ]`, `ReadWritePaths = [ "/var/lib/iii" ]`) and declare no `User`/`Group`, `EnvironmentFile`, `LoadCredential`, `SetCredential`, or secret-bearing `serviceConfig.Environment`
  - Leave the failure paths to systemd and the engine: an unusable state directory fails the unit before `ExecStart`, and a missing config surfaces as `Config file not found: '<path>'`, so add no error-swallowing wrapper
  - Completed when the evaluated unit carries those identity, state, restart, and hardening keys, the store `ExecStart` with `--no-update-check`, no secret input, and no `users.users.iii`
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - _Depends: 2, 4.1_

- [ ] 4.3 Install the engine package on the guest and start no worker
  - Add `iii-engine` to `environment.systemPackages` in `configurations/fabro-vm/default.nix`; add no `iii-workers` package, worker unit, `worker-compose.yaml`, activation script, or imperative install/update step
  - Leave every existing guest package, service, sops entry, and Tailscale setting untouched
  - Completed when the guest evaluation shows an `environment.systemPackages` entry with `pname == "iii-engine"` and `version == "0.26.0"` whose `bin/iii` prefixes the unit's `ExecStart`, and no package with an `iii-worker-` `pname`
  - _Requirements: 2.11, 4.1, 4.2, 4.3, 4.4_
  - _Depends: 4.2_

- [ ] 5. Add the `svc:iii` Tailscale Serve handler
  - Append a fourth `ExecStart` entry to `tailscale-serve` in `configurations/fabro-vm/tailscale.nix`: `"${lib.getExe cfg.package} serve --service=svc:iii --https=443 http://127.0.0.1:49134"`, last in the list
  - Add `wants` (not `requires`) and `after` entries for `iii.service`, keep `after`/`requires` on `tailscaled-autoconnect.service`, and keep `Type = "oneshot"` with `wantedBy = [ "multi-user.target" ]`, so the handler is re-applied on every boot and a failing fourth line fails the unit only after the first three applied
  - Update the unit description and header comment to name four services; leave the `svc:fabro`, `svc:litellm`, and `svc:opencode` lines byte-identical and add no firewall port, second engine endpoint, or Service/ACL/DNS/certificate/approval change
  - Completed when the evaluated unit is the oneshot with four handlers, `svc:iii` last and targeting `http://127.0.0.1:49134`, and the first three strings unchanged from the current file
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10_
  - _Depends: 4.2_

- [ ] 6. Evaluated verification

- [ ] 6.1 Add the `iii-engine-package` check
  - Add `iii-engine-package` to the `checks` output for `aarch64-linux` and `aarch64-darwin`: assert `version == "0.26.0"`, `meta.mainProgram == "iii"`, `passthru.sourceRevision == "iii/v0.26.0"`, the expected `src.urls` entry, a non-empty `src.outputHash`, and both required systems in `meta.platforms`
  - Build the derivation, assert `bin` contains only `iii`, and assert `bin/iii --version` prints `0.26.0`; make every message name the field that failed
  - Reuse the existing `pkgs` binding in `checks`; add no second package instance, alternate source, or installer
  - Completed when the check passes for each of the two systems where that system's checks run and a wrong version, digest, or `mainProgram` fails with a message naming the field
  - _Requirements: 1.2, 1.3, 1.5, 1.7, 8.1, 8.10_
  - _Depends: 2_

- [ ] 6.2 Add the `iii-engine-platform-guard` check
  - Add `iii-engine-platform-guard` for both supported systems: evaluate `pkgs.iii-engine` for `x86_64-darwin` in a child `nix eval` (with `pkgs.nix` and `NIX_CONFIG = "experimental-features = nix-command flakes"`) and assert a non-zero exit whose stderr contains `Unsupported iii-engine system: x86_64-darwin`
  - Follow the repository's existing source-copy check pattern and keep the child eval offline; add no network use and no real host switch
  - Completed when the check passes on both systems and removing or rewording the overlay guard makes it fail with the expected text quoted
  - _Requirements: 1.8, 8.10_
  - _Depends: 2_

- [ ] 6.3 Add the `iii-worker-catalog` check
  - Add `iii-worker-catalog` for both systems: read `overlays/iii-workers.nix` and assert exactly 73 entries, that the 8 bundles (`claude-code`, `cursor`, `onboarding`, `opencode`, `opengantry`, `openwiki`, `pi`, `vscode`), `harness-e2e`, `voice`, `ios-simulator`, `registry-cli`, `configuration`, `iii-observability`, `iii-sandbox`, and `iii-worker-manager` are absent, and that every entry has both targets, a `https://cdn.iii.cloud/workers/<name>/<version>/` URL, a 64-character lowercase hex `sha256`, `engine == "0.26.0"`, and a non-empty `executable`
  - Instantiate every entry for both systems through `import nixpkgs { system = …; overlays = [ (import ./overlays/iii.nix { }) ]; }`, asserting a derivable `drvPath` and a `meta.mainProgram` equal to the entry's `executable`
  - Name the worker and the failing field in every message; make no live registry call
  - Completed when the check passes and a dropped entry, an extra bundle, a missing target, a malformed digest, or a stale `engine` value fails with the worker name in the message
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 2.9, 2.10, 8.2, 8.3, 8.10_
  - _Depends: 3.1, 3.2_

- [ ] 6.4 Add the `iii-worker-build` check
  - Add `iii-worker-build` for both systems: build `pkgs.iii-workers.state` and `pkgs.iii-workers.acp`, assert `bin/state` and `bin/iii-acp` are the only files in their `bin` directories, and assert `meta.mainProgram` matches
  - Record in the check comment why two representative builds cover the one generic derivation (the 146 artifacts are digest-verified when recorded)
  - Completed when the check passes on both systems and a wrong inner executable name or an extra installed file fails with the worker named
  - _Requirements: 2.5, 2.6, 2.7, 8.2, 8.10_
  - _Depends: 3.2_

- [ ] 6.5 Add the `iii-agentmemory-pin` check and the 0.26.0 assertion
  - Add `iii-agentmemory-pin`, gated to `aarch64-darwin`: assert `pkgs.iii-engine.version == "0.26.0"`, `pkgs.agentmemory-iii-engine.version == "0.11.5"`, `.sourceRevision == "iii/v0.11.5"`, and both Darwin platforms on the renamed package
  - Assert `darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama.programs.agentmemory.runtimeInputs` contains the 0.11.5 store path and not the 0.26.0 path
  - Extend `tests/agentmemory-opencode/package-contract.test.js` with the `pkgs.iii-engine` 0.26.0 variant assertion deferred by task 1.2
  - Completed when the check passes and swapping the runtime input to `pkgs.iii-engine` fails with the wrong version named
  - _Requirements: 3.1, 3.3, 3.4, 3.7, 8.4, 8.10_
  - _Depends: 1.2, 2_

- [ ] 6.6 Assert the guest install, unit, and worker scope in `fabro-vm-guest-eval`
  - Assert `environment.systemPackages` contains a package with `pname == "iii-engine"` and `version == "0.26.0"`, that the unit's `ExecStart` begins with that package's `bin/iii`, that no `environment.systemPackages` entry has an `iii-worker-` `pname`, and that no unit other than `iii.service` runs the engine or a cataloged worker
  - Assert `iii.service` exists, is `wantedBy multi-user.target`, has `DynamicUser = true`, no `users.users.iii`, `StateDirectory` containing `"iii"`, `WorkingDirectory == "/var/lib/iii"`, `Restart == "on-failure"`, an `ExecStart` matching `--config /nix/store/… --no-update-check`, no `User`/`Group`, no `EnvironmentFile`/`LoadCredential`/`SetCredential`/`serviceConfig.Environment`, and an `environment` holding only `HOME`
  - Assert no activation script or unit starts, installs, or updates iii, and that the guest module source contains no `install.iii.dev`, `iii compose`, or `iii update` reference
  - Completed when each drift (missing package, static user, dropped state directory, added secret, imperative install) fails the check with a `fabro-vm:` message naming the element
  - _Requirements: 2.11, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.8, 5.9, 8.5, 8.10_
  - _Depends: 4.3_

- [ ] 6.7 Assert the rendered config, Serve handlers, and secret freedom in `fabro-vm-guest-eval`
  - Assert `fabro.iii.settings.workers` has length 1, the entry is `iii-worker-manager`, `host == "127.0.0.1"`, `port == 49134`, no `modules` key, no `sandbox` key, and `fabro.iii.yaml` contains neither `0.0.0.0` nor a project worker name
  - Replace the existing three-handler assertion so `tailscale-serve` must have four `ExecStart` entries, the first three equal the current `svc:fabro`, `svc:litellm`, and `svc:opencode` strings, the fourth is `--service=svc:iii --https=443 http://127.0.0.1:49134`, and `wants`/`after` contain `iii.service` while the autoconnect requirements remain
  - Assert no secret-bearing `serviceConfig` key, `sops` template, or `LoadCredential` is referenced by `iii.service`
  - Completed when a widened bind, a second worker entry, an extra or reordered Serve handler, or a secret input fails the check with a named `fabro-vm:` message
  - _Requirements: 5.6, 6.4, 6.5, 6.6, 6.7, 7.1, 7.5, 7.6, 8.6, 8.7, 8.8, 8.10_
  - _Depends: 4.1, 5, 6.6_

- [ ] 6.8 Extend the guest report and confirm pure evaluation
  - Extend the `guestReport` string so the check output names the engine package and version, the unit, the loopback listener, the single config entry, and the `svc:iii` handler
  - Keep every guest assertion on pure evaluation plus the trivial `runCommand`: no guest image build, no `aarch64-linux` derivation output, no store-path file read, no network beyond the flake fetch
  - Run the full `nix flake check` on the Darwin workstation and confirm the guest check and that system's iii checks pass, with no guest assertion requiring a Linux builder or a `aarch64-linux` derivation output
  - Completed when `nix flake check` passes on the workstation and its output text names each added element
  - _Requirements: 8.9, 8.10_
  - _Depends: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 7. Guest runtime verification

- [ ] 7.1 Verify the service, the listener, and the worker scope on the guest
  - Switch the guest with the repo's deploy path, then confirm `systemctl is-active iii.service` reports `active` and `systemctl is-enabled iii.service` reports `enabled`
  - Confirm `journalctl -u iii.service` contains `Engine listening on address: 127.0.0.1:49134` and that `ss -ltnp | grep 49134` shows only `127.0.0.1:49134` (no `0.0.0.0`, no `[::]`, no tailnet address)
  - Confirm `III_URL=ws://127.0.0.1:49134 iii call engine::workers::list` returns only entries with `"runtime": "engine"` and no project worker
  - Completed when the unit state, the single loopback listener, and the engine-only worker list are all observed
  - _Requirements: 5.1, 5.3, 5.4, 6.1, 6.2, 6.3_
  - _Depends: 6.8_

- [ ] 7.2 Verify `svc:iii` exposure and tailnet reachability
  - Confirm `tailscale serve status` lists `svc:iii` at `https:443` targeting `http://127.0.0.1:49134` alongside the three existing services, all still targeting their original loopback ports
  - From a tailnet device, connect a WebSocket client to `wss://iii.tuxedo-musical.ts.net` and list engine functions; confirm the plaintext listener is unreachable from the tailnet IP and from the LAN
  - Completed when the Serve handler, the tailnet WebSocket round trip, and the absence of any other engine endpoint are all observed
  - _Requirements: 7.1, 7.2, 7.3, 7.5, 7.6_
  - _Depends: 7.1_

- [ ] 7.3 Verify boot convergence, restart, and the failure paths
  - Reboot the guest and repeat tasks 7.1 and 7.2: the unit returns active and `svc:iii` converges to the same handler with no manual command
  - Kill the engine process and confirm systemd restarts it; then stop `iii.service`, hold port 49134 with a scratch listener, start `iii.service`, confirm the unit fails and the journal names `127.0.0.1:49134`, release the port, and confirm it starts again
  - Stop `iii.service` and confirm `tailscale serve status` still advertises `svc:iii` while the target is unreachable and no other port or interface exposes the engine; roll back to the previous generation and confirm `iii.service` is gone while the rest of the guest is unaffected
  - Completed when the reboot convergence, the restart, the named bind failure, and the rollback are all observed
  - _Requirements: 5.4, 5.7, 7.4, 7.7, 7.8, 7.9_
  - _Depends: 7.1_
