# Requirements Document

## Introduction

`agentmemory-obsidian-migration` copies curated Obsidian memories into
AgentMemory and retires Obsidian as an agent dependency. See `brief.md` for the
problem, approach, and scope.

## Boundary Context

- **In scope**: Direct `memories/*.md` import, deterministic reruns, removal of
  the managed Obsidian MCP and preflights, AgentMemory-only prompt guidance, and
  retirement of the Obsidian-dependent agent pipeline.
- **Out of scope**: Other vault content, ongoing synchronization, semantic
  deduplication, rollback, source deletion, cross-host coordination, and
  Obsidian desktop application removal.
- **Adjacent expectations**: AgentMemory remains the active memory runtime and
  mcpproxy remains OpenCode's only MCP endpoint. Prior specs remain historical;
  this spec supersedes their live Obsidian requirements.

## Requirements

### Requirement 1: Bounded Source Selection

**Objective:** As the host operator, I want the importer restricted to curated
memory notes, so that unrelated vault content is not copied accidentally.

#### Acceptance Criteria

1. When the operator supplies a vault path, the importer shall discover regular
   Markdown files directly under `<vault>/memories`.
2. The importer shall not import nested notes, MOCs, archived conversations,
   attachments, or files outside `<vault>/memories`.
3. If a discovered entry is not a regular file or resolves outside
   `<vault>/memories`, the importer shall skip it and identify it in the result.
4. If the supplied vault path or `memories` directory is missing or unreadable,
   the importer shall exit non-zero before changing AgentMemory.
5. While an import or dry run executes, the importer shall not modify any source
   vault file.

### Requirement 2: Memory Content and Provenance Preservation

**Objective:** As the host operator, I want imported records to retain their
useful content and origin, so that AgentMemory recall remains understandable.

#### Acceptance Criteria

1. When a note is eligible, the importer shall preserve its title and Markdown
   body in the imported memory.
2. When a note contains valid `project`, `tags`, or `sessions` frontmatter, the
   importer shall preserve each value in the target record.
3. When a note has no usable heading, the importer shall derive a stable title
   from its vault-relative filename.
4. When a note is imported, the imported memory shall retain its normalized
   vault-relative source path.
5. The importer shall identify every imported record as originating from the
   Obsidian migration.
6. While importing note content, the importer shall preserve the curated body
   verbatim without credential redaction or private-marker filtering.
7. If a note has malformed frontmatter or cannot form a valid AgentMemory
   record, the importer shall skip it and report the reason.

### Requirement 3: One-Shot Import Operation

**Objective:** As the host operator, I want a simple manual migration command,
so that each local AgentMemory store can be populated before Obsidian is retired.

#### Acceptance Criteria

1. The managed importer command shall be available on both configured hosts.
2. When the operator requests a dry run, the importer shall validate and count
   source notes without changing AgentMemory.
3. When the operator starts a live import, the importer shall authenticate to
   the configured host-local AgentMemory service without printing its bearer.
4. When AgentMemory accepts an import unit, the importer shall count only the
   records confirmed successful by the response body as imported.
5. If one note is too large for an import unit, the importer shall report that
   note and continue with later independent notes.
6. If one import unit fails, the importer shall report the failure and continue
   with later independent units where possible.
7. When the run ends, the importer shall report discovered, eligible, imported,
   already-present, skipped, and failed counts.
8. If any eligible note fails to import, the importer shall exit non-zero after
   reporting the partial result.
9. When all eligible notes are imported or already present, the importer shall
   exit zero.
10. When a live import reports a note as imported, AgentMemory recall shall find
    that note by a distinctive title or body term while it remains indexed.
11. The migration shall not run automatically during Home Manager activation or
   OpenCode startup.

### Requirement 4: Deterministic Rerun Semantics

**Objective:** As the host operator, I want failed or repeated runs to be safe
to retry, so that no rollback workflow is required.

#### Acceptance Criteria

1. When the same vault-relative note path is processed again, the importer shall
   derive the same target identity.
2. When the target identity already exists, the importer shall leave the
   existing memory unchanged and count the note as already present.
3. When an interrupted run is repeated, the importer shall retry notes that do
   not already exist without creating duplicates for accepted notes.
4. If note content changes without a path change after its first import, a rerun
   shall not update or reconcile the existing target memory.
5. When an imported source note is renamed, the importer shall derive a new
   target identity without reconciling the prior path.
6. The importer shall not provide rollback, transactional undo, a durable
   journal, or automatic crash resume beyond rerunning the command.

### Requirement 5: Managed Obsidian MCP Retirement

**Objective:** As the host operator, I want Obsidian removed from the managed MCP
inventory, so that AgentMemory is the only agent memory service.

#### Acceptance Criteria

1. When either host renders its managed mcpproxy configuration, the
   configuration shall not register an Obsidian upstream.
2. When the updated generation activates, the running mcpproxy inventory shall
   not contain an Obsidian server.
3. The managed host configuration shall not install the Obsidian MCP package or
   require an Obsidian vault path for mcpproxy.
4. While Obsidian is absent, mcpproxy shall continue to expose the configured
   AgentMemory upstream and unrelated MCP servers.
5. The migration shall not remove source vault files or the Obsidian desktop
   application.

### Requirement 6: Startup Check Cutover

**Objective:** As an OpenCode or Pi user, I want startup checks to depend on the
active memory service, so that missing Obsidian cannot block a session.

#### Acceptance Criteria

1. When the OpenCode wrapper runs, it shall not probe or require an Obsidian MCP
   server.
2. When Pi startup or status checks run, they shall not probe or require an
   Obsidian MCP server.
3. While mcpproxy and AgentMemory are healthy and Obsidian is absent, OpenCode
   preflight shall succeed.
4. While Pi's remaining mandatory dependencies are healthy and Obsidian is
   absent, Pi startup and status checks shall succeed.
5. The OpenCode wrapper shall retain its mcpproxy and AgentMemory health checks.
6. If AgentMemory is unhealthy, the OpenCode wrapper shall continue to stop with
   an AgentMemory-specific recovery message.

### Requirement 7: AgentMemory-Only Prompt Contract

**Objective:** As an agent user, I want one memory workflow in active prompts,
so that agents no longer attempt unavailable Obsidian tools or vault writes.

#### Acceptance Criteria

1. When an active agent needs prior context, its instructions shall direct it to
   AgentMemory recall through mcpproxy.
2. When an active agent must save durable knowledge, its instructions shall
   direct it to the applicable AgentMemory save tool through mcpproxy.
3. The active global, Pi, common-subagent, Shopify-agent, skill, and injected
   instruction sources shall not require Obsidian discovery, recall, note reads,
   note writes, tags, MOCs, or vault paths.
4. The active prompt sources shall not instruct agents to create or update
   `memories/*.md` files.
5. When OpenCode renders its agent catalog, it shall not register the
   Obsidian-only vault curator or vault synthesizer.
6. The active host generation shall not expose the obsolete Obsidian-dependent
   memory-sync command.
7. The migration shall not add an AgentMemory-to-Obsidian promotion or another
   replacement vault pipeline.
