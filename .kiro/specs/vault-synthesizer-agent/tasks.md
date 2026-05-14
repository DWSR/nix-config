# Implementation Plan

- [ ] 1. Author the agent definition file
- [x] 1.1 Create the frontmatter and skeleton sections
  - Create `home-manager/common/agents/vault-synthesizer.md` with a YAML
    frontmatter block whose top-level keys are exactly: `description`,
    `mode`, `model`, `temperature`, `permission` (in that order, matching
    `vault-curator.md`).
  - Set `description` to a one-line natural-language summary that names
    cavemem, names the time-range argument, names the
    `@vault-synthesizer` invocation alias, and includes delegation
    phrases like "synthesize my recent sessions" / "draft memories from
    cavemem" so opencode's task router picks it up.
  - Set `mode: subagent`, `model: anthropic/claude-sonnet-4-5`,
    `temperature: 0.2`. Do not declare `top_p`, `max_tokens`, or any
    `options.thinking` block.
  - Populate the `permission` block: `edit: deny`, `write: deny`,
    `webfetch: deny`, and a `bash` table with wildcard `"*": ask` plus
    explicit `allow` entries only for `ls *`, `find *`, `rg *`,
    `grep *`, `wc *`, `head *`, `tail *`. Include no other bash entries.
  - Add the H1 (`# vault-synthesizer`) and section stubs in this order:
    `## Mission`, `## Operating rules (INVARIANTS)`,
    `## Memory criteria (inlined verbatim from agents.md)`,
    `## Selectivity rubric`, `## Workflow`,
    `## Drafted memory note format`, `## Invocation`, `## Report`,
    `## Tool usage notes`, `## Success criteria`, `## Vault references`.
  - Observable: the file exists at the documented path; `yq -r .mode
    home-manager/common/agents/vault-synthesizer.md` (or equivalent
    parser) returns `subagent`; the eleven section headings are
    discoverable via `rg '^## '` against the file in exactly that order.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_
  - _Boundary: AgentDefinitionFile_

- [x] 1.2 Author the Mission and Operating-rules sections
  - Mission paragraph: one paragraph naming the synthesizer's job
    (promote high-signal cavemem observations into curated Obsidian
    memory notes), naming its place in the pipeline (synthesizer drafts;
    curator dedups; downstream `memory-sync-cli` orchestrates), and
    naming its invocation surface (`@vault-synthesizer <time-range>`).
  - Operating rules: numbered list mirroring vault-curator's structure,
    with at least the following items: (a) vault-writes only through
    `hub_obsidian__*` MCP tools; (b) repo source is strictly out of
    scope; (c) `webfetch` denied; (d) NEVER dedup against existing
    memories — that's curator's job in the next pipeline stage; (e)
    every drafted memory note must include the cavemem `session_id(s)`
    in its `sessions:` frontmatter list for provenance; (f) the agent
    must NOT call `hub_obsidian__search-vault` or
    `hub_obsidian__search-by-tags`; (g) the agent must NOT call any
    MCP tool outside the documented allow-list (no
    `hub_github__*`, no `hub_observe_*`, no `hub_buildkite__*`,
    no `hub_*` web fetch); (h) defense-in-depth — the OS-level
    `edit`/`write` denies are redundant with the prompt rule.
  - Observable: `rg -c '^[0-9]+\.' home-manager/common/agents/vault-synthesizer.md`
    inside the Operating-rules section returns at least 8;
    `rg 'NEVER dedup' home-manager/common/agents/vault-synthesizer.md`
    returns one match.
  - _Requirements: 3.5, 4.4, 7.7_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.1_

- [x] 1.3 Inline the AGENTS.md memory criteria block verbatim
  - Read the memory-criteria block from `home-manager/common/agents.md`,
    bounded by the `<!-- BEGIN: memory-criteria -->` and
    `<!-- END: memory-criteria -->` anchor markers (introduced by
    `cavemem-integration`). The block contains the "create a memory
    when" list and the "do NOT create" list.
  - Paste the block verbatim into the
    `## Memory criteria (inlined verbatim from agents.md)` section,
    preserving both anchor-marker comments inside the inlined copy so
    a future maintainer can `rg 'BEGIN: memory-criteria'` against the
    agent file and confirm provenance.
  - Add a one-line preamble above the inlined block stating: "Inlined
    verbatim from `home-manager/common/agents.md`. The agent applies
    this rubric to every observation cluster; clusters that fall into
    any 'do NOT create' bucket are skipped silently per the workflow."
  - Observable: `diff -u <(sed -n '/<!-- BEGIN: memory-criteria -->/,/<!-- END: memory-criteria -->/p' home-manager/common/agents.md) <(sed -n '/<!-- BEGIN: memory-criteria -->/,/<!-- END: memory-criteria -->/p' home-manager/common/agents/vault-synthesizer.md)`
    returns zero output (byte-for-byte match).
  - _Requirements: 5.1, 5.2, 5.3, 5.4_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.1_

