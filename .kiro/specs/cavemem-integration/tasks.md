# Implementation Plan

- [ ] 1. Foundation: vendored package and patch tree
- [x] 1.1 Create the three patch files in `overlays/`
  - Cherry-pick the bug #14 fix from upstream PR #31 (commit f2e2f49,
    opencode hook payload-shape correction) into
    `overlays/cavemem-14-hook-payload-shape.patch`.
  - Cherry-pick the bug #39 fix from upstream PR #21 (one-line cwd
    filter in session-start handler) into
    `overlays/cavemem-39-session-start-cwd-filter.patch`.
  - Cherry-pick the bug #25 fix from upstream PR #31 (Zod docstring on
    `search.alpha`) into `overlays/cavemem-25-search-alpha-doc.patch`.
  - Each `.patch` file's leading comment block names the upstream bug
    ID and the source PR or commit it cherry-picks from.
  - Observable: three `.patch` files exist under `overlays/`, each
    applies cleanly with `patch -p1` against the v0.2.1 source tree.
  - _Requirements: 1.3, 1.4_

- [x] 1.2 Add the cavemem package to `overlays/mcp-servers.nix`
  - Use `buildNpmPackage` against `JuliusBrussee/cavemem` at tag
    `v0.2.1` (or the equivalent rev), with `npmDeps` produced by
    `importNpmLock` against the cavemem source's package-lock.
  - Apply `patches = [ ./cavemem-14-hook-payload-shape.patch
    ./cavemem-39-session-start-cwd-filter.patch
    ./cavemem-25-search-alpha-doc.patch ]`.
  - Wrap `bin/cavemem` via `makeWrapper` so the daemon resolves a
    stable absolute path (mirror the `mcp-obsidian` block).
  - Set `meta.mainProgram = "cavemem"` and a meaningful description.
  - Observable: `nix build .#cavemem` (or the host's equivalent
    rebuild) produces a derivation whose `bin/cavemem --version`
    reports v0.2.1.
  - _Requirements: 1.1, 1.2, 1.5_
  - _Boundary: CavememPackage_

- [ ] 2. Foundation: vendored opencode plugin source
- [x] 2.1 Vendor the opencode plugin file
  - Place the cavemem opencode plugin source at
    `home-manager/common/opencode-plugins/cavemem.js`.
  - Source the plugin from cavemem v0.2.1's installer-generated output
    with the bug #14 payload-shape correction already applied so the
    plugin matches the patched CLI.
  - Add a header comment in the file naming the cavemem version it
    was vendored from and the patch IDs it must stay in sync with.
  - Observable: file exists at the documented path with the header
    comment and a non-empty body that registers handlers for
    `session.created`, `session.idle`, `tool.execute.before`, and
    `tool.execute.after`.
  - _Requirements: 2.5, 10.4_
  - _Boundary: OpencodePlugin_

- [ ] 3. Foundation: home-manager module skeleton and option surface
- [x] 3.1 Create `home-manager/common/cavemem.nix` with the option surface
  - Define `home.cavemem.enable` (bool, default false).
  - Define `home.cavemem.dataDir` (path, default
    `${config.xdg.dataHome}/cavemem`).
  - Define `home.cavemem.embedding.provider` (enum: `local`, `ollama`,
    `openai`, `none`; default `local`).
  - Define `home.cavemem.embedding.model` (str, default
    `Xenova/all-MiniLM-L6-v2`).
  - Define `home.cavemem.embedding.endpoint` and
    `home.cavemem.embedding.apiKey` (nullable str, default null).
  - Define `home.cavemem.compression.intensity` (enum, default
    `medium`).
  - Each option's `description` names the consumer (e.g., `dataDir`
    description references the sqlite-backup extension and the
    importer; `mcphub server name = cavemem` is documented either in
    the dataDir description or in a top-level module comment).
  - Module body wraps every contribution in `lib.mkIf cfg.enable
    { ... }` so disabled hosts contribute nothing.
  - Observable: a `nix eval` of the module's option set returns the
    full schema; setting `home.cavemem.enable = false` yields a
    rebuild diff of zero against the cavemem-relevant files.
  - _Requirements: 2.1, 2.2, 2.7, 3.1, 3.2, 3.3, 10.1, 10.5_
  - _Boundary: CavememModule_

