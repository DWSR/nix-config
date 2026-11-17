# Implementation Plan

> **Phases**: task 1 lands the pinned engine package and the 73-worker catalog
> in `overlays/`, task 2 the guest module, unit, and package install, task 3 the
> `svc:iii` Serve handler, task 4 the evaluated checks, and task 5 the build and
> runtime verification.
>
> **Operator precondition, not a task**: the `svc:iii` Tailscale Service must
> already exist in the admin console and be granted to `tag:fabro` (design C4);
> this plan only advertises it. No iii secret material exists, so no sops wiring
> or provisioning task is added.

- [ ] 1. Pinned engine and worker packages

- [x] 1.1 Create the pinned `iii` 0.26.0 engine derivation and register its overlay
  - Add `overlays/iii.nix` in `overlays/agentmemory.nix`'s shape: a `supportedSystems = [ "aarch64-linux" "aarch64-darwin" ]` guard that throws `Unsupported iii system: ${system}`, and an `engineSources` table holding the tag-pinned release URL and SRI hash per system (`sha256-4u5E0es48OM30+d7O4YB2ib/G9k0zIpMhJubz0FKtAs=` on `aarch64-linux`, `sha256-JzApagiuWEN1ey55E61ltigpAcmLlR28IwGODrQl4oU=` on `aarch64-darwin`)
  - Build `stdenvNoCC.mkDerivation { pname = "iii"; version = "0.26.0"; }` from that `fetchurl`, unpack the single-file archive into `$out/bin` (`tar -xzf "$src" -C "$out/bin"`, `chmod 0555 "$out/bin/iii"`), and set `dontStrip = true`
  - Add `autoPatchelfHook` with `glibc` and `stdenv.cc.cc.lib` on Linux and `dontFixup = true` on Darwin; add no FHS wrapper, `nix-ld`, installer run, or hand-placed binary
  - Expose `passthru.sourceRevision = "iii/v0.26.0"`, `meta.mainProgram = "iii"`, and the two-element `meta.platforms`; carry no `iiiVersion`/`iiiRevision` passthru key and read nothing from `pkgs.iii-engine`
  - Import `./iii.nix` beside the `iiiEngine` binding in `overlays/default.nix` and merge it into `custom-packages`; leave the AgentMemory import untouched
  - Completed when `.#nixosConfigurations.fabro-vm.pkgs.iii.version` and `.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.iii.version` both report `0.26.0`, each `src.outputHash` equals its recorded SRI, and forcing the attribute on any other system fails with the named error
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 3.6, 3.8_

- [x] 1.2 (P) Add the pinned 73-worker manifest
  - Add `overlays/iii-workers.nix` as pure data: `engineVersion = "0.26.0"`, a system-to-target map (`aarch64-linux` → `aarch64-unknown-linux-gnu`, `aarch64-darwin` → `aarch64-apple-darwin`), and one entry per cataloged worker with `version`, `binary`, and `targets.<system>.{url,hash}`
  - Transcribe the 73 rows of `research.md` § Worker catalog snapshot, converting each hex digest to SRI (`nix hash convert --hash-algo sha256 --to sri <hex>`); use the `https://cdn.iii.cloud/workers/<name>/<version>/<name>-<target>.tar.gz` default and full URLs for `acp`, `compose-ui`, and `mcp`, with `iii-acp` as `acp`'s binary
  - Keep entries sorted by worker name, record the 2026-11-16 snapshot date in a comment, and resolve nothing at evaluation time: no `latest`, no registry query, no URL-template fallback
  - Name none of `harness-e2e`, `voice`, `ios-simulator`, the eight official bundles, the four third-party bundles, `registry-cli`, or the four engine-kind entries
  - Completed when importing the file yields 73 attribute names, each with a non-empty `version`, `binary`, and both target URLs and SRI hashes, and no excluded name is present
  - _Requirements: 2.1, 2.2, 2.3, 2.7, 2.10_
  - _Boundary: overlays/iii-workers.nix_