- [x] 1.4 Author the Selectivity rubric with concrete examples
  - In `## Selectivity rubric`, state the conservative principle:
    "Err on the side of NOT promoting when signal is unclear. False
    positives pollute the vault; false negatives can be re-synthesized
    from the same cavemem range later."
  - Add a "Promote — examples" subsection with at least three concrete
    examples. Each example shows a plausible cavemem observation
    cluster (1-3 sentence sketch) and the resulting memory-note
    title and which AGENTS.md criterion fires (decision /
    non-obvious fact / reusable pattern / bug root cause /
    config-or-architecture-explained-in-depth). Use clusters drawn
    from this repo's actual tag space (`nix-config`, `graphite`,
    `cavemem`, `yugabytedb`, `nixvim`, `obsidian-mcp`, etc.).
  - Add a "Skip — examples" subsection with at least three concrete
    examples covering, at minimum: (a) a routine file-read cluster
    (`hub_obsidian__read-note` followed by editing — bookkeeping, no
    novel insight); (b) a build/test output cluster (`nix flake check`
    output, no decision documented); (c) a cluster that restates
    information already in an existing curated memory (skip because
    the signal is unclear, not because the agent did dedup).
  - Each example explicitly references the AGENTS.md criterion it
    invokes (or, for skips, the "do NOT create" rule it falls under).
  - Observable: `rg '^### Promote' home-manager/common/agents/vault-synthesizer.md`
    returns one match; `rg '^### Skip' home-manager/common/agents/vault-synthesizer.md`
    returns one match; the file contains at least three promote and
    three skip examples (count by `rg '^- ' ...` inside each
    subsection).
  - _Requirements: 6.1, 6.2, 6.3, 6.4_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.3_

- [x] 1.5 Author the Workflow section (five stages)
  - In `## Workflow`, define exactly five stages in order: gather,
    group, score, draft, report. Use H3 subsection headings for each
    (`### Stage 1 — gather`, etc.).
  - Gather stage prose: resolve the time range per the `## Invocation`
    section; call `hub_cavemem__list_sessions(start, end)` to enumerate
    sessions; for each session, call `hub_cavemem__timeline(session_id)`
    to enumerate observation IDs.
  - Group stage prose: cluster observations by session and topic,
    using cavemem's observation `kind` field plus content keywords as
    the clustering signal; call `hub_cavemem__search(query)` for
    disambiguation when keyword overlap is ambiguous; produce a list
    of cluster descriptors (session IDs + observation IDs + suggested
    cluster topic).
  - Score stage prose: apply the Selectivity rubric (Section above) to
    each cluster; high-signal clusters become promotion candidates,
    low-signal clusters are skipped silently and counted in the
    structured return's `clusters_skipped` field.
  - Draft stage prose: for each promotion candidate, call
    `hub_cavemem__get_observations(ids)` to fetch full observation
    bodies; compose a memory note conforming to the "Drafted memory
    note format" section; write via
    `hub_obsidian__write-note(memories/<YYYY-MM-DD>-<slug>.md, ...)`;
    optionally read back via `hub_obsidian__read-note` for a
    format spot-check.
  - Report stage prose: emit the structured summary defined in the
    `## Report` section.
  - Add an explicit "Non-stage" call-out: "The agent does NOT call
    `hub_obsidian__search-vault` or `hub_obsidian__search-by-tags` to
    check whether a similar memory already exists. Deduplication is
    `vault-curator`'s responsibility in the next pipeline stage."
  - Observable: `rg '^### Stage [1-5] —' home-manager/common/agents/vault-synthesizer.md`
    returns exactly five matches in numeric order;
    `rg 'hub_cavemem__list_sessions' home-manager/common/agents/vault-synthesizer.md`
    returns one match in the gather stage.
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.4_