- [ ] 4. Core: settings.json rendering and embedding provider logic
- [x] 4.1 (P) Render `${dataDir}/settings.json` from the option values
  - Use `home.file."${cfg.dataDir}/settings.json".text =
    builtins.toJSON ...` with conditional inclusion of
    `embedding.endpoint` and `embedding.apiKey` based on
    `embedding.provider`.
  - For `provider = "local"`: only `embedding.provider` and
    `embedding.model` are emitted; no endpoint, no apiKey.
  - For `provider = "ollama"`: include `embedding.endpoint`; do not
    include `embedding.apiKey`.
  - For `provider = "openai"`: include both `embedding.endpoint` and
    `embedding.apiKey`. When `apiKey` is null, emit a `lib.warn`
    indicating the operator should source the key via the existing
    SOPS bridge.
  - For `provider = "none"`: emit only `embedding.provider = "none"`.
  - Pass through cavemem's other settings keys (`workerPort`,
    `logLevel`, `compression.intensity`, `privacy.*`, `search.*`)
    using cavemem-default values unless module options override them.
  - Observable: a rebuild produces a settings.json whose contents
    match the option values byte-for-byte; a second rebuild with no
    option changes produces zero diff (idempotency).
  - _Requirements: 2.4, 3.4, 3.5, 3.6, 3.7_
  - _Boundary: SettingsJson_
  - _Depends: 3.1_

- [ ] 4.2 (P) Wire the vendored opencode plugin file via xdg.configFile
  - Add `xdg.configFile."opencode/plugins/cavemem.js".source =
    ./opencode-plugins/cavemem.js;` (path resolution relative to the
    cavemem.nix module file).
  - Observable: after rebuild,
    `~/.config/opencode/plugins/cavemem.js` is a symlink (or copy)
    matching the vendored source's content.
  - _Requirements: 2.5_
  - _Boundary: OpencodePlugin, CavememModule_
  - _Depends: 2.1, 3.1_

- [ ] 5. Core: mcphub and opencode wiring
- [ ] 5.1 (P) Add the cavemem entry to mcphub via `home.mcp.extraServers`
  - In the cavemem module's `config` block, set
    `home.mcp.extraServers.cavemem = { command =
    "${pkgs.cavemem}/bin/cavemem"; args = [ "mcp" ]; };`.
  - Observable: after rebuild, `~/.config/mcphub/servers.json`
    contains a `cavemem` entry with the wrapped binary's absolute
    path; `launchctl kickstart -k gui/$(id -u)/com.ravitemer.mcp-hub`
    followed by a probe of the mcphub HTTP API surfaces `cavemem` as
    a known server.
  - _Requirements: 4.1, 4.2, 4.4, 10.2_
  - _Boundary: McphubExtraServers, CavememModule_
  - _Depends: 1.2, 3.1_

- [ ] 5.2 (P) Add `mcpServers.cavemem` to opencode's settings
  - In the cavemem module's `config` block, set
    `programs.opencode.settings.mcpServers.cavemem = { command =
    "${pkgs.cavemem}/bin/cavemem"; args = [ "mcp" ]; };` (or the
    equivalent shape opencode expects).
  - Observable: after rebuild, opencode's rendered opencode.json
    contains the `mcpServers.cavemem` entry; the cavemem module never
    writes opencode.json directly.
  - _Requirements: 4.3, 4.5_
  - _Boundary: OpencodeSettings, CavememModule_
  - _Depends: 1.2, 3.1_

- [ ] 5.3 (P) Append the cavemem health check to `home.opencode.wrapperCommands`
  - In the cavemem module's `config` block, add a shell snippet to
    `home.opencode.wrapperCommands` that probes the mcphub HTTP API
    for the cavemem server's readiness; exit non-zero on probe
    failure with a stderr message naming cavemem and including a
    `launchctl kickstart` recovery hint analogous to the obsidian
    snippet.
  - Use `/usr/bin/curl` (absolute path) consistent with the obsidian
    snippet style.
  - Gated by `lib.mkIf cfg.enable` so disabled hosts skip the check.
  - Observable: with cavemem MCP up, `opencode --version` exits 0;
    after `launchctl bootout` of mcp-hub, `opencode --version` exits
    1 with the cavemem-naming error message; with `home.cavemem.enable
    = false`, the snippet is not appended.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_
  - _Boundary: OpencodeWrapperHealthCheck, CavememModule_
  - _Depends: 3.1_

