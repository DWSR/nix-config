# Requirements Document

## Introduction

The `opencode-turn-timestamps` feature adds visible per-turn timestamps to the
OpenCode live terminal transcript for this repo-managed OpenCode installation.
It supports session reconstruction, latency debugging, and long-session
awareness without changing conversation content or adding a new persistence
surface.

## Boundary Context

- **In scope**:
  - Visible timestamps for user and assistant turns in the live OpenCode TUI
    transcript.
  - Stable timestamp behavior while assistant output is streaming.
  - Activation through the existing declarative host rebuild and OpenCode
    restart workflow on both configured nix-darwin hosts.
  - Verification that timestamp rendering survives the repo's pinned OpenCode
    package updates.
- **Out of scope**:
  - Plugin-owned JSONL or Markdown turn logs.
  - OpenCode persistent session schema changes.
  - Cavemem, Obsidian memory capture, or transcript migration changes.
  - Prompt, message, tool-call, or model-context mutation.
  - Upstream plugin API design.
  - Web UI or desktop UI rendering unless it shares the same transcript display
    path.
- **Adjacent expectations**:
  - Existing OpenCode session history remains the persistence source for message
    timing data.
  - `session-compaction`, `rtk-install`, `opencode-cost-diagnosis`, and
    `mcpproxy-migration` behavior remains unchanged.
  - OpenCode configuration changes still require a fresh OpenCode process before
    the operator expects changed behavior.

## Requirements

### Requirement 1: Live turn timestamp visibility

**Objective:** As the operator, I want the live OpenCode transcript to show when
each conversation turn occurred, so that I can reconstruct long sessions without
consulting separate logs.

#### Acceptance Criteria

1. When a user turn is shown in the live OpenCode terminal transcript, the
   OpenCode TUI shall display a timestamp associated with that user turn.
2. When an assistant turn is shown in the live OpenCode terminal transcript, the
   OpenCode TUI shall display a timestamp associated with that assistant turn.
3. While an assistant turn is streaming, the OpenCode TUI shall keep the
   timestamp for that assistant turn stable.
4. When a continued or reopened session shows historical user or assistant
   turns with timing metadata, the OpenCode TUI shall display timestamps for
   those historical turns.
5. The OpenCode TUI shall limit turn timestamps to user and assistant turns.

### Requirement 2: Timestamp meaning and readability

**Objective:** As the operator, I want timestamps to be understandable and
consistent, so that timing information is useful during active debugging and
later review.

#### Acceptance Criteria

1. The OpenCode TUI shall base each displayed turn timestamp on the turn's
   creation time.
2. The OpenCode TUI shall display turn timestamps in the running host's local
   time.
3. The OpenCode TUI shall use one consistent human-readable timestamp format for
   user and assistant turns.
4. When a visible transcript contains turns from more than one local calendar
   day, the OpenCode TUI shall distinguish timestamps from different local
   calendar days.
5. If a user or assistant turn lacks creation-time metadata, the OpenCode TUI
   shall render the turn without displaying an incorrect timestamp.

### Requirement 3: Conversation behavior preservation

**Objective:** As the operator, I want timestamps to be display-only metadata,
so that OpenCode behavior, model context, and transcript content stay unchanged.

#### Acceptance Criteria

1. When timestamp display is active, OpenCode shall preserve the original text of
   user and assistant messages.
2. When timestamp display is active, OpenCode shall not include timestamp text in
   content sent to language models.
3. When timestamp display is active, OpenCode shall not include timestamp text in
   tool-call inputs.
4. When timestamp display is active, the OpenCode TUI shall preserve transcript
   turn order, role labels, and streaming updates.
5. While terminal width is constrained, the OpenCode TUI shall not replace or
   hide message text with timestamp text.

### Requirement 4: Host availability and operator workflow

**Objective:** As the operator, I want timestamp display to arrive through the
same host workflow as the rest of OpenCode, so that both target hosts behave
consistently without manual bootstrap steps.

#### Acceptance Criteria

1. When the operator applies the standard host rebuild and starts a fresh
   OpenCode process on either configured host, the OpenCode TUI shall show turn
   timestamps without a separate install command.
2. The OpenCode TUI Timestamp Feature shall be available on both configured
   nix-darwin hosts where OpenCode is enabled.
3. The OpenCode TUI Timestamp Feature shall not require runtime network access
   after the host configuration has been built.
4. If timestamp-capable OpenCode cannot be produced during the host build or
   verification workflow, the workflow shall fail before reporting timestamp
   support as available.
5. The OpenCode TUI Timestamp Feature shall document that already-running
   OpenCode processes do not pick up feature changes until restart.

### Requirement 5: Persistence and adjacent-feature boundaries

**Objective:** As the operator, I want timestamp display to avoid overlapping
existing memory, diagnostic, and session-management systems, so that this feature
stays narrowly scoped.

#### Acceptance Criteria

1. The OpenCode TUI Timestamp Feature shall not create additional per-session
   timestamp log files.
2. The OpenCode TUI Timestamp Feature shall not change OpenCode's persistent
   session storage format.
3. The OpenCode TUI Timestamp Feature shall not change cavemem capture behavior.
4. The OpenCode TUI Timestamp Feature shall not change Obsidian memory capture
   behavior.
5. The OpenCode TUI Timestamp Feature shall not change cost-diagnostic,
   session-compaction, RTK, or mcpproxy behavior.
6. When existing OpenCode session history contains timing metadata, the OpenCode
   TUI Timestamp Feature shall leave that history unchanged.

### Requirement 6: Verification and update safety

**Objective:** As the operator, I want regressions to be caught before I rely on
timestamp display, so that OpenCode updates do not silently remove the feature.

#### Acceptance Criteria

1. When the repo's verification workflow runs, the repo's verification workflow
   shall verify timestamp display for user turns.
2. When the repo's verification workflow runs, the repo's verification workflow
   shall verify timestamp display for assistant turns.
3. When the repo's verification workflow runs, the repo's verification workflow
   shall verify stable timestamp display for streaming assistant turns.
4. When the repo's verification workflow runs, the repo's verification workflow
   shall verify that timestamp display does not alter user or assistant message
   text.
5. If an OpenCode update removes timing metadata or transcript display behavior
   required by this feature, the repo's verification workflow shall fail with an
   error that identifies timestamp display as the affected capability.
