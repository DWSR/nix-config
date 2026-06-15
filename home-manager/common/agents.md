# MANDATORY: Memory System (Obsidian + Cavemem)

All sessions MUST use BOTH Obsidian vault + cavemem for persistent memory.
Obsidian = curated agent-authored memories. Cavemem = ambient transcripts /
summaries via opencode hooks. Non-negotiable.

Both servers are reached through mcpproxy's four-tool agent surface:
`retrieve_tools`, `call_tool_read`, `call_tool_write`, and
`call_tool_destructive`. Direct `hub_<server>__<tool>` invocation is not
available; every operation is a two-step idiom — discover the tool name with
`retrieve_tools`, then invoke it through the appropriate `call_tool_*`
verb based on the operation's side-effect class (read / write / destructive).

`retrieve_tools` accepts optional filter parameters (`read_only_only`,
`exclude_destructive`, `exclude_open_world`) intended for self-restricting
discovery scope. DO NOT pass any of these on the calls described in this
document. The obsidian and cavemem upstream servers do not ship MCP tool
annotations, so any of those filters strips their results to zero and the
Startup Check below would incorrectly fall through to the "mcpproxy
unreachable" branch. Pass only `query` (and optionally `limit`) on every
`retrieve_tools` call described here, regardless of which model is driving
the session.

## Startup Check

BEFORE responding to any user message, you MUST verify that BOTH MCP servers
are available via mcpproxy by performing the following four calls (one
`retrieve_tools` + one `call_tool_read` pair per server):

1. `retrieve_tools(query: "obsidian list-notes")`
   → expect a result whose `name` field has the form `obsidian:<tool>`
   (e.g. `obsidian:list-notes`).
2. `call_tool_read(name: <name returned in step 1>,`
   `                args: { directory: "memories", limit: 1 })`.
3. `retrieve_tools(query: "cavemem list sessions")`
   → expect a result whose `name` field has the form `cavemem:<tool>`
   (e.g. `cavemem:list_sessions`).
4. `call_tool_read(name: <name returned in step 3>,`
   `                args: { limit: 1 })`.

If ANY of those four calls FAILS, or if `retrieve_tools` returns no tool
from the expected upstream server, or if mcpproxy itself is unreachable:

1. **First, sanity-check the call shape.** If the failing `retrieve_tools`
   call passed `read_only_only`, `exclude_destructive`, or
   `exclude_open_world`, retry it with just `query` (and optionally
   `limit`) — those filters strip obsidian and cavemem results to zero
   because their upstream servers ship no MCP tool annotations. If the
   unfiltered retry returns the expected `<server>:<tool>` result, the
   original empty response was a filter false-positive: proceed normally
   from that point and skip steps 2-4 below.
2. **Otherwise**, tell the user: "mcpproxy is unreachable, or the
   obsidian/cavemem upstream servers are not registered with it. I cannot
   create curated memories or rely on ambient session capture. Verify the
   mcpproxy daemon is running (launchd label
   `com.smart-mcp-proxy.mcpproxy`) and that both the obsidian and cavemem
   upstream servers appear in its rendered config, then retry."
3. DO NOT proceed with any work.
4. DO NOT attempt workarounds such as writing to local files or skipping
   either system.

## Ambient capture (cavemem)

Transcription + session summarization are NOT agent tasks. Cavemem captures
every prompt, response, and tool call via opencode hooks → local SQLite
(`home.cavemem.dataDir`). Cavemem also tracks session lifecycle: no manual
transcription notes, no daily session lookup, no "continue or fresh?" prompt.

Agents MUST NOT write transcription or summary notes to Obsidian. Legacy
`conversations/transcriptions/` and `conversations/summaries/` hold archived
history only, not live capture.

Ad hoc observation retrieval — the cavemem upstream server exposes
recent-session listing, per-session timeline, full observation bodies by
ID, and full-text + semantic search across all observations. Invoke any
of those via the discover-then-invoke idiom against mcpproxy:

```
1. retrieve_tools(query: "cavemem search")
   → expect a result whose `name` field has the form `cavemem:<tool>`
     (e.g. `cavemem:search`).
2. call_tool_read(name: <name returned in step 1>,
                  args: { query: "<search terms>" })
```

