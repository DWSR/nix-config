# Brief: memory-sync-cli

## Problem

After cavemem-integration and vault-synthesizer-agent ship, the user has the
machinery for ambient capture and on-demand promotion to curated memories
— but no convenient way to trigger them on a schedule. To run a sync today,
the user would have to: open opencode, invoke `@vault-synthesizer` with a
time range, wait for it to finish, invoke `@vault-curator`, wait again,
manually note the timestamp of the last sync somewhere, and remember to
pass `--since <that timestamp>` next time. That's exactly the manual
bookkeeping cavemem was supposed to eliminate.

We need a single shell command (`memory-sync`) that the user can invoke
from any terminal — periodically, by hand or via launchd later — that:
- Knows when the last sync happened (marker file)
- Computes the [last_marker, now] time range
- Invokes the synthesizer agent with that range
- Invokes the curator agent on the resulting drafts
- Atomically updates the marker file on success

This is the orchestration surface that turns cavemem + synthesizer +
curator into a complete memory-promotion pipeline.

## Current State

- **Scripts pattern**: `scripts/cc-sdd-init.nix`, `scripts/mcp-sync-from-1password.nix`,
  `scripts/mcp-verify-secrets.nix`, `scripts/sqlite-backup-cli.nix`,
  `scripts/bump-shopify-taps.nix`, `scripts/mcp-secrets-activate.nix`.
  Each is a `pkgs.writeShellApplication` (or similar) wrapped in a `.nix`
  file, exposed via the overlay, available on PATH.
- **No existing orchestration around subagents**: opencode subagents are
  invoked from inside an opencode session. There is no canonical pattern
  in this repo for invoking a subagent from a shell command. This is an
  open design question that this spec resolves.
- **Marker file precedent**: The repo has no existing marker-file pattern
  but XDG state convention is well-established (`$XDG_STATE_HOME` defaults
  to `~/.local/state` on darwin per the spec).
- **Agents that this command will invoke**:
  - `vault-synthesizer` (new, defined in vault-synthesizer-agent spec):
    reads cavemem in [start, end], drafts memory notes
  - `vault-curator` (existing): dedups and consolidates memories

## Desired Outcome

When this spec is done:

1. `memory-sync` is a binary on PATH on both Shopify and personal hosts,
   built via `scripts/memory-sync.nix` and exposed through the overlay.
