# Research: pi-agent-integration

## Summary
- **Feature**: `pi-agent-integration`
- **Discovery Scope**: Extension; light integration-focused merge discovery
- **Key Findings**:
  - Free-form provider URLs, headers, commands, and store paths make credential
    exclusion depend on incomplete string heuristics. Closed role and resolver
    contracts remove those channels.
  - Provider behavior and per-launch values need separate explicit contracts:
    one closed catalog, one stable persisted projection, and one memory-only
    token/UUID object.
  - `agentmemory-opencode-migration` now owns the shared AgentMemory package,
    daemon, core MCP upstream, backup, and secret reference. Pi should consume
    those contracts rather than retain its repository-owned Cavemem bridge.
  - AgentMemory's bundled Pi integration is intentionally stock: 8,000-character
    observation slices, fire-and-forget capture, standard REST routes, and no
    full-payload/FIFO/sticky-error guarantees.

## Research Log

### Sources Reviewed
- Upstream Pi `v0.83.0`, `pi.nix` at `1d37b586`, and Pi package/configuration
  documentation
- `nolabs-ai/nono-packs` Pi pack `0.2.0`
- Shopify Slack thread `C0ASWCJ0Y6M/1785896169.075539`, linked `shop/world`
  Pi configuration, and the repository's static OpenCode provider configuration
- `shopify-playground/shop-pi-fy` at `dff77f78`
- Public Pi extension repositories, manifests, releases, and compatibility data
- Current nix-config OpenCode, nono, mcpproxy, AgentMemory, Pi overlay, host,
  launcher, sandbox, status, validation, and test modules
- `agentmemory-opencode-migration` requirements, design, implementation, and
  bundled AgentMemory `integrations/pi/` sources

## External Findings

### Pi and pi.nix
- Pi `0.83.0` requires Node `>=22.19.0`, uses `~/.pi/agent`, and has no native
  sandbox or MCP client. Extensions execute with the launcher's permissions.
- `PI_CODING_AGENT_DIR` relocates the full state root. Pi discovers global and
  trusted project extensions, skills, prompts, themes, and agent instructions.
- `models.json` supports provider `baseUrl`, API type, models, API-key commands,
  headers, and environment interpolation in `apiKey` and `headers`. It does not
  interpolate environment values in `baseUrl`.
- `pi.nix` exposes a Home Manager module, package selection, rules, skills,
  extensions, themes, prompts, models, settings, environment, and extra args on
  `aarch64-darwin`. Its jail is Linux-only, and its CI does not build Darwin.
- `pi.nix` merges managed settings into mutable state before launch, but removed
  keys can remain. Its model installer copies only when `models.json` is absent,
  so later declarative updates can stop applying.
- Pi `0.83.0` pins vulnerable `undici@8.5.0`; `>=8.9.0` resolves
  `GHSA-4cwx-7wf7-3272`. Context-limit recovery is available in upstream commit
  `32850ef7` but not in the release pin.

### Shopify provider configuration
- The local OpenCode configuration already proves the intended split:
  `configurations/shopify/home-manager/opencode.nix` renders provider endpoints
  and headers statically, while its wrapper resolves `devx llm-gateway` token,
  base URL, and a session ID at launch.
- Pi can model the same core routing without Shopify's private proxy extension.
  The wrapper must reconcile the concrete runtime base URL because Pi does not
  expand it in `models.json`.
- Exact `devx pi` parity would also include migrations, a managed-default marker,
  package-source policy, update rewriting, and private request metadata. These
  are not required for the selected direct-Pi scope.
- Provider wire compatibility remains a runtime gate for each declared Shopify
  provider/model/API combination.
- The managed Shopify catalog includes Anthropic, OpenAI, Google, Groq, and xAI.
  Cohere lacks a Pi core API and Perplexity lacks the required coding-tool path;
  both are omitted rather than adding a provider extension.

### nono and MCP
- The public Pi pack policy grants the language runtimes, caches, Pi state,
  current workspace, process signals, and network access needed by stock Pi.
  Its imperative package wiring is separable from the profile policy.
- The pack requires nono `>=0.55.0`. The repository currently packages nono
  `0.69.0`; the researched upstream release is `0.71.0`.
- mcpproxy already runs on `127.0.0.1:8080` on both hosts and owns the upstream
  inventory. Pi needs one remote adapter entry, not duplicate server configs.
