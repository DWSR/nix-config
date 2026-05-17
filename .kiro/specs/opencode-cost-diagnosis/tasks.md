# Implementation Plan

This plan delivers the `opencode-cost-report` CLI per `design.md`. The
install pipeline (Foundation) is verified end-to-end before any component
logic is written — by the end of task 1, `darwin-rebuild switch` produces
a working stub binary on PATH on both nix-darwin hosts. Components then
fill in left-to-right per the architecture's dependency direction
(Data → Logic → Output → CLI orchestration). Validation closes the loop
with unit tests, integration tests, and the post-`nix flake update`
smoke-test derivation.

All 9 logic-layer components live in a single file
(`scripts/opencode-cost-report.js`) per the design's Component-to-File
Mapping; for that reason the Core-phase tasks are sequential, not
parallel. Validation-phase tasks operate on independent files and ARE
parallel-capable.

**Intentionally deferred (not implemented in v1)**:
- R7.AC2, 7.3, 7.4 — live-logger plugin behavior. The plugin itself is
  deferred per design's Plugin Decision (R7.AC5 satisfied by that
  decision being recorded). R7.AC1 (works without plugin) is satisfied
  by-construction: every other task produces a fully working diagnostic
  without any opencode plugin installed.

## Tasks

- [ ] 1. Foundation: install pipeline and test infrastructure

- [x] 1.1 Vendor npm deps tree for the diagnostic
  - Create `overlays/opencode-cost-diagnosis-deps/package.json` pinning
    `better-sqlite3@12.10.0` and `tiktoken@^1.0.20` (latest stable on the
    `1.x` line at implementation time)
  - Generate `overlays/opencode-cost-diagnosis-deps/package-lock.json`
    via `npm install --package-lock-only --prefix overlays/opencode-cost-diagnosis-deps/`
  - Both files committed to the repo (mirrors
    `overlays/cavemem-importer-deps/` layout exactly)
  - Observable: `npm ls --prefix overlays/opencode-cost-diagnosis-deps/`
    reports the two pinned packages with no warnings
  - _Requirements: 1.4_

- [x] 1.2 Add Nix derivation for the deps tree
  - Append `opencode-cost-diagnosis-deps` derivation block to
    `overlays/mcp-servers.nix`, mirroring the `cavemem-importer-deps`
    block at lines 328-378 (`buildNpmPackage` +
    `importNpmLock { npmRoot = ./opencode-cost-diagnosis-deps; }` +
    `npmConfigHook` + `dontNpmBuild = true`)
  - Inherit Darwin build flags (`npm_config_build_from_source=true`,
    `npm_config_nodedir=${nodejs}`, `nativeBuildInputs` including
    `python3` + `cctools` on Darwin) so `better-sqlite3`'s native
    binding compiles from source under the Nix sandbox
  - Custom `installPhase` produces `$out/lib/node_modules/{better-sqlite3,tiktoken}`
    consumable via `NODE_PATH` from the wrappers
  - Observable: `nix build .#opencode-cost-diagnosis-deps` succeeds on a
    clean store; `ls $(nix path-info .#opencode-cost-diagnosis-deps)/lib/node_modules`
    shows both packages
  - _Requirements: 1.4_

- [x] 1.3 Create production wrapper and Node script stub
  - Create `scripts/opencode-cost-report.nix` as a `writeShellApplication`
    that sets `NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules`
    and `exec ${nodejs}/bin/node ${./opencode-cost-report.js} "$@"`
    (~20 LOC of Nix, mirrors `scripts/cavemem-import-vault.nix`)
  - Create `scripts/opencode-cost-report.js` as a stub: parses `--help`
    only, prints a usage placeholder to stdout, exits 0
  - Observable: `nix shell .#opencode-cost-report --command opencode-cost-report --help`
    prints the placeholder usage and exits 0
  - _Requirements: 1.4, 1.5_