2. Running `memory-sync` with no arguments:
   a. Reads `$XDG_STATE_HOME/memory-sync/last-run` (creates parent dir if
      missing; if the file doesn't exist, defaults to `30 days ago`)
   b. Computes the time range `[marker, now]`
   c. Invokes the vault-synthesizer agent with that range
   d. Waits for synthesizer completion; captures its structured report
   e. Invokes the vault-curator agent to dedup the new drafts
   f. Waits for curator completion
   g. On overall success, writes the new timestamp to `last-run` atomically
      (write to `last-run.tmp`, fsync, mv to `last-run`)
   h. Prints a human-readable summary: time range processed, drafts written,
      curator changes
3. Supported flags:
   - `--since YYYY-MM-DD` or `--since "7 days ago"`: override the marker
     for one run; does NOT update the marker file
   - `--dry-run`: run synthesizer + curator with the existing range but do
     NOT write to Obsidian or update the marker; useful for previewing
   - `--verbose` / `-v`: stream intermediate progress
   - `--no-curator`: skip the curator pass; useful if the user wants to
     review drafts before dedup
   - `--help` / `-h`: usage
4. Exit codes:
   - `0`: success
   - `1`: synthesizer failed
   - `2`: curator failed
   - `3`: marker file unwritable
   - `4`: cavemem MCP unreachable (precondition check)
   - `5`: Obsidian MCP unreachable (precondition check)
5. The command is idempotent and safe to re-run: if a previous run failed
   between synthesizer and curator, re-running picks up where it left off
   (the marker file is only updated on full success, so the same range
   re-runs).
6. The command is well-logged: a per-run log under
   `$XDG_STATE_HOME/memory-sync/logs/<timestamp>.log` captures synthesizer
   output, curator output, marker before/after, exit status. Last 10 logs
   retained; older ones pruned.

## Approach

The big design question is: **how does a shell command invoke an opencode
subagent?** Three plausible paths:

**Option 1: Non-interactive opencode session.** `memory-sync` shells out
to `opencode run --agent vault-synthesizer --prompt "synthesize cavemem from
<start> to <end>"` (assuming opencode supports a `run` non-interactive mode;
verify in design phase). Then `opencode run --agent vault-curator --prompt
"dedup the new memories from the last sync"`. Pros: reuses opencode's
existing agent infrastructure verbatim; the agent files are loaded the
same way they would be in an interactive session. Cons: depends on
opencode supporting non-interactive subagent invocation; spawns a full
opencode runtime per command run (heavyweight).

**Option 2: Direct LLM API + agent-as-prompt.** `memory-sync` is a Node/Python
script that loads the agent .md files from disk, extracts the system-prompt
body, calls the Anthropic API directly with that system prompt and the
time range as the user message, and parses the structured output. The
script wires Obsidian MCP and cavemem MCP tools to the API call (using
the Anthropic tool-use protocol). Pros: lightweight, fast, deterministic,
doesn't need opencode running. Cons: re-implements parts of opencode's
agent loop; needs API key delivery via mcp-secrets-sops-nix flow; agent
prompts have to be parseable from .md without opencode's loader.

**Option 3: Background mcphub + per-tool dispatch.** `memory-sync` talks
directly to cavemem MCP and Obsidian MCP via mcphub (which is already
running as a launchd agent), implements the synthesizer and curator
logic in shell/Node directly. Pros: fully self-contained, no LLM
involvement at the shell-command layer. Cons: this throws out the
selectivity reasoning that the synthesizer agent was designed to bring;
it would just be a mechanical timeline-to-memory translator.

**Recommended for design phase**: Option 1 if opencode supports
non-interactive agent runs cleanly; Option 2 as fallback. Option 3 is
ruled out because it sacrifices the synthesizer's value. The spec design
phase makes this decision after spiking opencode's `run` mode.

Regardless of which option wins, the orchestration logic itself is:

```
1. Pre-flight: check cavemem MCP health, check Obsidian MCP health
2. Read marker (or default to 30 days ago)
3. Compute now (RFC 3339 UTC)
4. Lock: create $XDG_STATE_HOME/memory-sync/lock; refuse if held
5. Invoke synthesizer with [marker, now]
6. Invoke curator
7. Atomic marker update: write to .tmp, fsync, mv
8. Release lock
9. Print summary, write log, prune old logs
```

## Scope

- **In**:
  - `scripts/memory-sync.nix` shell command + overlay registration
  - Marker file management at `$XDG_STATE_HOME/memory-sync/last-run`
  - Lock file at `$XDG_STATE_HOME/memory-sync/lock` (prevents concurrent
    runs)
  - Per-run logs at `$XDG_STATE_HOME/memory-sync/logs/<timestamp>.log`
    with retention (last 10 runs)
  - Pre-flight health checks (cavemem MCP, Obsidian MCP)
  - Flag set: `--since`, `--dry-run`, `--verbose`, `--no-curator`, `--help`
  - Exit code conventions
  - Atomic marker update (write-tmp + fsync + mv)
  - Default marker (30 days ago) when file missing
  - Idempotency: failed runs leave the marker untouched so re-runs
    retry the same range
  - Subagent invocation mechanism (Option 1 / 2 / 3 decided in design)
- **Out**:
  - Auto-scheduling (no launchd plist, no systemd timer); user invokes
    manually. Schedule can be added in a follow-up spec.
  - Building the subagents themselves (separate specs)
  - Building cavemem (cavemem-integration spec)
  - Cross-host coordination (each host has its own marker)
  - Multi-project sync (one global marker; per-project syncing can be a
    follow-up if/when needed)
  - Notification/desktop alert on completion (out of scope; logs suffice)

## Boundary Candidates

- **Marker management vs subagent invocation**: marker logic is filesystem
  + atomicity; invocation is process orchestration + I/O. Clean seam.
  Implement marker as a small reusable function/module so the command
  body stays focused on orchestration.
- **Pre-flight checks vs main flow**: health checks fail fast; main flow
  runs the agents. Good place for early exit codes (4 and 5).
- **Logging vs orchestration**: logs are a side concern; orchestration
  is the value. Tee output to log + stdout, prune logs as a separate
  step at the end.

## Out of Boundary

- Defining the synthesizer's behavior (vault-synthesizer-agent spec)
- Defining the curator's behavior (existing, untouched)
- Adding any new MCP tools to cavemem (cavemem-integration spec)
- Cross-host marker coordination (single-host scope; user runs on each
  host separately)
- Notification/UI surfaces (logs are the only output channel)

## Upstream / Downstream

- **Upstream**:
  - `cavemem-integration` spec — provides cavemem MCP server that the
    pre-flight check probes and the synthesizer reads
  - `vault-synthesizer-agent` spec — the agent this command invokes first
  - `home-manager/common/agents/vault-curator.md` — the agent invoked
    second (already exists)
  - `home-manager/common/opencode.nix` — opencode runtime that hosts the
    agents (Option 1 decision)
  - mcphub launchd agent — already running; provides the MCP transport
- **Downstream**:
  - Future "auto-schedule memory-sync" spec (if/when user wants
    launchd/systemd timer; cleanly bolts on after this lands)
  - Future per-project sync variant (if needed; this is the global default)

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**:
  - `cavemem-integration`: provides the data source
  - `vault-synthesizer-agent`: provides the synthesizer this command runs
  - `sqlite-backup`: the cavemem.db extension shipped via that spec means
    a synth pass can recover from a restored backup; no direct dependency
  - `cc-sdd-integration`: precedent for a Nix-packaged shell command that
    runs Node/JS

## Constraints

- **POSIX shell or Node**: Build with `pkgs.writeShellApplication` for
  shell, or wrap a Node script. Shell is simpler and matches the existing
  scripts/ pattern.
- **Atomic marker updates**: write-tmp + fsync + mv. No partial writes.
- **Lock file prevents concurrent runs**: A second `memory-sync` invocation
  while the first is running must exit non-zero (different code than
  failure; e.g., 6 = "lock held").
- **No mutation on dry-run**: `--dry-run` must not write to the marker,
  to Obsidian, or to logs other than printing what it would do.
- **Default time range guard**: If the marker is missing AND no `--since`
  is given, use 30 days ago. Don't accidentally reprocess years of cavemem
  data the first time the user invokes `memory-sync`.
- **Subagent invocation contract**: Whatever option (1/2/3) is chosen,
  the command must surface the synthesizer's and curator's output to the
  log faithfully. If the synthesizer drafts 5 memory notes, the log shows
  all 5 paths. If the curator merges 2 of them, the log shows what it did.
- **Health-check semantics**: Pre-flight checks distinguish "MCP server is
  down" from "MCP tools returned an error" so the user can fix the right
  thing.
- **Compatibility with cc-sdd workflow**: `memory-sync` is independent of
  cc-sdd; can be run from any directory; doesn't read or write any
  `.kiro/` files.