- [ ] 6. Core: AGENTS.md restructure and vault-curator update
- [ ] 6.1 (P) Restructure `home-manager/common/agents.md`
  - Delete the existing "Transcription" section and the "Session
    Summary" section in their entirety.
  - Insert a new "Ambient capture (cavemem)" section that explains
    transcription and summary are now captured automatically by
    cavemem hooks; name the cavemem MCP tool prefix and point
    readers at `cavemem search` for ad hoc queries.
  - Update the existing "Startup Check" to require both obsidian
    and cavemem MCP availability before agents proceed.
  - Preserve the "Memory Recall", "Obsidian Tool Reference", and
    "Tag Guidelines" sections verbatim.
  - Preserve the semantic intent of the "Memories" section (note
    format, when-to-create rules, deduplication rules, tag
    guidelines). The frontmatter `sessions:` placeholder is the one
    intentional deviation from byte-for-byte preservation: evolve it
    to document two acceptable shapes so both human-driven memories
    and the downstream vault-synthesizer-agent populate it correctly:
      - `{session-timestamp}` (e.g., `2026-05-13T143022`) for
        human-driven memory writes.
      - `cavemem-session-<id>` (e.g., `cavemem-session-1234`) for
        synthesizer-generated memory writes (`<id>` is cavemem's
        SQLite auto-increment session identifier; provides
        traceability back to the source observations).
  - Wrap the "Memories" section with HTML-comment anchor markers
    (e.g. `<!-- BEGIN: memory-criteria -->` and `<!-- END:
    memory-criteria -->`) so the synthesizer agent can extract the
    block programmatically.
  - Observable: `grep` for "Transcription" and "Session Summary"
    headings returns no matches; `grep` for the anchor markers
    returns exactly one each; the body between the anchor markers
    documents both `{session-timestamp}` and `cavemem-session-<id>`
    placeholder shapes; a rebuild that recomposes
    `~/.config/opencode/AGENTS.md` reflects the change.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 10.3_
  - _Boundary: AgentsMdRestructure_

- [ ] 6.2 (P) Update `home-manager/common/agents/vault-curator.md`
  - Remove or revise statements that imply the curator (or any
    agent) writes to `conversations/transcriptions/` or
    `conversations/summaries/`.
  - Update the "Vault topology" section so both directories are
    described as historical archives populated by the migration
    importer; add an explicit instruction that curation passes must
    not modify their contents.
  - Leave dedup, MOC-proposal, and tag-hygiene workflows unchanged.
  - Observable: `grep -E "transcriptions|summaries" vault-curator.md`
    returns only references that label them as archives; the file
    still defines the curator subagent's mode/model/permissions
    frontmatter unchanged.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - _Boundary: VaultCuratorUpdate_

- [ ] 7. Core: custom vault importer
- [ ] 7.1 Build the vendored Node dependency tree for the importer
  - Create a `buildNpmPackage` derivation (sibling of the cavemem
    package, e.g. in `overlays/mcp-servers.nix`) that produces a
    `node_modules` containing `better-sqlite3` and `js-yaml` pinned
    to versions compatible with the host's nodejs (Node 24 today).
  - Expose this as a Nix attribute (e.g., `pkgs.cavemem-importer-deps`)
    consumed by the importer script.
  - Observable: `nix build .#cavemem-importer-deps` produces an
    output whose `lib/node_modules/` contains both packages.
  - _Requirements: 8.1, 8.6_
  - _Boundary: ImporterScript_

- [ ] 7.2 Create the importer Node script and packaging
  - Write the Node script (either inlined into the
    `writeShellApplication` text via a Nix file path or shipped as a
    separate `scripts/cavemem-import-vault.js` source).
  - The script reads its vault path from a build-baked argument
    (sourced from `home.mcp.obsidianVaultPath` at evaluation time)
    and its dataDir from a similarly-baked argument (sourced from
    `home.cavemem.dataDir`).
  - Walk `<vault>/conversations/transcriptions/*.md` and
    `<vault>/conversations/summaries/*.md`; parse YAML frontmatter
    via `js-yaml`; on parse failure, log to stderr and skip the file.
  - For each transcription, INSERT one `sessions` row (with
    `ide = "obsidian-migration"`, synthetic `cwd`,
    frontmatter-derived `started_at`, metadata containing
    `import_hash`) and one `observations` row per
    `## Exchange N` block (alternating prompt/response kinds).
  - For each summary, INSERT one `summaries` row (`scope = "session"`,
    `session_id` resolved by matching `session_marker` from the
    summary's frontmatter against the migrated sessions, or NULL
    when no match).
  - Idempotency: before any INSERT, `SELECT 1 FROM <table> WHERE
    json_extract(metadata, '$.import_hash') = ? LIMIT 1` and skip
    when the hash already exists.
  - Preflight: if `${dataDir}/cavemem.db` does not exist, exit 1
    with a stderr message instructing the operator to run `cavemem`
    once first to bootstrap the schema.
  - Print a one-line summary at the end with counts of rows inserted
    and skipped per table.
  - Package via `pkgs.writeShellApplication { name =
    "cavemem-import-vault"; runtimeInputs = [ pkgs.nodejs ]; ... }`
    in `scripts/cavemem-import-vault.nix`.
  - Wire the package into the cavemem HM module so it joins
    `home.packages` when `home.cavemem.enable` is true.
  - Observable: `cavemem-import-vault` runs against a populated
    vault and reports nonzero inserts; a second invocation reports
    zero new inserts; `sqlite3 cavemem.db "SELECT COUNT(*) FROM
    sessions WHERE json_extract(metadata, '$.migrated') = 1"`
    returns the expected count.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8_
  - _Boundary: ImporterScript_
  - _Depends: 7.1, 3.1, 4.1_

