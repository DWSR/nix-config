# Gap Analysis: deskflow-hammerspoon-watchdog

## Summary
- The repository already provides the two required extension points: a
  role-aware `home.deskflow` module and module-merged
  `home.hammerspoon.extraConfig`.
- No existing code observes child processes, runs a periodic Hammerspoon state
  machine, or automates another application's menu.
- Deskflow 1.26.0 has no macOS restart CLI or IPC. Safe recovery must preserve
  GUI ownership and treat direct core launch as an unavailable fallback.
- A standalone optional Hammerspoon consumer best matches existing module
  boundaries. Runtime GUI automation remains the main integration risk.
- Estimated effort: **M (3–7 days)**. Risk: **Medium**, dominated by unverified
  menu availability and activation behavior after a real core crash.

## Current Assets

### Deskflow
- `home-manager/common/deskflow/default.nix` exposes disabled-by-default,
  role-aware `home.deskflow` options and validates `client`/`server`.
- Both hosts enable Deskflow: the personal host is the server and ShopifyLaptop
  is the client in `configurations/*/home-manager/deskflow.nix`.
- `gui.startCoreWithGui` defaults true, `gui.closeToTray` defaults true, and
  `gui.autoHide` defaults false.
- `flake.nix` already has pure Deskflow renderer and both-host wiring checks.
- Process launch, liveness, restart, executable identity, and command arguments
  are absent from the module and checks.

### Hammerspoon
- `home-manager/common/hammerspoon-keybindings/default.nix` supplies package,
  login launch, XDG config delivery, syntax validation, and the module-merged
  `extraConfig` escape hatch.
- `hammerspoon-brightness-ac` is the closest optional watcher precedent: a
  child `enable` option, `mkIf`, a self-contained Lua chunk, retained watcher
  handle, and isolated semantic check.
- Existing consumers retain state in Lua upvalues and use `hs.alert.show` for
  operator feedback.
- `flake.nix` exposes `mkSemanticCheck` and per-host rendered-config assertions.
- `tests/hammerspoon-keybindings/` tests static rendering and syntax only; it
  does not provide a mocked Hammerspoon runtime or timer/state-machine harness.

## Requirement-to-Asset Map

| Requirement | Existing asset | Gap classification |
|---|---|---|
| R1 Optional role-aware enablement | `mkEnableOption` consumer pattern; `home.deskflow.{enable,role}` | **Missing**: watchdog option, prerequisites, and role propagation |
| R2 Safe observation | Deskflow bundle/core names known upstream | **Missing**: asynchronous process inventory, identity parser, debounce, ambiguity classification |
| R3 Lifecycle behavior | Hammerspoon has timer and caffeinate watcher APIs | **Missing**: retained timers, sleep/wake state, fresh-observation reset |
| R4 GUI-owned recovery | Hammerspoon application/menu APIs; Deskflow GUI owns core | **Missing**: activation/unhide sequence, menu discovery, focus restoration, post-action verification |
| R5 Failure handling | `hs.alert.show` precedent | **Missing**: recovery episodes, backoff, cooldown, deduplicated alerts, fail-closed branches |
| R6 Initial rollout | Per-host Deskflow files; shared module import list | **Missing**: personal-only enablement and client-disabled assertion |
| R7 Verification | Lua syntax/semantic gates and host-wiring checks | **Missing**: pure state-machine tests, process-output fixtures, watchdog semantic/wiring checks, runtime checklist |

## Upstream Deskflow Findings

- Stable target is Deskflow `v1.26.0` (`760e3b99`). The macOS bundle contains
  `Deskflow.app/Contents/MacOS/Deskflow` and
  `Deskflow.app/Contents/MacOS/deskflow-core`.
- Client and server use the same core executable. The first positional argument
  is `client` or `server`; normal GUI launch relies on
  `~/Library/Deskflow/Deskflow.conf` for the remaining settings.
- The GUI starts the core as an owned `QProcess` child and observes its exit.
  An unexpected exit code `0` is retried after one second; a non-zero or crash
  exit transitions to stopped and is not automatically restarted.
- Stable 1.26.0 exposes no macOS GUI CLI, URL scheme, AppleScript dictionary,
  or IPC command that starts/restarts the core. Running a second GUI instance
  only asks the existing instance to show and activate.
- `open -a Deskflow` activates an existing GUI but does not itself restart a
  missing core. Direct core invocation is duplicate-resistant unless
  `--new-instance` is used, but the GUI does not own or monitor a directly
  launched core.
- The GUI's stopped state makes its Start action visible and Restart action
  hidden; client mode labels Start as Connect. Both actions carry the same
  translated `Ctrl+S` shortcut. The Start action is disabled when the selected
  role cannot run.
- A second GUI process connects to the existing instance's `deskflow-gui`
  local socket and exits. The existing GUI handles that connection with
  `showAndActivate()`, which restores the window and changes macOS activation
  policy from accessory to regular. Ordinary app activation does not expose an
  equivalent Deskflow-specific callback.
- Hammerspoon's asynchronous `getMenuItems(callback)` returns localized titles,
  enabled state, and shortcut metadata. This permits action discovery by menu
  state/shortcut followed by selection using the discovered title, without
  hardcoding `File`, `Start`, or `Connect`.
- Deskflow is GPL-2.0-only with an OpenSSL exception and is actively maintained.
  Hammerspoon is MIT and actively maintained. Runtime composition and
  repository configuration do not create a license incompatibility.

