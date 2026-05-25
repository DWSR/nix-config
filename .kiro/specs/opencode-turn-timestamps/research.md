# Implementation Gap Analysis: opencode-turn-timestamps

## Scope and context

This analysis compares `.kiro/specs/opencode-turn-timestamps/requirements.md`
against the current nix-config codebase and OpenCode upstream surfaces. The
requirements are approved in `.kiro/specs/opencode-turn-timestamps/spec.json`.

Core steering files `product.md`, `tech.md`, and `structure.md` are not present
under `.kiro/steering/`. Relevant context comes from `.kiro/steering/roadmap.md`,
`.kiro/steering/session-compaction.md`, `.kiro/steering/rtk-install.md`, and the
OpenCode customization playbook.

## Current state investigation

### Existing repo assets

- OpenCode is selected through `home.opencode.package`, defaulting to
  `pkgs.opencode-pinned`, then wrapped by Home Manager rather than configured per
  host (`home-manager/common/opencode.nix:8`, `home-manager/common/opencode.nix:197`).
- `opencode-pinned` currently fetches `anomalyco/opencode` at `v1.15.5` with a
  fixed source hash, vendor hash, and `node_modules` output hash
  (`overlays/misc.nix:243`).
- Existing OpenCode source mutation happens in `postPatch` to replace bundled
  prompt text and intentionally fails loud if upstream paths move
  (`overlays/misc.nix:292`).
- The `node_modules` derivation has a custom Bun install path because upstream's
  filtered install omits root dev dependencies (`overlays/misc.nix:263`). Adding
  runtime dependencies for timestamp display would increase hash churn.
- Both nix-darwin hosts consume the shared overlays and shared Home Manager
  OpenCode module; a package patch reaches both hosts through normal rebuilds
  (`flake.nix:403`, `home-manager/common/opencode.nix:197`).
- Existing OpenCode checks use `pkgs.runCommand`, copy the repo into a writable
  temp directory, and run Node tests (`flake.nix:271`).

### Existing OpenCode timestamp capability

External source inspection of OpenCode `v1.15.5` found that live TUI timestamp
support is partially present already:

- `packages/opencode/src/cli/cmd/tui/routes/session/index.tsx` defines
  `session.toggle.timestamps`, slash aliases `/timestamps` and
  `/toggle-timestamps`, and a KV state key `timestamps` with default `hide`.
- The same file renders user-message timestamps with
  `Locale.todayTimeOrDateTime(props.message.time.created)` when timestamps are
  shown.
- Assistant-message rendering currently shows mode, model, optional duration,
  and interruption state in a footer, but not the assistant turn's creation
  timestamp.
- `packages/core/src/session-message.ts` gives user and assistant messages a
  `time.created` field; assistant messages also have optional `time.completed`.

Sources:

- `https://raw.githubusercontent.com/anomalyco/opencode/v1.15.5/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
- `https://raw.githubusercontent.com/anomalyco/opencode/v1.15.5/packages/core/src/session-message.ts`

### Plugin and config surfaces

- OpenCode plugins can observe message/session events, mutate specific hook
  outputs, add tools, log, append prompt text, or show toasts, but the documented
  plugin API does not expose a hook for decorating existing transcript rows.
- Local plugin examples in this repo match that limitation: cavemem observes
  lifecycle/tool events (`home-manager/common/opencode-plugins/cavemem.js:61`),
  and RTK mutates Bash/shell tool arguments (`home-manager/common/opencode-plugins/rtk.ts:323`).
- Host `tui.json` and opencode settings can configure existing behavior but do
  not provide per-message rendering control (`configurations/shopify/home-manager/opencode.nix:32`).

Source:

- `https://opencode.ai/docs/plugins/`

## Requirement-to-asset map