- [ ] 8. Core: smoke-test script for patch verification
- [ ] 8.1 Create `scripts/cavemem-smoke-test.nix`
  - Package via `pkgs.writeShellApplication { name =
    "cavemem-smoke-test"; runtimeInputs = [ pkgs.cavemem pkgs.sqlite
    pkgs.jq pkgs.coreutils ]; ... }`.
  - Stage a temp dataDir via `mktemp -d`; install an EXIT trap that
    removes it on success or failure.
  - Bug #14 verification: bootstrap cavemem.db by running `cavemem
    --version` (or the minimum subcommand that creates the file)
    against the temp dataDir; pipe a known opencode-shaped tool-use
    JSON payload to `cavemem hook run post-tool-use`; query the
    latest `observations` row via `sqlite3` and assert that both
    `input` (or equivalent payload-input column/JSON path) and
    `output` are non-empty. Print `OK: bug-14` on success, `FAIL:
    bug-14: <reason>` on failure.
  - Bug #39 verification: invoke `cavemem hook run session-start`
    twice with two distinct synthetic cwd values (e.g. `/tmp/cwd-a`
    and `/tmp/cwd-b`) and assert that the second invocation's
    prior-context surface (read via the appropriate cavemem
    introspection command or by SQL on `sessions`) does not
    reference the first invocation's session. Print `OK: bug-39` /
    `FAIL: bug-39: <reason>`.
  - Bug #25 verification: parse `cavemem config show` (JSON output)
    for the `search.alpha` description and assert the description
    text describes alpha=1 as keyword-only and alpha=0 as
    vector-only. Print `OK: bug-25` / `FAIL: bug-25: <reason>`.
  - MCP tool surface verification (Requirement 9.AC6 / 10.AC6):
    enumerate the cavemem MCP server's tools and assert that all
    four contract-locked names are present: `list_sessions`,
    `timeline`, `get_observations`, `search`. Implementation choice
    (either is acceptable):
      - Probe mcphub: `curl -fsS http://localhost:37373/api/servers/cavemem`
        and parse the response for the tools list. Requires mcp-hub
        to be running with the cavemem entry registered, so this
        path doubles as an end-to-end smoke for Requirements 4.1 /
        4.4.
      - Or invoke `cavemem mcp` over stdio against the temp dataDir,
        send a JSON-RPC `tools/list` request on stdin, parse the
        response on stdout, and assert the four names appear. This
        path does not require mcp-hub and is preferable for the
        temp-dataDir isolation already established by the other
        steps.
    Print `OK: tool-surface` on success, `FAIL: tool-surface:
    missing <name>` on failure (where `<name>` is the first missing
    tool).
  - Aggregate exit code: 0 only when all four pass; non-zero with
    the failing labels printed to stderr otherwise.
  - Wire the package into the cavemem HM module so it joins
    `home.packages` when `home.cavemem.enable` is true.
  - Observable: against a freshly-built cavemem package,
    `cavemem-smoke-test` exits 0 and prints four `OK:` lines (`OK:
    bug-14`, `OK: bug-39`, `OK: bug-25`, `OK: tool-surface`);
    against a deliberately-unpatched build OR a future cavemem
    version that renames a tool, the corresponding failure line
    appears on stderr.
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.6_
  - _Boundary: SmokeTestScript_
  - _Depends: 1.2_

- [ ] 9. Integration: per-host enablement and end-to-end verification
- [ ] 9.1 Enable cavemem on each host's HM profile
  - In each host's home-manager profile under `configurations/`,
    import `home-manager/common/cavemem.nix` and set
    `home.cavemem.enable = true`. Override `dataDir` only if a host
    has a non-default storage layout; both Shopify and personal
    hosts can stay on the default.
  - Observable: `darwin-rebuild switch` (or the host's rebuild
    command) succeeds on each host; `command -v cavemem` resolves
    to the wrapped binary; `~/.config/opencode/plugins/cavemem.js`
    and `${dataDir}/settings.json` exist; mcphub's servers.json
    includes the `cavemem` entry.
  - _Requirements: 2.1, 2.3, 4.1, 4.3, 4.4_
  - _Depends: 3.1, 4.1, 4.2, 5.1, 5.2, 5.3_