- `pi-mcp-adapter@2.20.1` supports direct tools, but first-run metadata can
  temporarily expose its generic proxy. Direct mode therefore needs an explicit
  allowlist, eager connection, proxy/script disablement, and a surface check.

### AgentMemory Pi integration
- AgentMemory `v0.9.29` plus commit `e04ba888` packages
  `integrations/pi/index.ts`, adjacent `security.ts`, metadata, and its complete
  relative source layout.
- The factory subscribes to `session_start`, `before_agent_start`,
  `tool_result`, `agent_end`, and `session_shutdown`; it exposes
  `memory_health`, `memory_search`, `memory_save`, and `/agentmemory-status`.
- It calls authenticated health, session start, observe, smart-search, remember,
  session end, and consolidate routes using `AGENTMEMORY_URL` and
  `AGENTMEMORY_SECRET`.
- The packaged Pi copy changes only successful `memory_health` tool details from
  the raw health object to `{ ok: true }`; visible text and standard lifecycle
  behavior remain unchanged.
- Conversation and tool text is sliced to 8,000 characters. Most observations
  are fire-and-forget, failures return `null`, and only session end has a bounded
  timeout. There is no FIFO, pre-mutation snapshot, full-payload mode, durable
  retry, sticky error, or shutdown flush guarantee.
- Project selection uses `AGENTMEMORY_PROJECT_NAME`, then Git-root basename,
  then cwd basename. Existing same-basename limitations remain accepted.
- Managed `/agentmemory/health` treats `healthy` and `degraded` as operational
  HTTP 200 states and reserves HTTP 503 for `critical`; Pi must match that
  bounded-index runtime contract rather than reject degraded service.

### Selected public extensions
| Capability | Source pin | Notes |
|---|---|---|
| MCP | `pi-mcp-adapter@2.20.1` (`1dbdef96`) | MIT; post-Pi-0.83 release |
| Sub-agents | `pi-subagents@0.40.0` (`d4d2ab70`) | MIT; child extension inheritance must be explicit |
| Plan mode | `@narumitw/pi-plan-mode@0.49.2` (`df5f5ce7`) | MIT; Pi 0.83; default Bash access must be removed |
| Timestamps | `@narumitw/pi-stamp@0.49.3` (`4c2c2e8c`) | MIT; Pi 0.83; presentation-only |
| Bash timeout | `@mrclrchtr/supi-bash-timeout@4.6.0` (`98b80f6d`) | MIT; preserves explicit timeout |
| Questions | `@mrclrchtr/supi-ask-user@4.6.0` (`98b80f6d`) | MIT; normal TUI mode |
| Code intelligence | `@mrclrchtr/supi-code-intelligence@4.6.0` (`98b80f6d`) | MIT; LSP children and guarded apply |
| Background tasks | `@99percentpeople/pi-background-tasks@2.0.0` (`0d231ab3`) | MIT; Pi 0.83; native `node-pty`; new major |
| AgentMemory | Bundled `integrations/pi/index.ts` at `e04ba888` | Apache-2.0; retain stock behavior with the enumerated value-free health-details substitution |
- The extension matrix has not been run together on Darwin. Load order, tool
  collisions, sub-agent inheritance, PTY cleanup, and sandbox behavior need
  integration tests.
- Sieve is deferred. No public turnkey extension matched filtering, fail-open,
  material-savings, and full-output recovery. `pi-lean-ctx` was the strongest
  alternative but was not selected.
- `shop-pi-fy` informed the selected capabilities but is not a dependency. Its
  private bundle has no root license grant, overlaps AgentMemory and existing
  SDD behavior, and introduces mutable `/pkg` state.

## Gap Analysis

### Existing assets and missing capabilities
| Requirement area | Reusable asset | Gap |
|---|---|---|
| Package and hosts | Shared overlays, two HM imports, flake checks | Pi input/module/package and two-host enablement are missing |
| Wrapper/config | OpenCode wrapper-command and nono-launcher patterns | Pi needs a new locked, provenance-aware JSON reconciler |
| Shopify providers | Static OpenCode catalog and `devx llm-gateway` preflight | Pi base-URL composition and provider smoke tests are missing |
| Sandbox | `pkgs.nono`, OpenCode profile renderer and tests | Existing renderer is OpenCode-specific; Pi profiles are missing |
| MCP | Shared mcpproxy module and endpoint | Pi adapter config, direct surface gate, and Pi instructions are missing |
| AgentMemory | Managed package/runtime, bundled Pi source, secret reference, REST and core MCP upstream | Pi launcher, manifest, child inheritance, sandbox, status, and acceptance contracts must consume the shared runtime |
| Extensions | Nix package/overlay and Node test conventions | Every selected extension closure and combined load test is missing |
| Subprocess safety | nono audit/enforced rollout pattern | Credential inheritance, PTY/LSP/child cleanup need new controls |
| Acceptance | HM render tests and launcher stub tests | Pi provider, TUI, MCP, lifecycle, and two-host runtime tests are missing |