- [x] 1.3 Build the generic worker derivation and expose `iii-workers`
  - Extend `overlays/iii.nix` with one generic builder over the manifest: `pname = "iii-worker-${name}"`, the entry's `version`, a `fetchurl` on its per-system `url`/`hash`, the same Linux `autoPatchelfHook`/`glibc`/`stdenv.cc.cc.lib` inputs, `dontStrip = true`, and `dontFixup` on Darwin
  - Install the archive's single root executable as `$out/bin/${entry.binary}` and `test -x` it so a layout change fails the build naming the worker
  - Expose exactly the manifest names under `pkgs.iii-workers`, each with `passthru.workerName`, `passthru.iiiEngineVersion = manifest.engineVersion`, `meta.mainProgram = entry.binary`, and the two-element `meta.platforms`; a missing target must fail evaluation naming the worker and system
  - Add no per-worker branch, installer call, `iii compose` invocation, or unpinned source, and reference neither `pkgs.iii-engine` nor its metadata
  - Completed when both required systems show 73 attributes, `database` (dynamic) and `mesh` (static) evaluate, `acp` reports `mainProgram = "iii-acp"`, and any other system fails with the named error
  - _Requirements: 2.4, 2.5, 2.6, 2.8, 2.9, 3.6, 3.8_
  - _Depends: 1.1, 1.2_

- [ ] 2. Guest service

- [x] 2.1 Render the empty-worker configuration and expose the `fabro.iii` options
  - Add `configurations/fabro-vm/iii.nix` with `fabro.iii` options: `package` (default `pkgs.iii`), `host` (default `"127.0.0.1"`), `port` (default `49134`), and read-only `config`/`configFile` values rendered by `(pkgs.formats.yaml { }).generate "iii-config.yaml" config.fabro.iii.config`
  - Default `config` to exactly one `workers` entry, `{ name = "iii-worker-manager"; config = { host = "127.0.0.1"; port = 49134; }; }`, deriving host and port from those two options so the rendered file has one source
  - Declare no project worker and no `configuration`, `iii-stream`, `http-functions`, or `sandbox` entry; add no unit, package install, or secret in this task
  - Import `./iii.nix` from `configurations/fabro-vm/default.nix` and extend its header comment to name the loopback-only engine
  - Completed when the guest evaluation shows one `workers` entry named `iii-worker-manager` at `127.0.0.1:49134` and a `configFile` path under `/nix/store/`
  - _Requirements: 5.1, 5.3, 5.6, 5.7_
  - _Depends: 1.1_

- [x] 2.2 Add `iii.service` and install the engine package
  - Add `systemd.services.iii` with `ExecStart = "${lib.getExe config.fabro.iii.package} --config ${config.fabro.iii.configFile} --no-update-check"`, `wantedBy = [ "multi-user.target" ]`, `DynamicUser = true`, no `User`/`Group`, `StateDirectory = [ "iii" ]`, `WorkingDirectory = "/var/lib/iii"`, `Restart = "always"`, and `RestartSec = 2`
  - Set `serviceConfig.Environment = [ "HOME=/var/lib/iii" "III_TELEMETRY_ENABLED=false" ]` plus the guest's hardening style (`NoNewPrivileges`, `PrivateTmp`, `ProtectSystem = "strict"`, `ProtectHome`, `RestrictAddressFamilies = [ "AF_UNIX" "AF_INET" "AF_INET6" ]`, `ReadWritePaths = [ "/var/lib/iii" ]`)
  - Add `iii` to the guest's `environment.systemPackages` in `configurations/fabro-vm/default.nix`; add no firewall opening, `EnvironmentFile`, static account, or runtime state under `/var/lib/fabro`
  - Keep the configuration a read-only store path, so a rendered change alters `ExecStart` and restarts the unit on switch, and a start failure ends in `failed` with the engine error in the journal
  - Completed when evaluation shows the unit with those fields, `lib.getExe` resolving to the `pkgs.iii` binary, a system package whose `pname` is `iii`, and no `User`, `Group`, or non-loopback path
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14_
  - _Depends: 2.1_