Primary sources:
- `CoreProcess.cpp`: https://github.com/deskflow/deskflow/blob/v1.26.0/src/lib/gui/core/CoreProcess.cpp
- `CoreArgParser.cpp`: https://github.com/deskflow/deskflow/blob/v1.26.0/src/apps/deskflow-core/CoreArgParser.cpp
- `deskflow-gui.cpp`: https://github.com/deskflow/deskflow/blob/v1.26.0/src/apps/deskflow-gui/deskflow-gui.cpp
- `deskflow-core.cpp`: https://github.com/deskflow/deskflow/blob/v1.26.0/src/apps/deskflow-core/deskflow-core.cpp
- `MainWindow.cpp`: https://github.com/deskflow/deskflow/blob/v1.26.0/src/lib/gui/MainWindow.cpp
- Hammerspoon application API: https://www.hammerspoon.org/docs/hs.application.html

## Constraints and Integration Risks

- **GUI menu surface**: role-specific Start/Connect actions are translated and
  can be unavailable while the application is hidden as a menu-bar accessory.
  Fixed English menu paths are not a safe contract; shortcut metadata provides
  a source-backed candidate selector that still needs host confirmation.
- **Activation race**: menu inspection/selection can fail until Deskflow is
  frontmost. Recovery temporarily steals focus and must restore the previous
  application on every terminal path.
- **Process identity**: name-only matching cannot distinguish a stale copy,
  development build, wrong role, orphan, or duplicate. The GUI bundle path,
  GUI PID, core executable path, parent PID, and role argument are relevant.
- **`ps command` is not an identity source**: the macOS `ps(1)` manual states
  that command/argument discovery is inherently unreliable and process-modifiable.
  Kernel-derived path/parent data is required for the accepted exact-identity
  boundary; argv remains needed only for the role.
- **Asynchronous observation**: process inspection and GUI activation must not
  overlap timer ticks. A single-flight state machine is required.
- **Ambiguous states**: an orphaned or multiple core is not equivalent to an
  absent core. The accepted scope forbids automatic termination.
- **Permissions**: Hammerspoon and Deskflow need separate Accessibility grants.
  Hammerspoon can directly query only its own grant.
- **Static validation limit**: LuaLS proves API symbol existence, not GUI menu
  behavior or process singleton recovery.

## Implementation Approach Options

### Option A: Extend the Deskflow module
Add watchdog options and Hammerspoon Lua contribution inside
`home-manager/common/deskflow/default.nix`.

- Advantages: role and enablement are already local; fewer imports.
- Costs: couples static Deskflow configuration to Hammerspoon runtime behavior;
  enlarges a completed module whose prior spec excluded process management.
- Compatibility: feasible without changing existing defaults, but weakens the
  existing boundary.

### Option B: New optional Hammerspoon consumer
Add `home-manager/common/hammerspoon-deskflow-watchdog/` with its own option and
Lua runtime, reading `config.home.deskflow` only for prerequisites and role.

- Advantages: matches `hammerspoon-brightness-ac`; isolates state-machine and
  external-application behavior; leaves both existing renderers unchanged.
- Costs: introduces a new module, test harness, and explicit cross-module
  assertions.
- Compatibility: additive and disabled by default. This is the strongest fit
  for design evaluation.

### Option C: Generic Hammerspoon process-supervision framework
Create a reusable process-watch schema/state machine, then configure Deskflow as
its first application profile.

- Advantages: reusable if more GUI-owned processes need supervision.
- Costs: requires a general contract before a second use case exists; Deskflow's
  GUI-menu recovery is application-specific; larger verification surface.
- Compatibility: additive but disproportionate to current scope.

## Implementation Evidence Still Required

- Capture snapshot-helper output for GUI-owned client and server cores and
  confirm path, parent PID, and role against live process state.
- Capture the Hammerspoon menu tree when stopped and hidden on both roles to
  confirm that the source-backed unique enabled `Ctrl+S` selector is stable.
- Verify that invoking the GUI bundle executable a second time from Hammerspoon
  reaches the existing instance's `showAndActivate()` path on the packaged cask.
- Confirm the existing Hammerspoon semantic check covers the selected timer,
  sleep/wake, asynchronous task, application, and menu APIs.

## Design Recommendations

- Evaluate Option B first and keep all existing Deskflow/Hammerspoon renderer
  contracts unchanged.
- Separate pure classification/state transitions from Hammerspoon adapters so
  R2–R5 can be fixture-tested without a live crash.
- Treat menu discovery and process inventory as typed adapter results rather
  than embedding policy in callbacks.
- Require a personal-host crash drill before declaring R7 complete; static
  checks cannot close the GUI integration risk.

## Design Synthesis
- **Generalization**: client and server are values of one role-aware watchdog
  model. The interface is role-generic; implementation remains Deskflow-specific.
- **Build vs. adopt**: adopt Hammerspoon timers, lifecycle watcher, asynchronous
  tasks, application menus, and alerts. Build only the pure classifier and
  policy model because Deskflow 1.26.0 provides no macOS restart control plane.
- **Simplification**: expose one public enable flag and keep timing/retry policy
  fixed. Do not add a generic supervisor, supporting service, persistent state,
  or changes to either existing renderer.
- **Test seam**: keep process parsing, menu selection, and state transitions in
  plain Lua; confine `hs.*` calls to a runtime shell.
- **Identity adapter**: use a small Nix-built Darwin helper over `libproc` and
  `sysctl(KERN_PROCARGS2)` instead of `ps command`; this keeps process mutation
  out of scope while making path/parent checks authoritative.
- **Interrupted recovery**: treat GUI activation as an explicit asynchronous
  phase and sleep as an abort path that restores prior focus before wake grace.

Additional source:
- macOS `ps(1)`: https://manp.gs/mac/1/ps — command arguments are documented as
  inherently unreliable and alterable by the process.