Substitute the appropriate query keywords (`list sessions`, `timeline`,
`get observations`, `search`) and `args` payloads for the operation you need.
All cavemem operations are read-only, so they always go through
`call_tool_read`. The `args` field of `call_tool_read` is a JSON object
(not the raw upstream tool's kwargs flattened in line) — mcpproxy unpacks
it before forwarding the call to the upstream server.

The same surface is available as `cavemem search` for human lookups outside
agent sessions.

Curated memory creation = explicit agent-driven act, governed by "Memories"
below.

## Memory Recall

After session init, and whenever a question / problem / topic may have been
addressed before, search memories BEFORE using other research tools (web
fetches, codebase exploration, task agents).

All Obsidian vault operations go through mcpproxy via the discover-then-invoke
idiom. Read-side vault tools (search by tags, search vault content, read a
note, list notes, get note metadata) are invoked through `call_tool_read`
after a `retrieve_tools` discovery; write operations (`call_tool_write`) are
covered under "Memories" below.

### At session start

Search for memories tied to the current project:

1. Discover the tag-search tool:
   `retrieve_tools(query: "obsidian search by tags")`
   → expect a result whose `name` field has the form `obsidian:<tool>`
   (e.g. `obsidian:search-by-tags`).
2. Invoke it:
   `call_tool_read(name: <name returned in step 1>,`
   `                args: { tags: ["<project-name>"], directory: "memories" })`.
3. Review returned memories to prime context with prior decisions, patterns,
   discoveries.

### During the session

When a task involves any of:

- Understanding codebase mechanics
- Architecture / tooling / pattern decisions
- Debugging or root-cause diagnosis
- Answering questions about prior work or decisions
- Researching libraries / tools / integrations possibly evaluated before

→ Search memories FIRST. For each search, run the two-step idiom (discover
the tool with `retrieve_tools`, then invoke it through `call_tool_read`):

1. Vault-content keyword search — `retrieve_tools(query: "obsidian search vault")`
   then invoke with `args: { query: "<keywords>", path: "memories/" }`.
2. Tag search — `retrieve_tools(query: "obsidian search by tags")` then invoke
   with `args: { tags: [<topic tags>], directory: "memories" }`.
3. Read matches — `retrieve_tools(query: "obsidian read note")` then invoke
   with `args: { path: "<note path>" }` for each match worth reading.
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
- **Invocation:** create or update via `call_tool_write` against the
  obsidian write-note tool (discovered through `retrieve_tools`). See
  "Obsidian Tool Reference" below for the canonical worked example.

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

BEFORE creating, ALWAYS check for related memories (each step is a
`retrieve_tools` discovery followed by a `call_tool_read` invocation):

1. Tag search — discover via `retrieve_tools(query: "obsidian search by tags")`,
   then invoke with `{ tags: [<primary topic tags you intend to use>], directory: "memories" }`.
2. Vault-content search — discover via `retrieve_tools(query: "obsidian search vault")`,
   then invoke with `{ query: "<key terms from the title>", path: "memories/" }`.
3. Substantially similar memory exists → UPDATE it: read via
   `retrieve_tools(query: "obsidian read note")` + `call_tool_read` with
   `{ path: "<existing path>" }`, then write the updated content back to the
   same path via `retrieve_tools(query: "obsidian write note")` +
   `call_tool_write` with `{ path: "<existing path>", content: "<merged body>" }`.
   Add the current session to its context; refine content.
4. Create new only if no existing memory covers the same ground — same
   `call_tool_write` invocation against the write-note tool, at a fresh
   `memories/{date}-{slug}.md` path.

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

You MUST use ONLY mcpproxy's four-tool agent surface for vault operations.
Do NOT use Bash, Write, Read, or any other local tool against the Obsidian
vault.

The procedure for every vault operation is uniform:

1. **Discover** the tool with `retrieve_tools(query: "<short description>")`.
   The query string should name the upstream server (`obsidian`) and the
   operation (`search by tags`, `read note`, `write note`, etc.). Each
   result's `name` field is the canonical upstream tool name in the
   `server:tool` form (e.g. `obsidian:write-note`); the `call_with` field
   recommends which `call_tool_*` variant to use based on the tool's
   side-effect class.
2. **Invoke** the returned tool with the appropriate verb based on its
   side-effect class:
   - `call_tool_read` for any non-mutating operation (search by tags,
     search vault content, read a note, list notes in a directory, get
     note metadata).
   - `call_tool_write` for any mutation that creates, updates, or otherwise
     modifies vault content (writing a note).
   - `call_tool_destructive` for any irreversible removal (deleting a
     note).

Every `call_tool_*` invocation takes:
- `name`: the upstream tool name in `server:tool` form, exactly as
  returned by `retrieve_tools` (do NOT guess or invent it).
- `args`: a JSON object holding the upstream tool's parameters
  (NOT the legacy `arguments` field name).

Worked example — writing or updating a note:

```
1. retrieve_tools(query: "obsidian write note")
   → result includes `{ "name": "obsidian:write-note", "call_with": "call_tool_write", ... }`
2. call_tool_write(name: "obsidian:write-note",
                   args: { path: "memories/2026-05-21-my-fact.md",
                           content: "<note body including frontmatter>" })
```

Worked example — reading a note:

```
1. retrieve_tools(query: "obsidian read note")
   → result includes `{ "name": "obsidian:read-note", "call_with": "call_tool_read", ... }`
2. call_tool_read(name: "obsidian:read-note",
                  args: { path: "memories/2026-05-21-my-fact.md" })
```

All note paths MUST end with `.md`. Directories are created implicitly by the
Obsidian upstream server on write.

## Tag Guidelines

All tags MUST be:

- Lowercase
- Single words or hyphenated (e.g. `nix-darwin`, `home-manager`)
- 3-7 per note (too few = useless, too many = noise)

Always include:

- Note type (`memory`, `transcription`, or `summary`)
- Project name
- 2-5 topical tags describing the subject matter


# Version control: prefer the git MCP over the `git` CLI

For git operations, use the `git-mcp` server (a base MCP upstream on every
host) through the discover-then-invoke idiom — `retrieve_tools(query: "git
status")`, `retrieve_tools(query: "git commit")`, etc., then `call_tool_read`
/ `call_tool_write` against the returned `git-mcp:<tool>` — rather than
shelling out to the `git` CLI via bash.

- The opencode sandbox denies the `git_config` group and `~/.config/git`, so
  config-dependent bash `git` (commit identity, GPG/SSH signing, `~/.gitconfig`
  `[include]` directives) fails inside the sandbox. `git-mcp` runs OUTSIDE the
  sandbox as a child of mcpproxy, with full git config — it is the working path
  for commits and any config-dependent operation.
- Pass an explicit absolute `path: "/abs/repo"` on EVERY git-mcp call
  (`git_status`, `git_add`, `git_commit`, `git_diff`, ...) rather than
  setting a session working directory. `git_set_working_dir` sets a SINGLE
  working dir on the git-mcp server, which is one child of the shared
  mcpproxy daemon — that dir is global across ALL concurrent opencode
  sessions, so another session can silently repoint it mid-task. No
  `GIT_BASE_DIR` default is configured, so there is no fallback repo anyway.
- A `git_commit` "File not found" for a file you know exists, or a
  `git_status` reporting a branch you never checked out, signals a hijacked
  session working dir — re-issue the call with an explicit `path`.
- Where Graphite (`gt`, via the `gt-mcp` server) is used for stacked PRs, gt
  remains the tool for that workflow and is likewise unaffected (it too runs
  outside the sandbox). Use `git-mcp` for plain, non-stacked git work.


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


# Time and dates: use the `time` MCP, not shell `date`

For the current time, today's date, or timezone conversions, use the
`time` MCP server (a base upstream on every host) through the
discover-then-invoke idiom — `retrieve_tools(query: "get current time")`,
then `call_tool_read` against the returned `time:<tool>`. Both tools are
read-only. Do NOT shell out to `date`.

- **Current date / time:** `time:get_current_time` with
  `args: { timezone: "<IANA name>" }` (local default: `America/Toronto`).
  Use this whenever you need today's date or the wall-clock time — e.g.
  the `{date}` in a `memories/{date}-{slug}.md` path or a memory's
  `date:` / `sessions:` frontmatter. Do not guess the date or derive it
  from unrelated artifacts (commit timestamps, file mtimes, the training
  cutoff).
- **Timezone conversion:** `time:convert_time` with
  `args: { source_timezone: "<IANA>", time: "HH:MM", target_timezone: "<IANA>" }`
  (24-hour clock, IANA zone names).
- The opencode sandbox denies `/bin/date` (macOS's only `date`; no
  coreutils on PATH), so bash `date` fails inside the sandbox. The `time`
  MCP runs OUTSIDE the sandbox as a child of mcpproxy — it is the working
  path for any clock or date read.