### Implementation options
- **Extend pi.nix**: contribute wrapper/config fixes upstream and consume them.
  Small local surface, but blocked by upstream cadence and project-specific
  provider, sandbox, and AgentMemory behavior.
- **Own the complete Pi stack**: package Pi and all resources in this repository.
  Maximum control, but duplicates pi.nix packaging and update work.
- **Hybrid**: consume pi.nix's package/module resource surface while owning the
  launcher, reconciler, profiles, host deltas, extension bundle, and tests.
  Reuses packaging without forcing OpenCode or Pi-specific behavior into the
  wrong module.

### Complexity and risk
- **Effort: XL**. The feature combines package patching, two host modes, runtime
  config ownership, sandboxing, nine extensions, native PTY support, and
  cross-process tests.
- **Risk: High**. The untested Darwin extension matrix, Shopify wire protocols,
  credential isolation, and process cleanup are rollout gates.

### Provider contract blocker
- **Context**: Task 2.1 attempted to prove secret-free configuration while
  exposing `baseUrl`, `runtimeBasePath`, arbitrary headers, environment/command
  credential sources, argv, and raw store paths.
- **Findings**: Successive finite scanners admitted concrete credentials through
  `X-ApiKey`, provider paths and queries, encoded command assignments, and
  credential argv, while broader rules rejected benign flags, headers, URLs,
  and package names. Store-root parsing also diverged from Nix's own validity
  rules. Every repair left another equivalent string channel.
- **Implications**: Host input must select fixed provider roles and model
  references. The module owns routes, API/request policy, header bindings, and
  closed resolver kinds. Package-backed resources enter as derivations plus
  canonical relative paths; only module outputs contain store roots. Evaluation
  checks structure and references, while generated-manifest, closure, and
  launcher checks remain separate defenses.
- **Validation repair**: The first structural revision still hid behavior behind
  `FixedRoleContract` and mixed persisted provider data with a runtime launch ID.
  `ProviderCatalogV1` now fixes every route/API/model/request-policy field and
  exact header/template. `PersistedProviderV1` excludes values;
  `ProviderRuntimeSecretsV1` owns token/UUID process state. The reconciler accepts
  only a deterministic persisted projection.

### Memory backend correction
- **Context**: The original Pi design created a repository-owned Cavemem bridge,
  full-payload mode, privacy grammar, raw retrieval path, and worker fencing.
- **Finding**: `agentmemory-opencode-migration` replaced Cavemem for both
  harnesses and preserved AgentMemory's bundled Pi integration specifically for
  managed activation. Keeping the old bridge would create live dual writes and
  retain a package, database, MCP upstream, backup, sandbox grant, and test
  matrix that the migration removed.
- **Implication**: Pi accepts stock AgentMemory fidelity and lifecycle semantics.
  Credential protection is enforced at launch and subprocess environment
  boundaries; this feature does not recreate payload-level Cavemem guarantees.

### Implementation continuity
- Package Tasks 1.1–1.5 already establish the pinned Pi package, deterministic
  harness, Undici remediation, context recovery, and extension closure.
- Completed provider, reconciliation, nono, MCP, and non-memory extension work
  remains valid.
- Completed Cavemem-specific implementation is superseded and removed. Its
  payload, privacy, storage, process-capability, and worker contracts do not
  constrain AgentMemory.
- The AgentMemory migration already establishes package/runtime ownership,
  secret references, standard routes, core MCP registration, bounded BM25
  behavior, backup, and explicit OpenCode-only Cavemem rollback.

## Architecture Pattern Evaluation