- [x] 1.4 Create generic test/dev Node wrapper
  - Create `scripts/opencode-cost-diagnosis-node.nix` as a
    `writeShellApplication` named `opencode-cost-diagnosis-node` that
    sets `NODE_PATH=${opencode-cost-diagnosis-deps}/lib/node_modules`
    and `exec ${nodejs}/bin/node "$@"` (generic — accepts arbitrary
    `node` arguments, so it serves as the dev environment for the
    fixture creator script, the test runner, and any ad-hoc
    `require('better-sqlite3'); require('tiktoken')` invocations)
  - Wrapper is shipped on PATH alongside the production CLI; this is
    the same pattern as `cavemem-smoke-test` (a dev/verification tool
    shipped via the existing HM module pipeline)
  - Observable: `nix shell .#opencode-cost-diagnosis-node --command opencode-cost-diagnosis-node -e 'require("better-sqlite3"); require("tiktoken"); console.log("ok")'`
    prints `ok` and exits 0; the same command without the wrapper
    (bare `node -e ...`) fails with `MODULE_NOT_FOUND` for both deps
  - _Requirements: 1.4_

- [x] 1.5 Create HM module and wire into common configuration
  - Create `home-manager/common/opencode-cost-diagnosis.nix` exposing
    `programs.opencode-cost-diagnosis.{enable, package}`; `package` is
    `readOnly = true` and points at the wrapper from 1.3
  - HM-eval-time assertion: `programs.opencode.enable` must be true
    when this module is enabled (mirrors
    `home-manager/common/memory-sync.nix:34-46`); fail with an
    actionable multi-line message naming the missing peer
  - `config = lib.mkIf cfg.enable { home.packages = [ cfg.package opencode-cost-diagnosis-node ]; ... }`
    — installs BOTH the production CLI (1.3) and the test/dev wrapper
    (1.4). The smoke-test derivation from 6.3 will be added to this
    same `home.packages` list as a third entry when that task lands.
  - Add `./opencode-cost-diagnosis.nix` to `imports` in
    `home-manager/common/default.nix` and set
    `programs.opencode-cost-diagnosis.enable = true;` in the same
    `config` block as `memory-sync` (always-on, both hosts)
  - Observable:
    `nix eval .#darwinConfigurations.ShopifyLaptop.config.home-manager.users.brandonmcnama.programs.opencode-cost-diagnosis.enable`
    returns `true`;
    `nix build .#darwinConfigurations.ShopifyLaptop.system` AND
    `nix build .#darwinConfigurations.Brandons-MacBook-Pro.system`
    both succeed (proves R1.AC1 "install on both hosts"); flipping
    `programs.opencode.enable = false` in a scratch branch causes
    evaluation to fail with the named assertion
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 1.6 Create test fixture database and test runner setup
  - Add `scripts/opencode-cost-diagnosis-test-fixture.js` that uses
    `better-sqlite3` to create a synthetic opencode-shaped SQLite DB
    at `tests/opencode-cost-diagnosis/fixtures/opencode-stable.db`
  - Fixture contents: 3 root sessions, 2 of which dispatch 2 subagents
    each; mix of `part.type` values (text, tool, step-finish, reasoning);
    realistic `message.data` JSON shapes including the `tokens` and
    `cost` sub-objects; populated `data_migration` table with the
    pinned baseline (`session_usage_from_messages`)
  - Use Node's built-in `node:test` runner (no extra dep needed); add
    a top-level `tests/opencode-cost-diagnosis/run.js` entry point that
    discovers `*.test.js` files
  - Both the fixture script and the test runner are invoked via the
    1.4 wrapper so they can `require('better-sqlite3')` /
    `require('tiktoken')`
  - Observable:
    `opencode-cost-diagnosis-node scripts/opencode-cost-diagnosis-test-fixture.js`
    rebuilds the fixture deterministically (re-running produces a
    byte-identical file);
    `sqlite3 tests/opencode-cost-diagnosis/fixtures/opencode-stable.db "SELECT count(*) FROM session"`
    returns 9 (3 roots + 6 children);
    `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/`
    discovers and runs 0 tests successfully (no tests yet, exits 0)
  - _Requirements: 1.4_

- [ ] 2. Data layer: SQLite Reader with schema-drift detection

