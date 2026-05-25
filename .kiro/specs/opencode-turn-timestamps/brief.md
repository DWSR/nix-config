# Brief: opencode-turn-timestamps

## Problem

The operator uses long-running OpenCode sessions and needs visible timing context
for each user/assistant turn. Without turn-level timestamps in the live
transcript, session reconstruction, latency debugging, and long-session awareness
require correlating separate logs or databases after the fact.

## Current State

OpenCode already stores message timing data (`time.created`, and optional
assistant `time.completed`) in its session model, and this repo pins OpenCode via
the Nix overlay. The documented local plugin API can observe message/session
events and write auxiliary logs, but it does not expose a supported hook for
decorating the existing live TUI transcript.

Existing OpenCode-related specs cover cost diagnosis, session compaction, RTK
Bash-tool routing, subagent context budgets, and mcpproxy migration. None owns
live transcript presentation.

## Desired Outcome

OpenCode's live TUI transcript shows a concise timestamp on each user and
assistant turn on both nix-darwin hosts after the standard declarative rebuild
and OpenCode restart. The timestamp remains stable while assistant output is
streaming and does not alter message content sent to the model.

## Approach

Patch the pinned OpenCode TUI rendering path in this repo's Nix overlay rather
than implementing a local plugin. The patch should read the existing message
creation timestamp and render it in the user/assistant message header or adjacent
metadata area. This satisfies the visible-output requirement while avoiding an
unsupported plugin workaround.

## Scope

- **In**: OpenCode source patch carried by the repo overlay; live TUI timestamp
  display for user/assistant turns; deterministic local-time formatting;
  tests or checks that cover timestamp rendering and streaming-safe fallback;
  documentation of the restart/rebuild requirement.
- **Out**: Plugin-owned JSONL/Markdown turn logs; OpenCode SQLite schema
  changes; cavemem transcript changes; model prompt/message content mutation;
  upstream plugin API design; web UI or desktop UI timestamp rendering unless it
  shares the same code path with the TUI patch.

## Boundary Candidates

- TUI rendering: formatting and displaying timestamps from existing message
  metadata.
- Nix packaging: applying and verifying the OpenCode source patch in the pinned
  overlay without changing unrelated OpenCode integrations.

## Out of Boundary

- Persisting an additional per-session timestamp log.
- Reopening `session-compaction`, `rtk-install`, or `opencode-cost-diagnosis`.
- Changing cavemem, Obsidian memory capture, or session database ownership.
- Requiring upstream acceptance before local functionality works.

## Upstream / Downstream

- **Upstream**: OpenCode's message timestamp fields and TUI message rendering
  components; the repo's OpenCode Nix overlay; nix-darwin/Home Manager rebuild
  workflow.
- **Downstream**: Operator session review, latency debugging, and future optional
  persistence/export work if visible timestamps prove insufficient.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `session-compaction` observes turns for compaction but does not
  own display; `rtk-install` owns Bash-tool routing; `opencode-cost-diagnosis`
  reads OpenCode's SQLite database; `mcpproxy-migration` changes MCP routing.

## Constraints

- OpenCode is pinned in this repo and may lag upstream; the patch must be easy
  to rebase when the pin updates.
- Assistant `time.completed` can be absent while streaming, so display should
  use `time.created` for a stable per-turn timestamp.
- OpenCode plugin/config changes are not hot-reloaded; users must restart
  OpenCode after rebuilding the host configuration.
- The implementation must remain declarative and reproducible through Nix, with
  no imperative plugin installer or runtime network fetch.
