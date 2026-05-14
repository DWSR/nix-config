# MANDATORY: Memory System (Obsidian + Cavemem)

All agent sessions MUST use BOTH the Obsidian vault and cavemem for persistent
memory. Obsidian holds curated, agent-authored memories; cavemem captures
session transcripts and summaries automatically through opencode hooks. This is
non-negotiable.

## Startup Check

BEFORE responding to any user message, you MUST verify that BOTH MCP servers
are available:

1. Call `hub_obsidian__list-notes` with `directory` set to `"memories"` and
   `limit` set to `1`.
2. Call `hub_cavemem__list_sessions` with a small limit (e.g. `1`) to confirm
   the cavemem MCP server is reachable.

If EITHER call FAILS or the corresponding MCP tools (`hub_obsidian__*` or
`hub_cavemem__*`) are not available:
1. Tell the user: "Obsidian or cavemem MCP tools are unavailable. I cannot
   create curated memories or rely on ambient session capture. Ensure mcphub
   is running with both the obsidian and cavemem servers registered, then
   retry."
2. DO NOT proceed with any work.
3. DO NOT attempt workarounds such as writing to local files or skipping
   either system.

## Ambient capture (cavemem)

Conversation transcription and session-level summarization are no longer
agent-driven bookkeeping tasks. Cavemem captures every prompt, response, and
tool call automatically through opencode hooks and persists them to its local
SQLite database (the path is exposed by the home-manager module as
`home.cavemem.dataDir`). Cavemem also tracks session lifecycle, so there is
no need to manually create transcription notes, look up an existing session
for the day, or ask the user whether to continue or start fresh — that is all
handled by the hooks.

Agents MUST NOT write transcription or summary notes into the Obsidian vault.
The legacy directories `conversations/transcriptions/` and
`conversations/summaries/` now hold archived/migrated history only and are
not part of the live capture loop.

For ad hoc retrieval of past observations, use the cavemem MCP tools (prefix
`hub_cavemem__`):

- `hub_cavemem__list_sessions` — list recent cavemem sessions
- `hub_cavemem__timeline` — fetch the chronological observation stream for a
  session
- `hub_cavemem__get_observations` — load specific observations by ID
- `hub_cavemem__search` — full-text / semantic search across all captured
  observations

The same query surface is available from the command line as `cavemem search`
for human-driven lookups outside of an agent session.

Curated memory creation remains an explicit, agent-driven act and is governed
by the rules in the "Memories" section below.

## Memory Recall

After session initialization, and whenever you encounter a question, problem,
or topic that may have been addressed in a previous session, search existing
memories BEFORE using other research tools (web fetches, codebase exploration,
task agents, etc.).

### At session start

As part of session initialization, search for memories related to the current
project:

1. Call `hub_obsidian__search-by-tags` with the project name tag, filtered to
   `directory` `"memories"`.
2. Briefly review any returned memories to prime your context with prior
   decisions, patterns, and discoveries.

### During the session

When you encounter a task that involves:
- Understanding how something in the codebase works
- Making a decision about architecture, tooling, or patterns
- Debugging an issue or diagnosing a root cause
- Answering a question about prior work or decisions
- Researching a library, tool, or integration that may have been evaluated before

Search memories FIRST:

1. Call `hub_obsidian__search-vault` with relevant keywords, with `path` set
   to `"memories/"`.
2. Call `hub_obsidian__search-by-tags` with relevant topic tags, filtered to
   `directory` `"memories"`.
3. Read any matching memories with `hub_obsidian__read-note`.
4. If memories provide a complete answer, use them directly -- do not
   redundantly re-research what has already been established.
5. If memories provide partial context, use them as a starting point and
   supplement with further research as needed.
6. If no relevant memories exist, proceed with normal research.

Do NOT search memories for:
- Trivial operations (simple file reads, formatting, running builds)
- Tasks where you already have full context from the current conversation
- Purely mechanical operations (code formatting, test execution)

<!-- BEGIN: memory-criteria -->
## Memories

Memories are standalone knowledge notes that persist facts, decisions, and
patterns for retrieval in future sessions. They are the most valuable output
of the memory system.