- [ ] 2.1 Implement Reader open/close and schema-drift detection
  - Open opencode DB with `{ readonly: true, fileMustExist: true }`;
    expose `close()`
  - Declare `supportedVersionRange` constant and pinned
    `SUPPORTED_MIGRATION_SET = ["session_usage_from_messages"]` (per
    design.md:558); both readable via the module's public surface for
    use by 5.3's `--supported-opencode-version` flag and by the smoke
    test in 6.3
  - `detectMigrationSet()` reads `SELECT name FROM data_migration ORDER BY name`
    and returns the result as a sorted string array
  - On `open()`, compare detected set against pinned set; if different
    (any added/removed/renamed entry), throw `SchemaDriftError` carrying
    detected + supported sets + version range + actionable message
    naming the recommended next action
  - On missing-DB at the expected path: clear error with the expected
    path named (R6.AC4)
  - Observable: against the 1.6 fixture, `open()` succeeds; against a
    mutated fixture whose `data_migration` includes an extra row,
    `open()` throws `SchemaDriftError` with both sets in the message;
    against a non-existent path, `open()` throws with that path in the
    message
  - _Requirements: 5.1, 5.2, 6.1, 6.2, 6.4_

- [ ] 2.2 Implement Reader iteration methods
  - `rootSessionsMatching(filter)` returns sessions where
    `parent_id IS NULL` AND filter's time-range / session-id /
    cwd-pattern clauses apply (parameterized SQL, never string-built)
  - `descendantSessionsOf(rootSessionId)` returns child sessions via
    a recursive CTE over `parent_id`
  - `partsOfSession(sessionId)` returns `part` rows ordered by
    `time_created ASC, id ASC`
  - `messagesOfSession(sessionId)` returns `message` rows ordered by
    `time_created ASC`; `role` parsed out of `message.data` JSON
    (default to `null` if missing) so downstream callers do not
    re-parse the blob just for role lookup
  - All four methods return lazy `Iterable<>` so large sessions don't
    buffer entirely in memory
  - Observable: against the 1.6 fixture, the four methods return the
    expected row counts (3 roots, child-counts per design, the
    fixture's known part/message counts per session); calling
    `for...of` on a returned iterable does not load all rows at once
    (verifiable via memory snapshot or a synthetic large-fixture
    follow-up)
  - _Requirements: 6.1, 6.2_

- [ ] 3. Logic layer: attribution, subagent rollup, tokenizer

- [ ] 3.1 Implement Subagent Aggregator
  - For a root session, walk `parent_id` chain via the Reader's
    `descendantSessionsOf` method
  - Sum `tokens_input`, `tokens_output`, `tokens_cache_read`,
    `tokens_cache_write`, `tokens_reasoning`, and `cost` across all
    descendants into `SubagentBucketTotals`
  - Cycle detection: maintain a `Set<string>` of visited session IDs
    in the walk; on revisit, emit a `schema_partial_data` finding
    naming the cycle and bail out of that subtree
  - Fallback path (5.3): if Reader reports the schema lacks a
    `parent_id` column (future opencode change), return zero totals
    and surface as a `schema_partial_data` finding from the
    Attribution Engine
  - Observable: against the 1.6 fixture, root session A (with 2
    children) produces `SubagentBucketTotals` whose numeric fields
    equal the manually-computed sum of A's two children; root session
    C (no children) produces all-zero totals; a synthetic cycle
    fixture emits exactly one finding and does not infinite-loop
  - _Requirements: 2.3, 5.3_

- [ ] 3.2 Implement Tokenizer Splitter
  - Initialize tiktoken's `cl100k_base` encoding once (lazy-init on
    first `classifyAndCount` call); cache the encoder for the
    process lifetime
  - `classifyAndCount(parts, messages)` walks parts and accumulates
    per-category token counts per the design's classification rules
    (design.md:760-784): system-role text → `systemPrompt`;
    user/assistant text → `history`; tool parts with state.output →
    `toolOutput`; reasoning/step-start/step-finish/compaction/agent/
    patch/file → skipped; any other `part.type` → `unclassifiedCount`
  - For each classified part, count `tiktoken.encode(content).length`
    where `content` is the part's text body (from `message.data` for
    text parts, from `part.data.state.output` for tool parts)
  - Return `ProvenanceCounts { systemPrompt, history, toolOutput,
    unclassifiedCount }`
  - Observable: against a fixture session containing one text part
    per role (system, user, assistant), one tool part with output,
    one reasoning part, and one unknown-type part, the returned
    counts: `systemPrompt > 0`, `history > 0` (sum of user+assistant
    counts), `toolOutput > 0`, `unclassifiedCount > 0` (the unknown
    type), and reasoning is NOT in any of the three classified
    buckets
  - _Requirements: 2.3, 2.9_

