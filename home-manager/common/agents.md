# MANDATORY: Memory System (Obsidian + Cavemem)

All sessions MUST use BOTH Obsidian vault + cavemem for persistent memory.
Obsidian = curated agent-authored memories. Cavemem = ambient transcripts /
summaries via opencode hooks. Non-negotiable.

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

Transcription + session summarization are NOT agent tasks. Cavemem captures
every prompt, response, and tool call via opencode hooks → local SQLite
(`home.cavemem.dataDir`). Cavemem also tracks session lifecycle: no manual
transcription notes, no daily session lookup, no "continue or fresh?" prompt.

Agents MUST NOT write transcription or summary notes to Obsidian. Legacy
`conversations/transcriptions/` and `conversations/summaries/` hold archived
history only, not live capture.

Ad hoc observation retrieval — use `hub_cavemem__` MCP tools:

- `hub_cavemem__list_sessions` — recent sessions
- `hub_cavemem__timeline` — chronological observation stream for a session
- `hub_cavemem__get_observations` — full bodies by ID
- `hub_cavemem__search` — full-text + semantic over all observations

Same surface available as `cavemem search` for human lookups outside agent
sessions.

Curated memory creation = explicit agent-driven act, governed by "Memories"
below.

## Memory Recall

After session init, and whenever a question / problem / topic may have been
addressed before, search memories BEFORE using other research tools (web
fetches, codebase exploration, task agents).

### At session start

Search for memories tied to the current project:

1. `hub_obsidian__search-by-tags` with the project name tag, `directory`
   `"memories"`.
2. Review returned memories to prime context with prior decisions, patterns,
   discoveries.

### During the session

When a task involves any of:

- Understanding codebase mechanics
- Architecture / tooling / pattern decisions
- Debugging or root-cause diagnosis
- Answering questions about prior work or decisions
- Researching libraries / tools / integrations possibly evaluated before

→ Search memories FIRST:

1. `hub_obsidian__search-vault` with keywords, `path` `"memories/"`.
2. `hub_obsidian__search-by-tags` with topic tags, `directory` `"memories"`.
3. Read matches with `hub_obsidian__read-note`.
4. Complete answer in memory → use it; do NOT re-research.
5. Partial context → use as starting point, supplement as needed.
6. No matches → normal research.

Do NOT search memories for:

- Trivial ops (file reads, formatting, builds)
- Tasks fully covered by the current conversation context
- Mechanical ops (code formatting, test execution)

<!-- BEGIN: memory-criteria -->
## Memories

Memories = standalone knowledge notes persisting facts, decisions, and
patterns for future-session retrieval. Highest-value output of the memory
system.

- **Path:** `memories/{date}-{slug}.md` (slug 3-5 words, kebab-case)
- **Tool:** `hub_obsidian__write-note`

### When to create a memory

Create when ANY occur:

- Decision made (chose X over Y, with rationale)
- Non-obvious fact discovered (library X breaks with Y)
- Reusable pattern established (this codebase does X for Y)
- Bug root cause identified
- Configuration or architecture explained in depth

Do NOT create for:

- Routine edits with no novel insight
- Easily re-searchable lookups
- Temporary info (build output, test results)
- Info already in an existing memory

### Deduplication

BEFORE creating, ALWAYS check for related memories:

1. `hub_obsidian__search-by-tags` with the primary topic tags you intend to
   use, `directory` `"memories"`.
2. `hub_obsidian__search-vault` with key terms from the title, `path`
   `"memories/"`.
3. Substantially similar memory exists → UPDATE it: read with
   `hub_obsidian__read-note`, write updated content back to the same path
   with `hub_obsidian__write-note`. Add the current session to its context;
   refine content.
4. Create new only if no existing memory covers the same ground.

### Memory note format

Frontmatter `sessions:` accepts two shapes:

- `{session-timestamp}` (e.g. `2026-05-13T143022`) — human / agent-authored
  memory writes (an agent or human authors the memory directly).
- `cavemem-session-<id>` (e.g. `cavemem-session-1234`) —
  synthesizer-generated, written by the vault-synthesizer-agent from
  cavemem observations. `<id>` is cavemem's SQLite auto-increment session
  identifier and provides traceability back to source observations.

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

You MUST use ONLY these tools for vault operations. Do NOT use Bash, Write,
Read, or any other tool against the Obsidian vault.

| Operation | Tool |
|---|---|
| Create or update a note | `hub_obsidian__write-note` |
| Read a note | `hub_obsidian__read-note` |
| Search by content | `hub_obsidian__search-vault` |
| Search by tags | `hub_obsidian__search-by-tags` |
| List notes in a directory | `hub_obsidian__list-notes` |
| Get note metadata | `hub_obsidian__get-note-metadata` |

All note paths MUST end with `.md`. Directories are created implicitly by the
Obsidian MCP server on write.

## Tag Guidelines

All tags MUST be:

- Lowercase
- Single words or hyphenated (e.g. `nix-darwin`, `home-manager`)
- 3-7 per note (too few = useless, too many = noise)

Always include:

- Note type (`memory`, `transcription`, or `summary`)
- Project name
- 2-5 topical tags describing the subject matter


# Commit messages

When writing a git or Graphite commit message:

- **Be concise.** Short subjects, tight bodies. Don't restate obvious
  context. One-line change → one-line message.
- **Use Conventional Commits style for titles and bodies.** Subject = type
  (`feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `ci`, `perf`, etc.)
  + optional `(scope)` + imperative-mood lowercase summary. E.g.
  `feat(zellij): pin to 0.44.1`. Bodies (when needed) wrap at ~72 columns,
  full sentences.
- **Focus on why, not what.** The diff already shows what changed; the
  message explains why — the motivating bug, the preceding decision, the
  user-visible outcome, the constraint that forced the choice. Don't
  paraphrase the diff in prose.

Applies equally to plain `git commit` and to `gt create` / `gt modify` on
Graphite stacks.