| Requirement | Existing assets | Gap status |
|---|---|---|
| R1 Live turn timestamp visibility | OpenCode TUI already has a timestamp toggle and user timestamp rendering in upstream `v1.15.5`; message rows are hardcoded in the session route. | **Missing:** assistant turn creation timestamp rendering. **Constraint:** default is `hide`, while requirements expect timestamps after rebuild/restart. |
| R2 Timestamp meaning and readability | Upstream helper `Locale.todayTimeOrDateTime` already formats user timestamps and distinguishes date/time when needed. | **Missing:** assistant use of the same helper. **Unknown:** exact UX placement for assistant timestamp relative to mode/model/duration. |
| R3 Conversation behavior preservation | Current timestamp rendering is display-only in TUI code; repo plugins show how to avoid prompt/tool mutation. | **Constraint:** patch must stay in rendering path only and not touch message serialization, SDK data, tool inputs, or transcript export unless design intentionally proves shared path. |
| R4 Host availability and operator workflow | `home.opencode.package` points at `pkgs.opencode-pinned`; package wrapper reaches both hosts through shared HM. | **Missing:** patch file / overlay wiring / build canary for timestamp-capable OpenCode. **Constraint:** already-running OpenCode processes still require restart. |
| R5 Persistence and adjacent boundaries | OpenCode session history already carries timing metadata; cost diagnosis reads but does not mutate session DB. | **Constraint:** no new log files, DB schema changes, cavemem changes, Obsidian changes, or changes to RTK/session-compaction/mcpproxy behavior. |
| R6 Verification and update safety | Existing flake checks cover OpenCode-adjacent plugins and validator scripts. | **Missing:** timestamp-specific checks for user rendering, assistant rendering, streaming-stable timestamp, content preservation, and OpenCode-update failure clarity. |

## Implementation approach options

### Option A: Extend the existing OpenCode TUI timestamp feature in the overlay

Add a small source patch to the pinned OpenCode package that changes the
existing timestamp state default from hidden to shown and extends assistant
metadata rendering to include `message.time.created` when timestamps are shown.
Keep the existing `/timestamps` toggle as the operator control surface.

- **Files/modules to extend**:
  - `overlays/misc.nix` to apply a discrete timestamp patch alongside the prompt
    `postPatch` (`overlays/misc.nix:301`).
  - New patch file under `overlays/`, e.g. `overlays/opencode-turn-timestamps.patch`.
  - New tests/checks under `tests/opencode-turn-timestamps/` and `flake.nix`
    near existing OpenCode checks (`flake.nix:271`).
- **Pros**:
  - Smallest delta that satisfies approved requirements.
  - Reuses OpenCode's existing timestamp toggle, formatting helper, and message
    timestamp fields.
  - No new Home Manager module is needed if the feature is always active in the
    pinned package.
- **Cons / risks**:
  - Source patch may break when OpenCode updates the session route.
  - True TUI render tests may be awkward outside upstream's package test harness.
  - Requirements imply visible-by-default behavior; changing upstream default may
    surprise if the operator expected the toggle to remain hidden by default.
- **Effort**: S to M. The source delta is small; verification may take most of
  the time.
- **Risk**: Medium. The target file is external and may churn; existing upstream
  support lowers functional risk.

### Option B: Add a local plugin or custom route

Use an OpenCode plugin to observe message events or register a custom TUI route
that re-renders timestamped session messages separately from the built-in live
transcript.

- **Files/modules to create**:
  - A plugin under `home-manager/common/opencode-plugins/` and possibly a feature
    HM module following the session-compaction pattern.
- **Pros**:
  - Avoids patching upstream OpenCode source.
  - Easier to keep local logic isolated and separately tested.
- **Cons / risks**:
  - Does not satisfy the current requirements because plugins do not decorate the
    existing live transcript.
  - A parallel route would duplicate transcript behavior and could drift from
    upstream.
  - Adds a new plugin/config surface despite the requirements excluding new
    persistence or prompt/tool mutation.
- **Effort**: M.
- **Risk**: High for requirement fit; low-to-medium technically.

### Option C: Upstreamable patch plus local overlay carry

Develop the minimal TUI patch as an upstream-friendly change and carry it in the
Nix overlay until an OpenCode release includes it. Optionally bump from `v1.15.5`
to the current upstream release during design or implementation.