- [ ] 3.3 Implement Attribution Engine
  - For each root session, produce a `SessionAttribution` containing:
    authoritative `BucketTotals.cachedRead` =
    `session.tokens_cache_read`, `cachedWrite` =
    `session.tokens_cache_write`, `output` = `session.tokens_output`,
    `reasoning` = `session.tokens_reasoning`, `subagentDispatch` =
    sum of subagent rollup tokens
  - Build the `ReadonlyMap<messageId, MessageRow>` from
    `reader.messagesOfSession(sessionId)` for Tokenizer; invoke
    `tokenizer.classifyAndCount(parts, messages)` to get
    `ProvenanceCounts`
  - Compute uncached sub-buckets via the Flow 2 math:
    `T_input = session.tokens_input`; let `P_sum = systemPrompt +
    history + toolOutput`; `bucket_sys = round(T_input * P_sys /
    P_sum)`, `bucket_hist = round(T_input * P_hist / P_sum)`,
    `bucket_tool = T_input - bucket_sys - bucket_hist` (last bucket
    absorbs rounding so the sum is exact)
  - Findings emitted: `per_bucket_cost_deferred` for every session;
    `caching_not_enabled` for the global report when `sum(tokens_cache_read) == 0`;
    `unclassifiable_input` when `P_sum == 0`; `schema_partial_data`
    when `provenanceCounts.unclassifiedCount > 0` (naming the count
    and the encountered `part.type` values)
  - Populate `CostBuckets.total` from `session.cost`; set all
    per-bucket cost fields to `null`
  - INVARIANT enforced at session-attribution end:
    `bucket_sys + bucket_hist + bucket_tool == T_input` exactly; if
    violated, emit `schema_partial_data` finding with the discrepancy
    and exit with code 5 (programming error per design's Error
    Categories) since this would be a math bug, not a data bug
  - Observable: against the 1.6 fixture, attribution for root session
    A produces `tokens.cachedRead` exactly equal to session A's
    `tokens_cache_read`; `tokens.{uncachedSystemPrompt + history +
    toolOutputs}` equals `tokens_input` exactly; `findings` contains
    `per_bucket_cost_deferred` and no `unclassifiable_input`
  - _Requirements: 2.3, 2.6, 5.4_

- [ ] 4. Output layer: file writer, aggregation, and formatters

- [ ] 4.1 Implement File Writer
  - Default output path:
    `${XDG_STATE_HOME ?? `${os.homedir()}/.local/state`}/opencode-cost-diagnosis/reports/<iso8601>.{md,json}`
    where `<iso8601>` is the report-generation timestamp formatted
    without `:` (filename-safe)
  - Create parent dirs with `recursive: true`; set process umask to
    `0o077` BEFORE opening any report file so the file is created
    mode `0600` (R4.AC4)
  - Pruning: after each successful write, list files under
    `reports/` matching `*.{md,json}` separately per extension,
    sort by mtime descending, retain newest 10 per extension,
    `fs.unlink` the rest. Mirrors `scripts/memory-sync.nix:467-489`
  - `--output <path>` override: when present, write only the single
    named file (chosen format derived from extension); skip pruning
    entirely
  - I/O error handling: any non-ENOENT errno on write surfaces as
    exit code 4 with the affected path and operation named in the
    stderr trailer (R6.AC5)
  - Observable: after running on the 1.6 fixture with no `--output`,
    `ls -la $XDG_STATE_HOME/opencode-cost-diagnosis/reports/` shows
    exactly one `.md` and one `.json` file, both mode `0600`; after
    11 successive runs, the count stabilizes at 10 per extension;
    with `--output /tmp/foo.json`, only that file is written and
    `reports/` is untouched
  - _Requirements: 4.4, 4.5, 6.5_