- [x] 3. (P) Add the `svc:iii` Tailscale Serve advertisement
  - Append `serve --service=svc:iii --https=443 http://127.0.0.1:49134` as the fourth `ExecStart` entry in `configurations/fabro-vm/tailscale.nix`, after `svc:fabro`, `svc:litellm`, and `svc:opencode`, so tailnet clients reach the engine at `wss://iii.tuxedo-musical.ts.net` with TLS terminated by tailscaled
  - Keep the three existing entries byte-for-byte and keep `after`/`requires` on `tailscaled.service` and `tailscaled-autoconnect.service`; do not require `iii.service`, so the engine stays loopback-only until registration and the handler is applied once it completes
  - Leave the oneshot enabled at boot so a repeat run converges to the same handler; a failing fourth line must leave the earlier three applied, journal the error, and add no other exposure path while the Service is absent
  - Update the unit `description` and module header comment from three services to four; add no firewall port, second engine endpoint, or port other than 443
  - Completed when evaluation shows four `serve` entries with the `svc:iii` handler last, the three existing substrings unchanged, and exactly one reference to `49134`
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8_
  - _Boundary: configurations/fabro-vm/tailscale.nix_

- [ ] 4. Evaluated verification

- [x] 4.1 Add the `iii-packages` check and its engine assertions
  - Add a check in `flake.nix`'s `checks` that instantiates `import nixpkgs { system = ...; overlays = [ outputs.overlays.custom-packages ]; }` for `aarch64-linux` and `aarch64-darwin` and asserts `iii.version == "0.26.0"`, `passthru.sourceRevision == "iii/v0.26.0"`, and the exact two-element `meta.platforms`
  - Assert each system's `iii.src.urls` and `src.outputHash` equal the release URL and SRI pinned in task 1.1, so a repointed or floating fetch fails evaluation
  - Build the report from plain metadata, discarding store-path context with `builtins.unsafeDiscardStringContext`, and give every `lib.assertMsg` a message naming the system and field
  - Keep the check pure: instantiate the package sets and read attributes; never build the engine, run the binary, or fetch during evaluation
  - Completed when the check passes without a Linux builder and a changed version, URL, hash, or platform set fails with a message naming the `iii` field and system
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 7.1, 7.14, 7.15_

- [x] 4.2 Extend `iii-packages` with the 73-worker catalog assertions
  - Assert `builtins.length (builtins.attrNames pkgs.iii-workers) == 73` on both systems, that the attribute names equal the manifest keys, and that `harness-e2e`, `voice`, `ios-simulator`, the eight official bundles, the four third-party bundles, `registry-cli`, and the four engine-kind names are absent
  - For every worker and both systems assert `version`, `src.urls`, `src.outputHash`, `meta.mainProgram` equal to the manifest `binary`, the two-element `meta.platforms`, and `passthru.iiiEngineVersion == "0.26.0"`
  - Assert each worker source URL appears in the manifest, so no derivation can fall back to an unpinned download, and name the worker and target in every message
  - Completed when all 73 workers pass for both systems, and dropping an entry, adding an excluded name, or changing one URL, hash, or binary fails with a message naming that worker and system
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10, 7.2, 7.3, 7.4, 7.14, 7.15_
  - _Depends: 4.1_
  - _Boundary: flake.nix_

- [x] 4.3 Add the `iii-agentmemory-isolation` check
  - Instantiate `aarch64-darwin` (and `x86_64-darwin`) package sets with the repository overlays and assert `iii-engine.pname == "iii-engine"`, `version == "0.11.5"`, and its unchanged two-platform set; do not force `iii` or `iii-workers` on `x86_64-darwin`, where the guard intentionally throws
  - On `aarch64-darwin` assert `agentmemory` still carries `passthru.iiiVersion = "0.11.5"` and `iiiRevision = "iii/v0.11.5"`, that `iii` and `iii-workers` are attributes distinct from `iii-engine`, that every engine and worker source and output hash differs from `iii-engine`'s, and that neither new package carries `passthru.iiiVersion` or `passthru.iiiRevision`
  - Assert the `agentmemory-opencode-matrix` check is still declared for `aarch64-darwin`, and leave `overlays/agentmemory.nix`, `home-manager/common/agentmemory.nix`, `agentMemoryChecks`, `agentMemoryHostMatrix`, and `tests/agentmemory-opencode/host-matrix.nix` untouched
  - Completed when a changed `iii-engine` version or platform set, a shared source or hash, or a leaked `iiiVersion` passthru fails the check with a message naming the package, while the current tree passes in pure evaluation
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 7.5_

