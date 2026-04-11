# MANDATORY: Obsidian Memory System

All agent sessions MUST use the Obsidian vault for persistent memory, conversation
transcription, and session summaries. This is non-negotiable.

## Startup Check

BEFORE responding to any user message, you MUST call `hub_obsidian__list-notes`
with `directory` set to `"memories"` and `limit` set to `1`.

If this call FAILS or the `hub_obsidian__*` tools are not available:
1. Tell the user: "Obsidian MCP tools are unavailable. I cannot create memories
   or transcribe this conversation. Ensure mcphub is running with the obsidian
   server registered, then retry."
2. DO NOT proceed with any work.
3. DO NOT attempt workarounds such as writing to local files or skipping memory.

## Session Initialization

After the startup check passes, determine if this is a new or resumed session:

1. Determine the project name from the current working directory (use the git
   repo name or directory basename).
2. Call `hub_obsidian__search-vault` with query `title:<project-name>` and
   `path` set to `"conversations/transcriptions/"` to find transcription notes
   from today.
3. If a matching transcription note exists from today, read it to recover context.
   Ask the user: "Found an existing session from [time]. Continue it or start fresh?"
4. If continuing: append to the existing transcription and summary notes.
5. If new: generate a session timestamp as `YYYY-MM-DDTHHMMSS` and create the
   transcription and summary notes.

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

## Transcription

Maintain a verbatim log of every exchange in the session.

- **Path:** `conversations/transcriptions/{timestamp}-{project}.md`
- **Tool:** `hub_obsidian__write-note` (write the full note content each time)
- **When:** After EVERY assistant response, append the latest exchange to the note.
- **Do this silently.** Do not narrate transcription activity to the user unless
  they ask about it.

### Transcription note format

```markdown
---
tags:
  - transcription
  - {project-name}
  - {2-5 topic tags}
date: YYYY-MM-DD
project: {project-name}
session: {timestamp}
---

# Session: {project-name} ({date} {time})

## Exchange 1
**User:** {verbatim user message}

**Assistant:** {verbatim assistant response, excluding transcription tool calls}

## Exchange 2
...
```

## Session Summary

Maintain a compressed summary of the session, updated periodically.

- **Path:** `conversations/summaries/{timestamp}-{project}.md`
- **Tool:** `hub_obsidian__write-note`
- **When:** Update after every 3-5 exchanges, when a significant milestone is
  reached (decision made, task completed, problem solved), and always update at
  session end if the user says goodbye or the conversation winds down.

### Summary note format

```markdown
---
tags:
  - summary
  - {project-name}
  - {2-5 topic tags}
date: YYYY-MM-DD
project: {project-name}
session: {timestamp}
---

# Session Summary: {project-name} ({date} {time})

## What was accomplished
- {bullet list of completed work}

## Key decisions
- {choices made and their rationale}

## Discoveries
- {non-obvious facts or patterns learned}

## Open questions
- {unresolved items}

## Files touched
- {list of files modified or created}
```

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

```markdown
---
tags:
  - memory
  - {project-name}
  - {3-5 specific topic tags}
date: YYYY-MM-DD
project: {project-name}
sessions:
  - {session-timestamp}
---

# {Concise statement of the fact, decision, or pattern}

## Context
{Where and why this was discovered}

## Details
{The actual knowledge being preserved}

## Related files
- {file paths if applicable}
```

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