- **Files/modules to extend**:
  - Same local files as Option A.
  - Optional upstream PR branch outside this repo.
- **Pros**:
  - Reduces long-term overlay maintenance if accepted upstream.
  - Forces the design to align with upstream UX and tests.
- **Cons / risks**:
  - Slower than Option A if upstream review is in the critical path.
  - Combining an OpenCode version bump with timestamp work increases moving
    parts and hash-refresh cost.
- **Effort**: M.
- **Risk**: Medium. Local delivery can still proceed, but upstream timing is
  uncertain.

## Integration challenges

- **Default visibility**: Existing OpenCode stores timestamp visibility in a KV
  state defaulting to `hide`. Requirements require visible timestamps after
  rebuild/restart, so design must decide whether to change the default to `show`,
  set a config-time default, or document a one-time `/timestamps` toggle only if
  requirements are revised.
- **Assistant placement**: Assistant turns already have a footer containing mode,
  model, optional duration, and interrupted state. The timestamp must fit without
  crowding narrow terminals or hiding message text.
- **Streaming behavior**: Assistant `time.completed` can be absent while
  streaming. Requirements point at stable per-turn timestamps, so design should
  use `time.created` for display and leave duration behavior unchanged.
- **Patch rebasing**: There is no vendored OpenCode source tree in this repo;
  the package fetches upstream and patches during build. A path-level patch is a
  build-time canary but will need rebase on session route churn.
- **Test surface**: Source-level helper tests are easy if formatting is factored.
  Full TUI behavior may require either upstream package tests or a local source
  inspection/build canary rather than a runtime terminal UI smoke test.

## Research needed for design phase

- Confirm whether `v1.15.5` should be patched directly or whether this feature
  should first bump `opencode-pinned` to the current upstream tag.
- Inspect upstream's own test harness for TUI components to choose between
  component tests, source-level tests, or a package build canary.
- Decide exact assistant timestamp placement and local-time format in the footer
  without prescribing implementation in requirements.
- Decide whether the existing `/timestamps` toggle remains user-controllable with
  a default of `show`, or whether host configuration should manage the default.
- Check whether transcript copy/export shares any rendering path with the live
  TUI. Requirements exclude export changes unless shared; design should verify.

## Design-phase recommendation

Option A is the most direct fit for the approved requirements: extend the
existing OpenCode TUI timestamp feature in the pinned package and add local
verification. Option C is a maintenance-friendly variant if upstreaming is worth
the extra coordination. Option B should be treated as a fallback only if the
requirements are relaxed away from the existing live transcript.

---

# Design Discovery and Synthesis: opencode-turn-timestamps

## Summary

- **Feature**: `opencode-turn-timestamps`
- **Discovery Scope**: Extension / light discovery
- **Key Findings**:
  - OpenCode `v1.15.5` already has `/timestamps`, a timestamp visibility KV
    signal, and user-message timestamp rendering; assistant rendering is the
    main TUI gap.
  - Plugin and TUI plugin APIs still do not expose a per-message wrapper slot for
    the built-in transcript, so a core TUI patch remains the correct boundary.
  - The existing upstream timestamp key defaults to `hide`; a feature-owned key
    with default `show` avoids stale hidden values after activation.

## Research Log

### OpenCode TUI timestamp surface

- **Context**: Design needed the exact upstream seam for live transcript
  rendering.
- **Sources Consulted**:
  - `https://raw.githubusercontent.com/anomalyco/opencode/v1.15.5/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
  - `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx`
  - `https://opencode.ai/docs/keybinds/`
- **Findings**:
  - `session.toggle.timestamps`, `/timestamps`, and `/toggle-timestamps` already
    exist.
  - User message rendering already calls `Locale.todayTimeOrDateTime` with
    `message.time.created`.
  - Assistant footer renders mode/model/duration/interrupted metadata but no
    creation timestamp.
- **Implications**: Patch the existing session route instead of creating new UI
  infrastructure.

### Message timestamp fields and streaming

- **Context**: Requirements require stable assistant timestamps while output is
  streaming.