- [x] 4.4 Extend `fabro-vm-guest-eval` with the package and unit assertions
  - Assert `environment.systemPackages` contains a derivation whose `pname` is `iii`, using the existing predicate shape
  - Assert `systemd.services.iii` exists, is `wantedBy [ "multi-user.target" ]`, has `DynamicUser = true` and no `User`/`Group`, `StateDirectory` containing `iii`, `WorkingDirectory` and `HOME` at `/var/lib/iii`, `Restart = "always"`, `RestartSec = 2`, and the design's hardening fields
  - Assert `ExecStart` is `lib.getExe config.fabro.iii.package` with `--config <configFile>` and `--no-update-check`, that the config path starts with `/nix/store/`, and that the unit declares no `EnvironmentFile`
  - Name the missing unit or field in every message and keep the check on pure evaluation
  - Completed when removing the unit, a hardening field, the state directory, or a flag fails `nix flake check` with a `fabro-vm:` message naming that element
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.13, 4.14, 7.6, 7.7, 7.8, 7.14, 7.15_
  - _Depends: 2.2_

- [ ] 4.5 Extend `fabro-vm-guest-eval` with the configuration and exposure assertions
  - Assert `builtins.length config.fabro.iii.config.workers == 1`, that the entry is `iii-worker-manager` with host `127.0.0.1` and port `49134`, and that the serialized value contains exactly that one worker name and no `0.0.0.0`, `3112`, or `.ts.net`
  - Assert `tailscale-serve` has four `ExecStart` entries, the three existing handler substrings verbatim, the new `--service=svc:iii --https=443 http://127.0.0.1:49134`, and exactly one reference to `49134`
  - Extend the `guestReport` string so the output names the engine package, the DynamicUser unit, the loopback listener, and the `svc:iii` handler; keep the assertions pure (no `readFile` of `configFile`, no image build)
  - Completed when `nix flake check` passes on the Mac without a Linux builder, and a widened bind, an added project worker, a dropped `svc:iii` entry, or a reordered handler list fails with a named `fabro-vm:` message
  - _Requirements: 5.1, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.8, 7.9, 7.10, 7.11, 7.12, 7.13, 7.14, 7.15_
  - _Depends: 2.1, 3, 4.4_

- [ ] 5. Build and runtime verification

- [ ] 5.1 Build the engine and catalog samples on both targets and smoke-run them
  - On `aarch64-darwin` build `.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.iii` and `...pkgs.iii-workers.database`, then run `iii --version` (expect `0.26.0`) and `database --help`
  - On `aarch64-linux` (guest or Linux builder) build `.#nixosConfigurations.fabro-vm.pkgs.iii` plus `...pkgs.iii-workers.{database,mesh,whatsapp,judge-clef}` — a dynamic worker, the two static ones, and a `libstdc++` one — then run the engine and each worker
  - Confirm the Linux binaries start from the store (interpreter and RPATH fixed by `autoPatchelfHook`) and that a wrong hash, a missing library, or an archive layout change fails the build instead of producing a broken package
  - Completed when every smoke run reports the pinned 0.26.0 engine, each sampled worker starts, and no step needed a manual patch, FHS wrapper, or host-wide loader configuration
  - _Requirements: 1.2, 1.3, 2.4, 2.5, 2.9_
  - _Depends: 1.1, 1.3_

- [ ] 5.2 Verify the service, listener, and `svc:iii` on the running guest
  - After `nixos-rebuild switch --flake .#fabro-vm` on the guest, confirm `systemctl status iii` reports active and enabled and `journalctl -u iii` shows the store config path, `127.0.0.1:49134`, and no bind error
  - Confirm `ss -ltnp` shows no engine listener other than `127.0.0.1:49134`, `tailscale serve status` lists `svc:iii` plus the three existing services, and another tailnet device reaches `https://iii.tuxedo-musical.ts.net`
  - Confirm a re-switch converges and a changed `fabro.iii.config` restarts `iii.service`, and that `/var/lib/iii` survives a service restart and a reboot
  - Start the engine with a local copy of the config naming a project worker and confirm `[UNSUPPORTED_CONFIG_WORKERS]`; occupy `127.0.0.1:49134` and confirm the unit fails with the bind error journaled
  - Completed when the loopback listener, the `svc:iii` handler, restart and state durability, and both engine error paths are observed, with the deployed configuration still declaring zero project workers
  - _Requirements: 4.5, 4.6, 4.13, 4.14, 5.2, 5.8, 5.9, 6.2, 6.3_
  - _Depends: 2.2, 3, 4.5_