- [ ] 4.2 Build aggregation and DiagnosticReport assembly
  - Group `SessionAttribution[]` by `session.directory` to produce
    `ProjectAggregate[]`: per-project session count, summed
    `BucketTotals`, and summed `cost.total` (per-bucket cost fields
    stay `null` per Iteration 2.5 forward-compat decision)
  - Compute `globalTotals.tokens` as the sum of every session's
    `BucketTotals`; compute `globalTotals.cost.total` as the sum of
    every session's `cost.total`; `globalTotals.cost` per-bucket
    fields stay `null` (same forward-compat pattern)
  - Construct the structured `TokenizerDisclaimer` object once per
    report run (library, encoding, accuracyClass, affectedBuckets,
    authoritativeBuckets, sumCorrectnessGuarantee, humanReadable)
    per design.md:912-921
  - Apply privacy filtering at assembly time (R4.AC1, R4.AC2): by
    default, omit message bodies / tool-output content / prompt
    content from the assembled `DiagnosticReport`; when
    `--include-content` is set (R4.AC3), include them
  - Emit global findings: `caching_not_enabled` at the global level
    when sum of `tokens_cache_read` across all in-scope sessions is
    0 (R2.AC7); aggregate per-session findings into the global
    `findings` array
  - Empty-DB shape (R2.AC8): when zero sessions match, produce a
    valid `DiagnosticReport` with `sessionCount: 0`, empty
    `sessions` array, empty `byProject`, zero `globalTotals`, but
    the disclaimer object is still present
  - Observable: against the 1.6 fixture (3 root sessions across 2
    distinct cwds), the assembled `DiagnosticReport` has
    `sessionCount: 3`, `byProject` with exactly 2 keys,
    `globalTotals.cost.total` equals the sum of all session
    `cost.total` values, all per-bucket cost fields are `null`, and
    `tokenizer_disclaimer.affectedBuckets` is exactly
    `["uncachedSystemPrompt", "history", "toolOutputs"]`; with
    default flags, no message-body strings appear anywhere in the
    assembled report; with `--include-content`, they do
  - _Requirements: 2.4, 2.5, 2.7, 2.8, 4.1, 4.2, 4.3_

- [ ] 4.3 Implement Markdown and JSON serializers
  - JSON serializer: serialize the assembled `DiagnosticReport` via
    `JSON.stringify` with a custom replacer that emits keys
    alphabetically within each object; no wall-clock fields in JSON
    (R6.AC3 byte-identical guarantee)
  - Markdown serializer: headline disclaimer block FIRST (always
    present, regardless of report shape), then global totals (tokens
    + cost), then per-project breakdown grouped by `session.directory`,
    then per-session detail tables, then findings; report-generation
    timestamp permitted in MD header (NOT in JSON, per R6.AC3)
  - Observable: against the 1.6 fixture, two successive invocations
    produce byte-identical JSON output (string comparison passes);
    the JSON's first-level keys appear in alphabetical order; the
    Markdown begins with a disclaimer block whose first line
    references "tiktoken"; both formats contain the structured
    `tokenizer_disclaimer` object / block
  - _Requirements: 2.1, 2.2, 2.9, 6.3_

- [ ] 5. CLI orchestration: parsing, selection, entry