| Option | Strength | Limitation | Decision |
|---|---|---|---|
| Free-form provider fields plus scanners | Flexible | Equivalent credential channels remain representable | Rejected |
| Closed provider-role and resolver catalogs | Invalid credential-bearing forms have no input shape | New roles require reviewed module changes | Selected |
| Opaque role contract | Closed names with hidden behavior | Tasks must invent routes, headers, and model policy | Rejected |
| Explicit catalog plus persisted/runtime split | Complete behavior and stable concurrent files | Catalog changes require review | Selected |
| Preserve Pi Cavemem bridge | Retains stronger full-payload contracts | Duplicates the migrated backend and reintroduces dual-write/runtime ownership | Rejected |
| Patch AgentMemory Pi capture for parity | Recovers selected Cavemem guarantees | Creates a second custom integration and contradicts the migration's upstream-first boundary | Rejected |
| Use bundled AgentMemory Pi integration | Reuses the managed runtime and existing upstream API | Accepts stock truncation, capture-loss, scoping, and lifecycle limits | Selected |

## Design Decisions
- **Package seam**: use `pi.nix` only as the pinned base-package source. The
  repository owns desired state, launcher, profiles, resources, and validation.
- **Configuration seam**: host activation renders immutable closed selections;
  one provenance-aware runtime reconciler owns explicit JSON pointers and fixed
  provider IDs under locking and atomic replacement.
- **Provider seam**: `ProviderCatalogV1` fixes personal OpenAI and all five
  Shopify routes, APIs, built-in model provenance, no-override policy, exact
  affinity/usage headers, Google bearer policy, defaults, and unsupported roles.
- **Resolver seam**: `pi-auth`, `shopify-gateway-token`, and
  `shopify-gateway-base` are the complete resolver set. The launcher constructs
  fixed argv from package-backed executables; no command or environment source
  extension exists.
- **Artifact seam**: options carry derivations plus canonical relative paths.
  Module outputs carry rendered store paths. Evaluation, manifest validation,
  closure scans, and runtime URL validation have separate responsibilities.
- **Projection seam**: managed `models.json` contains concrete joined URLs plus
  `${SHOPIFY_PI_TOKEN}`/`${PI_AGENT_LAUNCH_ID}` templates. Token and UUID live in
  `ProviderRuntimeSecretsV1`; concurrent launches retain byte-identical files.
- **Credential seam**: root/child Pi alone receive actual provider values and
  the AgentMemory bearer; model-invoked subprocesses are scrubbed.
- **Memory seam**: the Pi module supplies the managed AgentMemory URL and secret
  reference, while the bundled integration owns hooks, tools, REST calls,
  observation limits, context injection, and consolidation.
- **Storage seam**: Pi receives no AgentMemory data-directory access. Package,
  persistence, indexing, backup, and core MCP ownership remain in
  `agentmemory-opencode-migration`.
- **Preserved seams**: the six-tool mcpproxy adapter, standalone nono profiles,
  fixed-lock extension closure, and provenance-aware reconciliation remain as
  previously designed.
- **Simplifications**: no arbitrary providers, headers, resolver plugins,
  extension ecosystem, custom memory bridge, Sieve, private Shopify extension,
  exact `devx pi` parity, memory schema change, or cross-host state sync.

## Risks & Mitigations
- A fixed Shopify route or request policy drifts: revalidate every role against
  the switched-host protocol gate before rollout.
- Concurrent base resolution disagrees under one generation: fail projection
  reconciliation rather than allow last-writer-wins provider state.
- A runtime credential reaches a model-invoked subprocess: keep the closed
  spawn partition and sentinel tests authoritative rather than relying on
  payload-text heuristics.
- A trusted in-process extension can inspect the AgentMemory bearer: retain the
  fixed reviewed extension inventory and scrub every model-invoked subprocess.
- AgentMemory drops or truncates an observation: accept stock behavior and make
  it visible in compatibility tests rather than adding a retry or raw-event path.
- A new provider, resolver, or memory behavior is needed: require a module/design
  review and explicit revalidation rather than an escape hatch.
- AgentMemory health is degraded by bounded-index or persistence conditions:
  accept degraded readiness, report it, and reject only critical/unavailable,
  unauthenticated, or fallback startup states.

## References
- Pi `v0.83.0` and `pi.nix` `1d37b586` provider/configuration contracts.
- AgentMemory `e04ba888` `integrations/pi/index.ts`, `security.ts`, standard REST
  routes, and managed Home Manager runtime from `agentmemory-opencode-migration`.
- Repository `configurations/shopify/home-manager/opencode.nix` for current
  gateway integration roles.
- `tasks.md` implementation notes for completed package work and the AgentMemory
  cutover tasks.
