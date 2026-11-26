# Implementation Plan

Use the design's [migration rules](design.md#integration-and-migration-notes) in every cutover. Keep one canonical implementation, existing selectors, and pinned dependencies. In the same slice, adjust affected consumers, lock edges (including consumer fixtures), Dependabot/cooldown coverage, and CI lanes. The root integrator serializes shared-file edits; `(P)` marks disjoint work only. Count generated locks in the diff. Do not run live activation or deployment from these tasks.

## Baseline and prerequisites

- [ ] 1. Capture the pre-migration compatibility baseline
  - Record per-system selector inventory, legacy registry/search-path aliases, actual CI lanes/exclusions, and representative package pins and host wiring. Add parity fixtures without changing any outputs.
  - Done when the baseline command detects a missing selector and records existing runner blockers separately from failures.
  - _Boundary: `tests/flake-layout/`, baseline checks in `flake.nix`_
  - _Requirements: 3.1, 3.2, 3.5, 4.1, 4.4, 6.5_

- [ ] 2. Add a disposable stock-Nix evaluator probe
  - Probe a captured tree with a root-relative and sibling-relative lock, strict effective-lock equality, and a tracked source-only edit. Identify the stock ARM Linux shell/runner used for the pilot before the permanent matrix exists.
  - Done when the probe distinguishes a supported clean capture from a stale lock or truncated capture and reports native runner availability.
  - _Boundary: `tests/flake-layout/` evaluator fixture and command_
  - _Requirements: 1.4, 5.1, 5.3, 6.1_

- [ ] 3. Pin latest stable stock Nix for the personal host
  - Verify the current official stable release, pin only its package, remove the Lix override, and update any affected Fly consumer lock edges. Test the candidate with the old layout. Record operator-only activation, store recovery rehearsal, daemon and client checks, and rollback commands.
  - Done when the candidate closure builds and the settings comparison shows no unrelated host changes. Live activation is not part of this task.
  - _Boundary: `configurations/personal/default.nix`, `flake.nix`, `flake.lock`, `tests/fly-app/fixture/`, `tests/flake-layout/`, `docs/flake-layout.md` engine section_
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 3.2_

- [ ] 4. Add the checked root compatibility merger
  - Preserve published aliases and reserve the old registry/search-path names before introducing `area-*`. Use named origins for duplicate output checks; keep name discovery lazy.
  - Done when missing or duplicate outputs fail by name and the unchanged root registry and selector baseline still matches.
  - _Boundary: `flake.nix`, `flake/compat.nix`, `configurations/common-darwin/default.nix`, `tests/flake-layout/` compatibility fixtures_
  - _Requirements: 2.3, 3.1, 3.3, 3.4_

- [ ] 5. Validate lock identities and area scope metadata
  - Resolve shared and distinct pin identities, check `area.json` against registered paths/systems, and add the manifest-coverage rule. Extend the existing cooldown/flake-checker policy as needed without changing the age policy.
  - Done when lock drift, an unregistered production area, a reversed edge, or a missing manifest registration fails with an actionable name; intentional distinct pins pass.
  - _Boundary: `scripts/flake-scope.py`, `tests/flake-layout/`, `tests/dependency-cooldown/`, root hook config in `flake.nix`_
  - _Requirements: 2.4, 2.5, 5.1, 5.2, 5.4, 6.5_

- [ ] 6. (P) Teach agent workflows the area ownership rules
  - Let an area task claim its own entrypoint/lock; retain explicit claims for shared root files. Update scoped verification guidance and the boundary/command-selection fixtures.
  - Done when an area-owned edit survives the boundary gate and a collateral root/sibling edit does not.
  - _Boundary: `.fabro/workflows/{kiro-task,oneshot}/`, their workflow-selection and boundary tests_
  - _Depends: 5_
  - _Requirements: 6.2, 6.3_