- [ ] 5.1 Implement Argument Parser
  - Hand-rolled flag parsing (no `commander`/`yargs` per design's
    Tech Stack table); supported flags: `--last <duration>`,
    `--session <id>`, `--cwd <path>`, `--include-content`,
    `--format <md|json|both>` (default `both`), `--output <path>`,
    `--supported-opencode-version`, `--help`
  - Time-range parser: accept `30d`, `24h`, `7d`, `1h`; reject
    multi-unit forms (`7d6h`) and other unsupported syntax with an
    actionable error naming the offending value (mirrors
    `parse_since` from `memory-sync.nix`)
  - On unknown flag or unparseable selector value: print usage block
    to stderr naming the offending arg; exit 1 (R3.AC5 + R6.AC5)
  - `--supported-opencode-version` flag: print the diagnostic's
    pinned `supportedVersionRange` constant (defined in 2.1) and the
    pinned `SUPPORTED_MIGRATION_SET`; exit 0 (R5.AC1)
  - Observable: `opencode-cost-report --last 30d --cwd /Users/x/foo`
    produces a parsed result object containing both selectors;
    `opencode-cost-report --last 7d6h` exits 1 with the offending
    value named in stderr; `opencode-cost-report --supported-opencode-version`
    prints the version range and migration set and exits 0
  - _Requirements: 3.1, 3.2, 3.3, 3.5, 4.3, 5.1_

- [ ] 5.2 Implement Session Selector
  - Translate parsed selector args into parameterized SQL fragments
    consumed by the Reader's `rootSessionsMatching(filter)` method;
    combine multiple selectors with logical AND (R3.AC4)
  - All values bound as parameters (never string-interpolated) to
    avoid SQL-injection bugs even though this is a local single-user
    tool
  - Observable: invoking the diagnostic against the 1.6 fixture with
    `--last 1d` returns no sessions (fixture sessions are older);
    with `--last 365d --cwd /Users/x/foo` (matching the fixture's
    cwd for 1 of 3 root sessions) returns exactly that 1 root session
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [ ] 5.3 Implement CLI Entry and integrate all components
  - Top-level `main()` orchestrates: parse args → open Reader → build
    Selector → iterate root sessions → for each: get parts, get
    messages, build messages map, invoke Aggregator, invoke
    Tokenizer, invoke Attribution Engine → invoke Reporter
    assembly (4.2) → invoke Reporter serializers (4.3) → invoke File
    Writer → print operator summary to stdout (1-2 line summary +
    file paths)
  - Single top-level `try/catch`: maps caught errors to exit codes
    per design's Error Categories (1=bad arg, 2=missing DB, 3=schema
    drift, 4=I/O, 5=programming/assertion); each error category
    writes an actionable one-line trailer to stderr
  - Empty-result success (R2.AC8): zero in-scope sessions produces
    empty-but-valid reports and exit 0
  - Identical command surface on both hosts (R1.AC5): by construction
    since both hosts ship the same derivation; nothing host-specific
    in this layer
  - Observable: full end-to-end run against the 1.6 fixture produces
    both Markdown and JSON reports under
    `$XDG_STATE_HOME/opencode-cost-diagnosis/reports/`, prints a 1-2
    line operator summary to stdout, exits 0; invoking with
    `--session non-existent-id` produces empty-but-valid reports and
    exits 0; invoking against a mutated fixture with drifted
    `data_migration` exits 3 with the schema-drift trailer
  - _Requirements: 1.5, 2.8, 6.3_
  - _Depends: 2.1, 2.2, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3, 5.1, 5.2_

- [ ] 6. Validation: tests and smoke-test derivation

- [ ] 6.1 (P) Implement unit tests
  - Implement all 9 unit tests enumerated in `design.md` Testing
    Strategy (lines 1064-1097) using Node's built-in `node:test`
    runner, one test file per logical area
    (`tests/opencode-cost-diagnosis/unit/*.test.js`)
  - Tests verify: (1) time-range parser accepted/rejected values;
    (2) bucket sum-correctness invariant; (3) subagent recursive
    rollup with no double-counting; (4) privacy default-exclude vs
    `--include-content`; (5) schema-drift detector against a mutated
    fixture; (6) assistant-role text classification; (7) per-bucket
    cost deferral finding emission with `cost.total > 0` and
    per-bucket fields null; (8) unclassified `part.type` surfaces
    `schema_partial_data` finding without folding into any bucket;
    (9) aggregate cost forward-compat (globalTotals.cost.total +
    ProjectAggregate.cost.total sum correctness, per-bucket null
    invariants)
  - Tests invoked via the 1.4 wrapper so deps resolve:
    `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/unit/`
  - Observable:
    `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/unit/`
    reports 9 passing tests, 0 failures
  - _Requirements: 2.3, 2.6, 2.7, 2.9, 3.1, 4.2, 4.3, 5.2, 5.3, 5.4_
  - _Boundary: tests/opencode-cost-diagnosis/unit/_
  - _Depends: 5.3_