- **Path:** `memories/{date}-{slug}.md` where slug is 3-5 words, kebab-case
- **Tool:** `hub_obsidian__write-note`

### When to create a memory

Create a memory when ANY of these occur:
- A decision was made (chose X over Y, with rationale)
- A non-obvious fact was discovered (library X doesn't work with Y)
- A reusable pattern was established (this codebase does X for Y)
- A bug root cause was identified
- A configuration or architecture was explained in depth

Do NOT create memories for:
- Routine file edits with no novel insight
- Simple lookups that are easily re-searchable
- Temporary information (build output, test results)
- Information already captured in an existing memory

### Deduplication

BEFORE creating a memory, ALWAYS check for existing related memories:

1. Call `hub_obsidian__search-by-tags` with the primary topic tags you intend
   to use, filtered to `directory` `"memories"`.
2. Call `hub_obsidian__search-vault` with key terms from the memory title,
   with `path` set to `"memories/"`.
3. If a substantially similar memory exists, UPDATE it by reading the existing
   note with `hub_obsidian__read-note` and writing the updated content back to
   the same path with `hub_obsidian__write-note`. Add the current session to its
   context and refine the content.
4. Only create a new note if no existing memory covers the same ground.

### Memory note format

The frontmatter `sessions:` list accepts two value shapes: `{session-timestamp}`
(e.g., `2026-05-13T143022`) for human-driven memory writes, and
`cavemem-session-<id>` (e.g., `cavemem-session-1234`) for synthesizer-generated
memory writes — `<id>` is cavemem's SQLite auto-increment session identifier
and provides traceability back to the source observations. Use the
`{session-timestamp}` shape when an agent or human authors the memory directly;
use the `cavemem-session-<id>` shape when the downstream
vault-synthesizer-agent generates the memory from cavemem observations.

```markdown
---
tags:
  - memory
  - {project-name}
  - {3-5 specific topic tags}
date: YYYY-MM-DD
project: {project-name}
sessions:
  - {session-timestamp}     # or: cavemem-session-<id>
---

# {Concise statement of the fact, decision, or pattern}

## Context
{Where and why this was discovered}

## Details
{The actual knowledge being preserved}

## Related files
- {file paths if applicable}
```
<!-- END: memory-criteria -->

## Obsidian Tool Reference

You MUST use ONLY these tools for all vault operations. Do NOT use Bash, Write,
Read, or any other tool to interact with the Obsidian vault.

| Operation | Tool |
|---|---|
| Create or update a note | `hub_obsidian__write-note` |
| Read a note | `hub_obsidian__read-note` |
| Search by content | `hub_obsidian__search-vault` |
| Search by tags | `hub_obsidian__search-by-tags` |
| List notes in a directory | `hub_obsidian__list-notes` |
| Get note metadata | `hub_obsidian__get-note-metadata` |

All note paths MUST end with `.md`. Directories are created implicitly by
the Obsidian MCP server when writing notes.

## Tag Guidelines

All tags MUST be:
- Lowercase
- Single words or hyphenated (e.g., `nix-darwin`, `home-manager`)
- 3-7 tags per note (not too few to be useless, not too many to be noise)

Always include:
- The note type (`memory`, `transcription`, or `summary`)
- The project name
- 2-5 topical tags describing the subject matter


# Commit messages

When writing a git or Graphite commit message:

- **Be concise.** Keep subjects short and bodies tight. Don't restate
  obvious context. If a change can be explained in one line, write one line.
- **Use Conventional Commits style for titles and bodies.** Subjects begin
  with a type (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`,
  `perf`, etc.), an optional scope in parens, and an imperative-mood
  summary in lowercase (e.g. `feat(zellij): pin to 0.44.1`). Bodies, when
  needed, expand on the rationale in full sentences and wrap at ~72
  columns.
- **Focus on why, not what.** The diff already shows what changed; the
  message should explain why — the motivating bug, the preceding decision,
  the user-visible outcome, the constraint that forced the choice. Don't
  paraphrase the diff in prose.

Applies equally to plain `git commit` and to `gt create` / `gt modify` on
Graphite stacks.