- [x] 1.6 Author the Drafted memory note format section with a worked example
  - In `## Drafted memory note format`, restate the path convention:
    `memories/<YYYY-MM-DD>-<slug>.md` where `<YYYY-MM-DD>` is the date
    of the earliest observation in the cluster and `<slug>` is 3-5
    words in kebab-case derived from the H1 statement.
  - State the frontmatter shape: keys `tags`, `date`, `project`,
    `sessions` in that order. `tags` includes `memory`, the project
    tag, and 1-5 topical tags drawn from the cluster (total tag count
    between 3 and 7 per AGENTS.md tag guidelines). `sessions` lists
    the cavemem session ID(s) the cluster came from in
    `cavemem-session-<id>` form.
  - State the body section order: H1 with the concise fact / decision /
    pattern, `## Context`, `## Details`, `## Related files`. State
    that body sections beyond these four shall not be added (so
    curator's audit treats every drafted note identically).
  - Add a worked example (~30-50 lines): a complete drafted memory
    note with realistic frontmatter, H1, and body for a plausible
    cluster (e.g., a "decided to use buildNpmPackage for the cavemem
    importer instead of fetchNpmDeps because…" cluster). The example
    shows session IDs in `sessions:`, three or four tags, and all four
    body sections populated with realistic content.
  - State explicitly: the frontmatter `date` value shall not precede
    the earliest cavemem observation timestamp in the cluster.
  - Observable: `rg '^## Drafted memory note format'
    home-manager/common/agents/vault-synthesizer.md` returns one
    match; the section contains a fenced ```` ```markdown ```` code
    block with a complete frontmatter (4 keys, in order) and four
    body H2 sections in order.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.5_

- [x] 1.7 Author the Invocation contract section
  - In `## Invocation`, document the four accepted argument shapes
    plus the missing-argument default behavior. The four shapes are:
    (a) relative — `"last N days"`, `"last N hours"`, `"N days"`,
    `"N hours"`; (b) absolute date pair — `"YYYY-MM-DD to YYYY-MM-DD"`
    in local TZ, inclusive bounds; (c) ISO-8601 duration — `"P7D"`,
    `"PT24H"` anchored to "now"; (d) ISO-8601 timestamp pair —
    `"<start> to <end>"` where each side is `YYYY-MM-DDTHH:MM:SSZ`
    (RFC 3339 UTC, trailing `Z` mandatory), e.g.,
    `"2026-05-01T00:00:00Z to 2026-05-13T22:30:00Z"`. Call out
    explicitly that shape (d) is the format `memory-sync-cli` emits
    when it composes the synthesizer prompt from its marker file
    (per `memory-sync-cli` Decision 4 / Req 6.AC1) — without
    accepting it the first end-to-end memory-sync run would fail.
    Missing argument defaults to last 24 hours.
  - State that timezones are handled per shape: relative shapes are
    anchored to "now" in the host's local TZ; absolute date pairs
    are interpreted in local TZ when no timezone is provided;
    ISO-8601 durations are anchored to "now" in local TZ; ISO-8601
    timestamp pairs are interpreted as UTC instants (the trailing
    `Z` is mandatory; pairs without it are rejected as unparseable).
  - State the unparseable-input behavior: refuse the run, print an
    actionable error message naming all four accepted shapes with
    one example each, and produce no drafts. The structured return
    is omitted in the refusal case (the refusal message replaces it).
  - State the empty-window behavior (cavemem reports zero sessions):
    the agent still emits a structured return with zero counts for
    every counter and an empty `draft_paths` list. No drafts.
  - Add a small table summarizing the four shapes with one example
    each so the agent has a concrete reference at runtime.
  - Observable: `rg '^## Invocation' home-manager/common/agents/vault-synthesizer.md`
    returns one match; the section enumerates all four shapes
    (search for `relative`, `absolute`, `ISO-8601 duration`,
    `ISO-8601 timestamp pair` in the section body) and documents
    the missing-arg default, the unparseable-input failure mode,
    and the empty-window behavior. `rg 'YYYY-MM-DDTHH:MM:SSZ'
    home-manager/common/agents/vault-synthesizer.md` returns at
    least one match (the timestamp-pair shape spec).
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.5_

- [ ] 1.8 Author the Report (structured-return) section
  - In `## Report`, document the structured-return shape the agent
    emits at the end of every successful run (every shape except the
    unparseable-input refusal). Specify the seven required fields:
    `time_range` (resolved start + end timestamps, ISO-8601, local
    TZ); `observations_scanned`; `clusters_identified`;
    `clusters_promoted`; `clusters_skipped`; `drafts_written`;
    `draft_paths` (list of vault-relative `memories/...` paths).
  - Provide a fenced code-block example showing the rendered shape
    the agent produces (Markdown bullets or JSON-ish — pick one and
    use it consistently). The example should make it obvious to the
    downstream `memory-sync-cli` orchestrator how to extract each
    field.
  - State explicitly: `clusters_promoted + clusters_skipped =
    clusters_identified` is an invariant the agent enforces in its
    own counts.
  - State explicitly: when individual `hub_obsidian__write-note`
    calls fail mid-draft, the agent records the failed cluster's
    skip-reason in a per-cluster note inside the structured return
    (the failed draft path is omitted from `draft_paths`) and
    continues with remaining clusters.
  - Observable: `rg '^## Report' home-manager/common/agents/vault-synthesizer.md`
    returns one match; the section names all seven required fields
    (search for each field name once); the section contains one
    fenced code-block example.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.5_

- [ ] 1.9 Author the Tool usage notes section
  - In `## Tool usage notes`, list the six MCP tools the agent uses,
    with one bullet per tool naming the tool and its role:
    `hub_cavemem__list_sessions` (gather: enumerate sessions in time
    window); `hub_cavemem__timeline` (gather: enumerate observation
    IDs per session); `hub_cavemem__get_observations` (draft: fetch
    full observation bodies for promotion candidates);
    `hub_cavemem__search` (group: disambiguate when cluster keyword
    overlap is unclear); `hub_obsidian__write-note` (draft: write
    memory drafts into the vault); `hub_obsidian__read-note` (draft:
    optional read-back format spot-check; never used for dedup).
  - State the bash allow-list (`ls`, `find`, `rg`, `grep`, `wc`,
    `head`, `tail`) and that no `cat` is allowed (use
    `hub_obsidian__read-note` to read note contents).
  - Inline the Obsidian MCP quirk notes from `vault-curator.md`
    verbatim or near-verbatim (the four bullet points covering:
    `search-vault includeContext: true` schema-validation flake;
    `list-notes` returning a count header but empty array;
    `write-note` creating directories implicitly; `read-note` taking
    vault-relative paths).
  - State the negative assertions explicitly: no `hub_github__*`,
    no `hub_observe_*`, no `hub_buildkite__*`, no web-fetch MCP
    tools, no other tools beyond the six named above.
  - Observable: `rg 'hub_cavemem__' home-manager/common/agents/vault-synthesizer.md`
    returns at least four matches (one per cavemem tool);
    `rg 'hub_obsidian__' home-manager/common/agents/vault-synthesizer.md`
    returns at least two matches; `rg 'no hub_github__|no hub_observe_|no hub_buildkite__'
    home-manager/common/agents/vault-synthesizer.md` returns at
    least one match.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.5_

- [ ] 1.10 Author the Success criteria section with the manual smoke-test recipe
  - In `## Success criteria`, document the manual smoke-test recipe
    the implementer (and any future operator validating the agent
    after a cavemem version bump) runs to confirm end-to-end
    behavior.
  - The recipe instructs the operator to run `@vault-synthesizer 24
    hours` against today's cavemem session.
  - List the three pass conditions: (a) at least one memory draft is
    produced; (b) the draft conforms to the format defined in the
    "Drafted memory note format" section above (such that
    vault-curator's audit accepts it unchanged); (c) no observation
    from a cavemem session whose `cwd` differs from the synthesis
    time-range's project context leaks into a draft (the
    cross-project privacy check; depends on the bug #39 patch from
    `cavemem-integration`).
  - State the recovery path when any pass condition fails: re-run
    `cavemem-smoke-test` (the regression detector shipped by
    `cavemem-integration`) before re-attempting the synthesizer
    run.
  - Observable: `rg '^## Success criteria'
    home-manager/common/agents/vault-synthesizer.md` returns one
    match; the section names `cavemem-smoke-test` (search returns
    one match); the three pass conditions are enumerated as a
    list.
  - _Requirements: 11.1, 11.2, 11.3, 11.4_
  - _Boundary: AgentDefinitionFile_
  - _Depends: 1.6_

- [ ] 2. Wire the agent into opencode's agents attrset
- [ ] 2.1 Add the vault-synthesizer entry in `home-manager/common/opencode.nix`
  - In the existing `agents = { ... }` block (currently lines 142-157
    of `home-manager/common/opencode.nix`), add a single new entry:
    `vault-synthesizer = withCaveman ./agents/vault-synthesizer.md;`.
  - Position the entry alphabetically — after the `vault-curator =
    withCaveman ./agents/vault-curator.md;` line.
  - Do not modify the surrounding file structure, the `withCaveman`
    helper definition, the `cavemanSnippet` binding, or any other
    agent entry.
  - Run `nix fmt` (treefmt-nix) after the edit.
  - Observable: `rg 'vault-synthesizer = withCaveman'
    home-manager/common/opencode.nix` returns exactly one match;
    `rg '^\s+(nix-pkg|nvim-tailor|security-auditor|vault-curator|vault-synthesizer) = '
    home-manager/common/opencode.nix` returns five matches in
    alphabetical order.
  - _Requirements: 1.5, 1.6, 1.7_
  - _Boundary: OpencodeAgentsWiring_
  - _Depends: 1.1_

- [ ] 3. Verify and validate
- [ ] 3.1 Build-level verification on each host
  - Run the host's rebuild command (e.g., `darwin-rebuild switch
    --flake .` for both `ShopifyLaptop` and `Brandons-MacBook-Pro`,
    or the equivalent `nix-darwin` workflow). Expect zero errors.
  - Verify the new agent is materialized into opencode's settings:
    after rebuild, `nix eval --raw '.#darwinConfigurations.ShopifyLaptop.config.home-manager.users.brandonmcnama.programs.opencode.settings.agents.vault-synthesizer'`
    (or the host-appropriate equivalent attr path) returns a
    non-empty string containing the agent file's body.
  - Verify the verbatim memory-criteria block matches the source:
    `diff -u <(sed -n '/<!-- BEGIN: memory-criteria -->/,/<!-- END: memory-criteria -->/p' home-manager/common/agents.md) <(sed -n '/<!-- BEGIN: memory-criteria -->/,/<!-- END: memory-criteria -->/p' home-manager/common/agents/vault-synthesizer.md)`
    returns zero output.
  - Observable: both `darwin-rebuild switch` invocations exit 0;
    the diff command produces no output; the agent body is
    discoverable via the `nix eval` of the opencode settings attr
    path.
  - _Requirements: 1.5, 1.6, 5.1, 5.3_
  - _Depends: 2.1_

- [ ] 3.2 Manual smoke test on at least one host
  - On the host where `cavemem-integration` has shipped (i.e., where
    `home.cavemem.enable = true` and the cavemem MCP is reachable),
    open an opencode session and invoke `@vault-synthesizer 24
    hours`.
  - Verify the three pass conditions from the agent body's "Success
    criteria" section:
    (a) at least one memory draft is produced (visible in the
    structured return's `draft_paths` list);
    (b) the draft conforms to the format in the "Drafted memory
    note format" section — open the draft via Obsidian and confirm
    frontmatter (4 keys in order) plus body sections (H1 + 3 H2
    sections in order);
    (c) no observation from a cavemem session whose `cwd` differs
    from the host's current cwd at synthesis time leaks into the
    draft (inspect the draft's `## Context` and `## Details` and
    confirm all referenced files are within the expected project
    boundary).
  - Additionally exercise the ISO 8601 timestamp pair shape
    (Requirement 10.7) by invoking
    `@vault-synthesizer 2026-05-13T00:00:00Z to 2026-05-14T00:00:00Z`
    (or any equivalent UTC instants spanning a day with cavemem
    activity). Verify the agent accepts the shape, resolves the
    bounds without a refusal, and reports them in the structured
    return's `time_range` field — i.e., the parser treats the
    timestamp pair the same as `memory-sync-cli` would in
    production.
  - If any condition fails, run `cavemem-smoke-test` (shipped by
    `cavemem-integration`) and follow the recovery path from the
    troubleshooting memory.
  - Observable: a verification log captures (a)/(b)/(c) outcomes
    with the rendered structured return and one example draft path;
    a separate log entry captures the ISO 8601 timestamp pair
    invocation and its accepted/refused outcome; both logs are
    attached to the integration PR description.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.4, 10.7, 11.1, 11.2, 11.3, 11.4_
  - _Depends: 3.1_

## Implementation Notes

- 2026-05-14 (task 1.6): Worked examples in the agent file MUST exemplify
  the rules they document — the LLM pattern-matches against the example
  at runtime. The first round of 1.6 used `buildNpmPackage` (camelCase)
  as a tag in the worked example, violating AGENTS.md tag guidelines
  even though the cluster's H1/Details prose correctly used the
  camelCase Nix function name. Reviewer caught it; remediated to
  `nix-derivations`. Apply this lens to every example block in tasks
  1.7-1.10 and 2.1: examples teach pattern, so they must be correct.