- [ ] 6.2 (P) Implement integration tests
  - Implement all 5 integration tests enumerated in `design.md`
    Testing Strategy (lines 1099-1118) under
    `tests/opencode-cost-diagnosis/integration/*.test.js`:
    (1) end-to-end against the 1.6 fixture with golden-file
    comparison for both Markdown and byte-identical JSON;
    (2) concurrent reader vs active writer against a separate
    write-fixture (spawn a child process that writes while the
    diagnostic reads; neither blocks the other; no corruption);
    (3) empty-DB success — fixture with schema but no rows produces
    valid empty reports and exit 0; (4) disclaimer presence in every
    report whose attribution includes uncached sub-buckets (both MD
    and JSON formats); (5) CLI-flag combination AND semantics
    (`--last 365d --cwd <fixture-cwd>` returns the expected single
    session)
  - Golden files live at
    `tests/opencode-cost-diagnosis/integration/golden/*.{md,json}`;
    an `UPDATE_GOLDEN=1` env var lets the developer regenerate when
    intentional output changes land
  - Tests invoked via the 1.4 wrapper so deps resolve:
    `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/integration/`
  - Observable:
    `opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/integration/`
    reports 5 passing tests, 0 failures; running twice in succession
    produces no diff against committed golden files (byte-identical
    JSON guarantee, R6.AC3)
  - _Requirements: 2.1, 2.2, 2.8, 2.9, 3.4, 6.2, 6.3_
  - _Boundary: tests/opencode-cost-diagnosis/integration/_
  - _Depends: 5.3_

- [ ] 6.3 (P) Create smoke-test derivation and wire into HM module
  - Create `scripts/opencode-cost-diagnosis-smoke-test.nix` as a
    `writeShellApplication` (~50 LOC) named
    `opencode-cost-diagnosis-smoke-test` that runs four checks
    against the live opencode DB at
    `${XDG_DATA_HOME:-$HOME/.local/share}/opencode/opencode-stable.db`:
    (a) DB file exists and is readable (else exit with label
    `db_missing`); (b)
    `sqlite3 "$DB" "SELECT name FROM data_migration ORDER BY name"`
    matches the pinned baseline set from 2.1 (else exit with label
    `schema_drift`); (c) `command -v opencode-cost-report` succeeds
    (else exit with label `cli_missing`); (d)
    `opencode-cost-report --supported-opencode-version` prints the
    expected range (else exit with label `version_mismatch`); on
    success exits 0
  - The pinned baseline migration set is embedded as a Bash array
    constant — must stay consistent with 2.1's
    `SUPPORTED_MIGRATION_SET` constant; add a comment in both files
    cross-referencing the other
  - Add the smoke-test package to the HM module's `home.packages`
    (modifies `home-manager/common/opencode-cost-diagnosis.nix` from
    1.5 to install all three binaries: production CLI, dev wrapper,
    smoke test)
  - Observable: after a fresh `darwin-rebuild switch`,
    `opencode-cost-diagnosis-smoke-test` exits 0 on the current host
    (Shopify, schema set = `["session_usage_from_messages"]`); after
    artificially renaming the migration in a scratch test DB, the
    smoke test exits with `schema_drift` label printed to stderr
  - _Requirements: 5.1, 5.2_
  - _Boundary: scripts/opencode-cost-diagnosis-smoke-test.nix, home-manager/common/opencode-cost-diagnosis.nix_
  - _Depends: 1.5, 2.1, 5.3_