- **Sources Consulted**:
  - `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/message-v2.ts`
  - `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/processor.ts`
- **Findings**:
  - User messages have `time.created`.
  - Assistant messages have `time.created` and optional `time.completed`.
  - Streaming assistant messages lack `time.completed` until cleanup.
- **Implications**: Display `time.created` for assistant turns and leave duration
  behavior unchanged.

### Repo integration surface

- **Context**: Design needed concrete files and verification hooks.
- **Sources Consulted**:
  - `overlays/misc.nix:243`
  - `home-manager/common/opencode.nix:8`
  - `flake.nix:271`
- **Findings**:
  - `opencode-pinned` is the central package used by both hosts.
  - A package-level patch reaches both hosts without a new Home Manager module.
  - Existing flake checks can host Node contract tests and a package build
    canary.
- **Implications**: Add a discrete patch file, wire it in the overlay, and add
  timestamp-specific flake checks.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Overlay TUI patch | Patch OpenCode's existing session route in `opencode-pinned` | Directly satisfies live transcript requirements | Must rebase on upstream route churn | Selected |
| Local plugin route | Add separate plugin UI or route | Isolated local code | Does not modify built-in transcript | Rejected for requirement fit |
| Upstream-first | Land upstream then update pin | Long-term maintenance | Blocks local delivery on review timing | Deferred |

## Design Decisions

### Decision: Patch the existing TUI timestamp feature

- **Context**: Requirements target the built-in live transcript.
- **Alternatives Considered**:
  1. Plugin route — separate UI that duplicates transcript rendering.
  2. TUI source patch — modify the existing transcript route.
- **Selected Approach**: Patch the OpenCode TUI session route through
  `opencode-pinned`.
- **Rationale**: Existing plugin hooks cannot decorate each built-in transcript
  row, while the session route already owns timestamp state and user rendering.
- **Trade-offs**: Small source patch now, rebase work on future OpenCode bumps.
- **Follow-up**: Keep patch file discrete and covered by a build canary.

### Decision: Use creation time for all turn timestamps

- **Context**: Assistant completion time is absent while streaming.
- **Alternatives Considered**:
  1. Use `time.completed` for assistants.
  2. Use `time.created` for user and assistant turns.
- **Selected Approach**: Use `time.created` consistently.
- **Rationale**: Stable during streaming and matches existing user timestamp
  behavior.
- **Trade-offs**: Does not show completion time; existing duration metadata still
  covers elapsed time after finalization.
- **Follow-up**: Static test verifies assistant rendering does not depend on
  `time.completed`.

### Decision: Feature-owned visible default

- **Context**: Upstream's `timestamps` KV defaults to `hide`, and older local KV
  state may already contain hidden values.
- **Alternatives Considered**:
  1. Change only upstream default.
  2. Use a feature-owned visibility key defaulting to `show`.
- **Selected Approach**: Feature-owned key with default `show`, still controlled
  by `/timestamps`.
- **Rationale**: Guarantees first-run visibility after feature activation without
  depending on old hidden state.
- **Trade-offs**: Existing upstream timestamp preference is not migrated.
- **Follow-up**: Manual smoke should confirm `/timestamps` still toggles display.

## Risks & Mitigations

- Upstream route churn — discrete patch plus package build canary fails before
  runtime.
- Patch boundary creep — static test allowlists the OpenCode TUI session route.
- Narrow-terminal crowding — render metadata outside message text and preserve
  message content over timestamp layout.
- Hidden persisted upstream state — feature-owned key defaults to `show`.

## References

- [OpenCode plugin docs](https://opencode.ai/docs/plugins/) — hook limitations.
- [OpenCode keybind docs](https://opencode.ai/docs/keybinds/) — timestamp toggle
  command surface.
- [OpenCode v1.15.5 session route](https://raw.githubusercontent.com/anomalyco/opencode/v1.15.5/packages/opencode/src/cli/cmd/tui/routes/session/index.tsx) — patch target.
- [OpenCode message schema](https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/message-v2.ts) — timestamp fields.