- [ ] 7. (P) Decouple Fly stub builds from the consumer fixture fetcher
  - Supply the existing fixture's pinned nixpkgs and script inputs explicitly from the root check and test shell. Keep the credential, deployment, publish and reconcile stub cases.
  - Done when the stub suite uses no isolated `path:` fetch of the root consumer fixture and passes in the designated ARM Linux shell.
  - _Boundary: `tests/fly-app/` runtime harnesses, only the Fly deploy-check caller in `flake.nix`_
  - _Depends: 2, 5_
  - _Requirements: 4.1, 4.4, 5.1_

- [ ] 8. Make guest input prewarm safe for local area nodes
  - Prepare the recursive walk to traverse local inputs without collecting the checkout as a cached dependency. Resolve the snapshotter pin by graph edge, not node label.
  - Done when synthetic local/followed/transitive graphs pass, missing snapshotter pins fail, and the existing guest prewarm regression check stays available.
  - _Boundary: `scripts/fabro-{flake-inputs,sandbox-pinned}.nix`, `tests/fabro-sandbox/` pin/prewarm fixtures, their callers in `flake.nix`_
  - _Depends: 5, 7_
  - _Requirements: 4.5, 5.1, 5.2_

## Pilot and CI handoff

- [ ] 9. Register Fly as the first real area
  - Require the [operator engine gate](design.md#operator-engine-gate) before merging. Move Fly's public library, image/runtime packages and module/image checks; retain `deploy-moodist`, root consumer and runtime selectors. Refresh the affected root consumer lock and use the prewarm proof from task 8.
  - Done when lock equality and unchanged root Fly contracts hold from clean captures, the area builds on ARM Linux, and the first relative graph resolves in a disposable prewarmed sandbox.
  - _Boundary: `flakes/fly/`, Fly sources and consumers, `tests/fly-app/`, root Fly exports in `flake.nix` and `flake.lock`, manifest coverage_
  - _Depends: 3, 4, 5, 6, 7, 8_
  - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 4.5, 5.1, 5.4_

- [ ] 10. Verify both Fly consumers using their actual locked graphs
  - Add the small area consumer; run both consumer entrypoints through stock Nix from the captured checkout, and keep the standalone suite separate from the Linux shell runtime suite.
  - Done when the two named apps select their own specs in both contexts, the locked CLI probes pass without updates, and the local-stub deployment suite passes on ARM Linux.
  - _Boundary: `flakes/fly/tests/consumer/`, `tests/fly-app/fixture/`, shared generator assertions, their callers and lock coverage_
  - _Requirements: 2.2, 3.2, 4.1, 4.4, 5.1_

- [ ] 11. Run the pilot on scoped CI lanes
  - Derive jobs from the area manifest and explicit selector lanes. Keep legacy builds for unmigrated scopes, the required aggregate result, main-only evaluation, non-root Lima and isolated Fly shell lane.
  - Done when fixtures cover shard failure, no eligible shard, and unsupported platforms; native CI shows the pilot without regressing existing dispatch events.
  - _Boundary: `.github/workflows/ci.yml`, `scripts/flake-scope.py` matrix entrypoint, CI dispatch/matrix tests_
  - _Depends: 5, 10_
  - _Requirements: 2.5, 4.4, 6.1_

- [ ] 12. Extract root-only hook, shell and workflow checks
  - Move repo formatting, hooks, dependency age, guest devshell, and workflow validation bodies out of the root entrypoint. Keep the repository workflow paths and existing `prek` config output.
  - Done when their root selectors remain unchanged and `nix develop -c prek run --all-files` still uses the canonical hooks.
  - _Boundary: `flake.nix`, `flake/dev.nix`, `checks/repo.nix`, root policy and workflow check callers_
  - _Requirements: 3.1, 3.2, 4.1, 6.4_

## Shared packages and local areas

- [ ] 13. Register the shared `packages` substrate
  - Extract shared package constructors, fixed/unstable overlays and Tailscale pin. Keep the legacy merge order and per-consumer package sets.
  - Done when the package fixture builds and root overlay attributes and native package provenance still match the baseline.
  - _Boundary: `flakes/packages/`, shared files in `overlays/`, `flake.nix`, `flake.lock`, compatibility exports_
  - _Requirements: 2.1, 2.2, 3.1, 3.2, 5.2_

- [ ] 14. Register `home-base` with shell and terminal modules
  - Move reusable shell, SSH, Git/GH/hook primitives, Zellij/plug-ins and Tailscale Serve fixtures; leave profile enablement and real-host checks with root.
  - Done when the local module fixture renders without a personal host and the real profile retains its baseline shell configuration.
  - _Boundary: `flakes/home-base/`, common HM shell modules and overlays, Tailscale Serve tests, root profile, `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.1, 2.2, 3.2, 4.2, 4.3_

- [ ] 15. Move Git isolation and its aliases into `home-base`
  - Move the CLI, HM module and suite with both old app and check names. Keep the two root names bound to the same implementation.
  - Done when standalone cache/clone behavior and root alias-identity checks pass.
  - _Boundary: `flakes/home-base/` Git isolation, `tests/git-clone-isolation/`, Git isolation module/script and root selectors in `flake.nix`_
  - _Requirements: 2.2, 3.1, 3.3, 4.1_

- [ ] 16. Register the editor flake and keep real-host checks
  - Export the Nixvim config and local tiers with the pinned package context and Stylix fixture. Keep the production package/keymap checks and segregate the two OpenCode launcher checks.
  - Done when standalone editor checks pass and the real host tiers still select the real editor package.
  - _Boundary: `flakes/nixvim/`, `home-manager/nixvim/`, editor overlay and editor/launcher wiring in `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 4.2, 4.3_

- [ ] 17. Extract Hammerspoon base and consumer host assertions
  - Move the base, mic-mute, caffeinate and timezone host assertions to root integration functions. Leave watchdog and Deskflow for the next slices.
  - Done when those root selectors force the same real host and assertions on their original gate.
  - _Boundary: `flake.nix` named desktop host checks, `checks/integration/` desktop host helpers_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 18. Isolate Deskflow's fixture and host wiring
  - Separate the Deskflow renderer proof from the real forced-on profile proof, preserving both. Do not move watchdog wiring in this patch.
  - Done when `deskflow-render` and `deskflow-host-wiring` pass independently with baseline asserts and platform gates.
  - _Boundary: `flake.nix` Deskflow check block, Deskflow fixtures, `checks/integration/` Deskflow wiring_
  - _Requirements: 4.1, 4.2, 4.3, 6.4_

- [ ] 19. Extract only the desktop watchdog host assertions
  - Move `hammerspoon-deskflow-watchdog-wiring` and its fixture variants without reformatting or changing their subject. Leave standalone C/Lua tests for the area.
  - Done when the original selector checks the enabled and negative host variants, with a measured patch below the repo cap.
  - _Boundary: `flake.nix` watchdog host wiring only, `checks/integration/` watchdog wiring_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 20. Register desktop rendering and packaging
  - Move the bundle/annotations and keybinding/Deskflow renderers with local syntax and render checks. Reuse the extracted integration callers for the real bindings.
  - Done when host-free rendering and the native package proof pass while root still verifies the application inventory and bindings.
  - _Boundary: `flakes/macos-desktop/`, Hammerspoon packaging and keybindings, Deskflow module/fixtures, `flake.nix`, `flake.lock`_
  - _Depends: 13, 17, 18, 19_
  - _Requirements: 2.2, 3.3, 4.1, 4.2, 4.3_

- [ ] 21. Move desktop semantic and watchdog fixture suites
  - Colocate mock-HS/runtime, C helper, LuaLS positive and negative tests, and remaining desktop consumer fixtures. Keep semantic checks over actual host Lua at root.
  - Done when fixture-only desktop checks run in the area and all prior semantic/wiring outputs retain their subjects and system gates.
  - _Boundary: `flakes/macos-desktop/`, remaining Hammerspoon modules/tests and desktop checks in `flake.nix`_
  - _Requirements: 2.2, 2.5, 4.1, 4.2, 4.3_

- [ ] 22. Register SQLite backup with its runtime pin
  - Move Litestream, backup modules, CLI, Darwin verifier and fixtures. Leave the actual backup selection in the personal profile.
  - Done when standalone backup tests and the unchanged personal profile evaluate on baseline systems.
  - _Boundary: `flakes/sqlite-backup/`, Litestream overlay, SQLite backup module/CLI/verifier/tests, `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 4.3_

- [ ] 23. Register oMLX with its build and service fixture
  - Move the Python packaging/lock and reusable launchd module. Keep the personal service enablement and OpenCode provider binding at root.
  - Done when the area renders the service and root retains the existing native package pin and provider wiring.
  - _Boundary: `flakes/omlx/`, oMLX overlay/module/tests, root personal imports, `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 5.2_

## Agent stack and VM dependencies

- [ ] 24. Register the MCP package surface
  - Carve the OpenCode diagnosis and Obsidian deps out of the mixed overlay without changing their consumers. Move MCP packages and their sources into the area with its existing package proof.
  - Done when the package proof builds and the old overlay yields the same package versions and sources.
  - _Boundary: `flakes/mcp/` packages, `overlays/mcp-servers.nix`, MCP sources, transitional foreign deps, `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 5.4_

- [ ] 25. Migrate MCP modules, tools and fixture suites
  - Move signing, proxy, bridge logic and offline package tests. Root supplies the personal policy and SOPS bindings. Keep rendered host checks above the area.
  - Done when grep/ast-grep, GH stack and Git MCP cases retain their root selectors and area fixtures run without real credentials.
  - _Boundary: `flakes/mcp/` modules/apps/tests, legacy MCP modules/scripts, `configurations/personal/default.nix` bindings, `flake.nix`, `flake.lock`_
  - _Requirements: 2.2, 3.5, 4.1, 4.2, 4.3_

- [ ] 26. Publish the SDD package and prompt interfaces
  - Move cc-sdd, the Kiro CLI and shared instructions. Test the CLI against a local corpus; keep whole-repo corpus and real host/image wiring at root.
  - Done when the area CLI proof passes and the guest package remains the one installed in the sandbox.
  - _Boundary: `flakes/sdd/`, Kiro/cc-sdd sources and callers, corpus/wiring checks in `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 4.2, 5.4_

- [ ] 27. Register AgentMemory without the OpenCode matrix dependency
  - Move patched runtime, `iii-engine`, module/importer and isolated proofs. Update root matrix inputs without changing its production subjects or tests.
  - Done when AgentMemory's area checks need no OpenCode/root flake and the root matrix still checks the actual integration.
  - _Boundary: `flakes/agentmemory/`, AgentMemory packages/modules/scripts, matrix inputs, `flake.nix`, `flake.lock`_
  - _Depends: 24, 25_
  - _Requirements: 2.2, 2.4, 3.2, 4.1, 4.2_

- [ ] 28. Register the active Pi configuration
  - Move the Pi wrapper and extension packaging with active API fixtures. Connect the real AgentMemory, MCP and SDD interfaces at their existing usage points.
  - Done when the active `programs.pi.coding-agent` fixture passes and the root matrix still sees the real Pi settings.
  - _Boundary: `flakes/pi/`, Pi modules/extensions/scripts and `tests/pi-agent/`, root Pi bindings, `flake.nix`, `flake.lock`_
  - _Depends: 25, 26, 27_
  - _Requirements: 2.2, 3.2, 4.2, 4.3_

- [ ] 29. Register portable Lima modules and render checks
  - Move the three launcher modules with portable defaults and local fixtures. Preserve the personal render and pass the actual Fabro mount tags from root.
  - Done when the standalone fixture and personal Lima config proof both select the intended Lima package and mounts.
  - _Boundary: `flakes/builders/` Lima scope, common Lima modules, `tests/lima-vm/`, root Lima bindings, `flake.nix`, `flake.lock`_
  - _Depends: 13_
  - _Requirements: 2.2, 3.2, 4.1, 4.2_

- [ ] 30. Move builder roles and portable operator tools
  - Move reusable Mac/Linux server and dispatch code. Root supplies host identities, public trust pins and credential runtime paths. Keep the existing deploy/readiness selectors.
  - Done when both composed builders and guest machine records preserve their platform, trust and runtime behavior without key values.
  - _Boundary: `flakes/builders/`, builder role modules/scripts, root builder/guest bindings and apps in `flake.nix`_
  - _Requirements: 3.1, 3.2, 3.5, 4.3_

- [ ] 31. Isolate real builder and Lima integration suites
  - Extract the combined builder assertions and Darwin dispatch check without rewriting them. Retain the actual host subjects, the non-root Lima lane, and typed fixture observations.
  - Done when `linux-nix-remote-builder`, `fabro-darwin-builds`, and `lima-vm-config-validate` retain their baseline results and subjects.
  - _Boundary: `flake.nix` builder/Lima checks, `checks/integration/` builder helpers and matching suites_
  - _Requirements: 4.1, 4.2, 4.4, 6.4_

- [ ] 32. Publish the LiteLLM catalog and workload modules
  - Move the proxy, bridge and schema artifacts; pass catalog projections to Fabro and OpenCode. Update the inline guest and workflow-fallback catalog consumers in this slice, keeping real PostgreSQL/ordering proofs at root.
  - Done when the local catalog/affinity/module fixtures pass and current guest/real workflow model IDs and package pins compare equal.
  - _Boundary: `flakes/litellm/`, LiteLLM sources/tests, guest and workflow-fallback catalog consumers, `flake.nix`, `flake.lock`_
  - _Depends: 25_
  - _Requirements: 2.2, 3.2, 4.1, 4.2, 4.3_

- [ ] 33. Publish Fabro's CLI, HM module and workflow skill
  - Move the binary pin, HM module, reusable sync/reconcile and skill. Supply the skill path to personal and guest OpenCode before those modules move. Root continues to validate its workflows.
  - Done when Fabro's standalone service/reconcile fixtures pass and the root devshell/guest/skill consumers select the same CLI and asset content.
  - _Boundary: `flakes/fabro/`, Fabro overlay/HM/tools/tests/skill, guest/devshell/skill bindings, `flake.nix`, `flake.lock`_
  - _Depends: 25_
  - _Requirements: 2.2, 3.2, 4.1, 4.2_

- [ ] 34. Register the OpenCode launcher and web modules
  - Move the patched binary, nono launcher, core client and reusable guest web module with fixture checks. Root keeps guest identity and credential paths, personal enablement, both launcher equivalence proofs and host base-package equality assertions.
  - Done when standalone launcher tests and actual personal/guest assertions pass without changing the intended runtime mode or package.
  - _Boundary: `flakes/opencode/` core/nono, OpenCode pin/assets/modules, root bindings and launcher/timestamp checks, `flake.nix`, `flake.lock`_
  - _Depends: 26, 27, 32, 33_
  - _Requirements: 2.2, 2.4, 3.2, 3.5, 4.1, 4.2_

- [ ] 35. Move OpenCode diagnostics and RTK tools
  - Move RTK, audit and cost-report dependencies, module/script/test support and app selectors. Use area-local synthetic data and preserve help/version gates.
  - Done when the local diagnostics and validation proofs run without a switched host, and root app/check names resolve.
  - _Boundary: `flakes/opencode/` diagnostics/RTK, corresponding legacy scripts, deps and tests, aliases in `flake.nix`_
  - _Requirements: 2.2, 3.1, 3.3, 4.3_

- [ ] 36. Isolate context budget and compaction checks
  - Move the plugin implementations and local fixture suites. Keep the real host and matrix compaction tests connected to the moved implementation.
  - Done when local budget/compaction fixtures pass and the matrix keeps the same OpenCode/AgentMemory integration cases.
  - _Boundary: `flakes/opencode/` context/compaction, former plugin source/tests, root matrix and budget checks in `flake.nix`_
  - _Requirements: 2.2, 4.1, 4.2, 4.3_

## Guest assertions and cutover

- [ ] 37. Extract guest platform, mounts and maintenance assertions
  - Start the assertion-family structure with Lima, boot, persistence and maintenance. Preserve remaining assertions in the legacy aggregate.
  - Done when `fabro-vm-guest-eval` still reports and asserts the real guest's mount tags and platform.
  - _Boundary: `flake.nix` guest boot/mount/maintenance assertions, `checks/integration/fabro-vm/`_
  - _Depends: 29, 31, 32, 33, 34_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 38. Isolate the guest Fabro service and API bridge
  - Extract the service/secrets assertion family; relocate the reusable service/API bridge implementation under the future VM area using ordinary root imports. Keep deployed identities and all secret declarations/bindings at root.
  - Done when the old guest selector still proves unit ordering, supervision and secret paths, with no area lock yet.
  - _Boundary: guest Fabro/API bridge files, staged `flakes/fabro-vm/` service code, `checks/integration/fabro-vm/`, `flake.nix` and manifest updates_
  - _Requirements: 3.5, 4.1, 4.2, 5.4, 6.5_

- [ ] 39. Isolate shared Postgres and its scratch proof
  - Move the reusable cluster module under the future VM area with an ordinary root import. Extract cluster/role/socket assertions and the `postgres-scratch` wrapper without substituting a fixture package or SQL.
  - Done when real-guest evaluation and the native scratch check prove the same bootstrap/grant/extension contract.
  - _Boundary: shared Postgres module, `checks/integration/fabro-vm/` Postgres assertions, `flake.nix` Postgres gates and `tests/postgres-scratch/`_
  - _Requirements: 3.2, 4.1, 4.2, 6.4_

- [ ] 40. Extract LiteLLM schema and routing assertions
  - Move the workload init/gateway assertion family and `litellm-db-init` wrapper. Keep the actual guest's pinned schema, runtime units and package subjects.
  - Done when the original aggregate and native schema check still verify the same guest service order and init behavior.
  - _Boundary: `flake.nix` gateway/schema gates, `checks/integration/fabro-vm/` LiteLLM assertions, `tests/litellm-db-init/`_
  - _Requirements: 4.1, 4.2, 6.4_

- [ ] 41. Extract guest `iii` runtime and network assertions
  - Move the engine supervisor and Tailscale serving/reconcile assertions out of the guest aggregate body. Do not move console or project assertions yet.
  - Done when the original guest selector still catches a changed engine readiness or service exposure setting.
  - _Boundary: `flake.nix` guest engine/network assertions, `checks/integration/fabro-vm/`_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 42. Extract guest projects and OpenCode assertions
  - Move the `iii` console/software-factory and OpenCode web assertion families with their evaluated values.
  - Done when the unchanged root selector verifies the actual worker/console and guest web wiring.
  - _Boundary: `flake.nix` project/OpenCode guest assertions, `checks/integration/fabro-vm/`_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 43. Extract sandbox assertions and complete the guest aggregate
  - Move sandbox/image/load/reconcile/prewarm assertions, then compose the assertion families under `fabro-vm-guest-eval`.
  - Done when the aggregate selector preserves all original assertion families and the root prewarm proof still exercises the composed graph.
  - _Boundary: `flake.nix` sandbox assertion family, `checks/integration/fabro-vm/` aggregate and sandbox integration callers_
  - _Requirements: 4.1, 4.2, 4.5, 6.4_

- [ ] 44. Register the VM area with the `iii` package and project surface
  - Move guest `iii` packages, manifests, supervisor and project modules. Export the staged Fabro service and Postgres modules. Register the real `iii-packages` local proof without importing the VM host or AgentMemory's engine.
  - Done when catalog metadata and the composed guest engine/project checks pass with their distinct existing pins.
  - _Boundary: `flakes/fabro-vm/` `iii` and staged exports, `overlays/iii*.nix`, guest `iii` modules, `flake.nix`, `flake.lock`_
  - _Depends: 13, 38, 39, 41, 42_
  - _Requirements: 2.1, 2.2, 2.4, 3.2, 4.1, 5.4_

- [ ] 45. Cut over guest boot and image modules
  - Export reusable Lima/boot/image wiring and change root role imports to the area exports. Preserve the stationary kernel, rsync compatibility pin, actual mount tags, root net/secret bindings and guest-only image selector.
  - Done when the real guest boot/image output uses its baseline pins and role, before changing sandbox module locations.
  - _Boundary: `flakes/fabro-vm/` boot/image modules, `configurations/fabro-vm/` boot bindings, `flake.nix`, `flake.lock`_
  - _Depends: 29, 30, 37, 44_
  - _Requirements: 3.1, 3.2, 3.5, 4.2, 5.2_

- [ ] 46. Cut over VM sandbox modules and independent fixtures
  - Move sandbox, loader and image helpers with standalone rules/loader/pin fixtures. Preserve real-guest sandbox checks and export the same archive, digest, smoke and verify artifacts as the configured guest.
  - Done when the three standalone fixture subjects pass and native evaluation/offline prewarm verify the actual guest closure and identity contracts.
  - _Boundary: `flakes/fabro-vm/` sandbox, existing sandbox scripts/tests, root prewarm bindings, `flake.nix`, `flake.lock`_
  - _Depends: 8, 26, 34, 43, 45_
  - _Requirements: 2.2, 3.1, 3.2, 4.1, 4.2, 4.5_

## Final composition and verification

- [ ] 47. Reduce root to static inputs and composition
  - Extract remaining host/app/package assembly into `flake/outputs.nix` and the compatibility helpers. Keep existing root-only deployment declarations and the guest-derived Kiro package selector.
  - Done when the root still resolves all published outputs and no area needs to edit a host config for an area-local check.
  - _Boundary: `flake.nix`, `flake/{outputs,compat}.nix`, root composition callers_
  - _Depends: 12, 46_
  - _Requirements: 2.3, 3.1, 3.2, 6.4_

- [ ] 48. Extract the `iii`/AgentMemory isolation cross-check
  - Move `iii-agentmemory-isolation` (about 155 inline lines) to root integration, retaining the metadata and matrix-presence assertions. `postgres-scratch` and `litellm-db-init` are handled by tasks 39 and 40.
  - Done when the original platform-gated selector verifies the same two pins and the root file contains no inline suites.
  - _Boundary: `flake.nix` or moved root outputs file, `checks/integration/` `iii`/AgentMemory isolation only_
  - _Depends: 27, 44, 47_
  - _Requirements: 4.1, 4.2, 6.4, 6.5_

- [ ] 49. Enforce the final layout and run compatibility evidence
  - Check all area registrations, manifests, the 1,000-line root cap, lock/pin parity, representative host and root consumers, and native/check-specific CI gates. Verify the area command map and update runbook examples alongside the guard tests.
  - Done when the mapped commands reproduce the scoped/full results and any unavailable native build is recorded as a blocker, not a pass.
  - _Boundary: `tests/flake-layout/`, `scripts/flake-scope.py` layout assertions, `docs/flake-layout.md`, final CI compatibility fixtures_
  - _Depends: 11, 12, 46, 48_
  - _Requirements: 2.1, 2.3, 2.5, 3.1, 4.4, 5.1, 5.2, 5.3, 5.4, 6.1, 6.2, 6.3, 6.4, 6.5_