- [ ] 9.2 End-to-end verification on each host
  - On each host: rebuild; restart mcp-hub via `launchctl kickstart
    -k gui/$(id -u)/com.ravitemer.mcp-hub`; run
    `cavemem-smoke-test` and confirm three `OK:` lines; run
    `opencode --version` and confirm both health checks pass; run
    `cavemem` once to bootstrap cavemem.db; run
    `cavemem-import-vault` and confirm a non-zero migration count
    on first run and zero new inserts on the second run; open an
    opencode session and confirm an `cavemem search` MCP call
    returns relevant results from the migrated history.
  - Observable: a hand-written verification log captures each step's
    outcome and is attached to the integration PR description.
  - _Requirements: 4.4, 5.1, 8.1, 8.5, 8.8, 9.1, 9.2, 9.3, 9.4_
  - _Depends: 7.2, 8.1, 9.1_

- [ ] 10. Documentation: troubleshooting memory note
- [ ] 10.1 Author the troubleshooting memory note in the Obsidian vault
  - Write a memory at `memories/<date>-cavemem-integration-overview.md`
    in the vault using the standard memory frontmatter (tags: memory,
    nix-config, cavemem, memory-system, opencode, troubleshooting).
  - Body: explain the cavemem-vs-Obsidian split (cavemem owns
    transcription/summary; Obsidian owns curated memories and MOCs;
    AGENTS.md memory creation rules still apply to memory writes);
    document where the importer and smoke-test scripts live;
    document the dataDir path; reference the three patched bug IDs
    (#14, #39, #25) and the `.patch` filenames.
  - Include a troubleshooting checklist covering: opencode wrapper
    refuses to start because cavemem MCP is down (`launchctl
    kickstart` recovery); cavemem observations are present but
    `input`/`output` are empty (bug #14 patch regression: re-run
    `cavemem-smoke-test`); cross-project session-start leak recurs
    (bug #39 patch regression: re-run `cavemem-smoke-test`);
    cavemem version bump procedure (re-cherry-pick patches; re-run
    smoke tests; refresh the vendored plugin source).
  - Observable: the memory note exists in the vault and is
    discoverable via `hub_obsidian__search-by-tags` with the
    `cavemem` tag.
  - _Requirements: 11.1, 11.2, 11.3_
  - _Boundary: TroubleshootingMemory_
  - _Depends: 1.1, 7.2, 8.1_

## Implementation Notes
- 1.2: cavemem v0.2.1 is a pnpm monorepo (no package-lock.json upstream); used 'pnpm_9.fetchDeps + pnpmConfigHook' instead of 'buildNpmPackage + importNpmLock'. Patches MUST apply at source layer because tsup inlines '@cavemem/*' workspace packages into 'apps/cli/dist/index.js' via 'noExternal'. Manual 8-deps install-phase list mirrors upstream's 'apps/cli/scripts/pack-release.mjs' RUNTIME_DEPS constant — re-sync on version bumps. 
- 1.2: '@xenova/transformers' (~50MB ONNX optionalDep) is intentionally NOT installed at the package layer. cavemem lazy-imports it via 'await import(...).catch(...)' so '--version', 'mcp', 'config show' work without it. ATTENTION TASK 4.1: with default 'embedding.provider = local', the first 'cavemem start' (worker) will fail without @xenova. Either ship @xenova via the HM module, OR change the default provider, OR document the operator-must-install requirement.
- 2.1: Upstream pluginSource() emits 'spawn(NODE, [CLI, ...])' with InstallContext-baked absolute paths. Vendoring without that context: use 'spawn("cavemem", ...)' relying on PATH (Req 2.3 puts pkgs.cavemem on home.packages → ~/.nix-profile/bin/). The buildNpmPackage wrapper handles node invocation. Document deviation in any future re-vendor.
- 3.1: cavemem v0.2.1 'compression.intensity' enum is [lite/full/ultra] with default 'full' (NOT [low/medium/high/ultra] or default 'medium' as some prior notes claimed). Source of truth: packages/config/src/schema.ts. Re-pin on cavemem version bump.
- 4.1: cavemem v0.2.1's settings schema uses 'z.string().optional()' for embedding.{apiKey,endpoint} under a '.strict()' parent. Zod '.optional()' means 'string | undefined' — does NOT accept null. Use 'lib.optionalAttrs' to OMIT optional keys when the HM option is null, never emit ':null'. Same pattern applies to any future cavemem optional setting.
