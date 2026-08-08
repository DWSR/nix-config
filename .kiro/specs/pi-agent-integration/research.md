# Research: pi-agent-integration

## Summary
- **Feature**: `pi-agent-integration`
- **Discovery Scope**: Extension; light integration-focused merge discovery
- **Key Findings**:
  - Free-form provider URLs, headers, commands, and store paths make credential
    exclusion depend on incomplete string heuristics. Closed role and resolver
    contracts remove those channels.
  - Universal parsing of Cavemem string leaves alternated between leaks and
    corruption. Structured recursion plus finite lexical rules provides an
    enforceable privacy and false-positive boundary.
  - Provider behavior and per-launch values need separate explicit contracts:
    one closed catalog, one stable persisted projection, and one memory-only
    token/UUID object.
  - Completed package Tasks 1.1–1.5 and canonical-envelope Task 3.1 remain valid;
    blocked Task 2.1 and 3.2 partial implementations are not design evidence.

## Research Log

### Sources Reviewed
- Upstream Pi `v0.83.0`, `pi.nix` at `1d37b586`, and Pi package/configuration
  documentation
- `nolabs-ai/nono-packs` Pi pack `0.2.0`
- Shopify Slack thread `C0ASWCJ0Y6M/1785896169.075539`, linked `shop/world`
  Pi configuration, and the repository's static OpenCode provider configuration
- `shopify-playground/shop-pi-fy` at `dff77f78`
- Public Pi extension repositories, manifests, releases, and compatibility data
- Current nix-config OpenCode, nono, mcpproxy, Cavemem, overlay, host, and test
  modules

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

### Cavemem payload limits
- Cavemem `v0.2.1` remains the newest release. Unpublished `0.3.0` main retains
  the 500-character per-input/per-output cap and lossy grammar compression.
- The SQLite schema and insertion API accept full text without migration. The
  selected design adds an opt-in Pi hook mode that bypasses truncation and
  compression after privacy redaction; default non-Pi hook behavior is unchanged.

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
| Cavemem | Repository-owned bridge | No maintained native Pi bridge exists |
- The extension matrix has not been run together on Darwin. Load order, tool
  collisions, sub-agent inheritance, PTY cleanup, and sandbox behavior need
  integration tests.
- Sieve is deferred. No public turnkey extension matched filtering, fail-open,
  material-savings, and full-output recovery. `pi-lean-ctx` was the strongest
  alternative but was not selected.
- `shop-pi-fy` informed the selected capabilities but is not a dependency. Its
  private bundle has no root license grant, overlaps Cavemem and existing SDD
  behavior, and introduces mutable `/pkg` state.

## Gap Analysis

### Existing assets and missing capabilities
| Requirement area | Reusable asset | Gap |
|---|---|---|
| Package and hosts | Shared overlays, two HM imports, flake checks | Pi input/module/package and two-host enablement are missing |
| Wrapper/config | OpenCode wrapper-command and nono-launcher patterns | Pi needs a new locked, provenance-aware JSON reconciler |
| Shopify providers | Static OpenCode catalog and `devx llm-gateway` preflight | Pi base-URL composition and provider smoke tests are missing |
| Sandbox | `pkgs.nono`, OpenCode profile renderer and tests | Existing renderer is OpenCode-specific; Pi profiles are missing |
| MCP | Shared mcpproxy module and endpoint | Pi adapter config, direct surface gate, and Pi instructions are missing |
| Cavemem | Package, data directory, MCP upstream, OpenCode plugin | Pi lifecycle bridge and capture smoke tests are missing |
| Extensions | Nix package/overlay and Node test conventions | Every selected extension closure and combined load test is missing |
| Subprocess safety | nono audit/enforced rollout pattern | Credential inheritance, PTY/LSP/child cleanup need new controls |
| Acceptance | HM render tests and launcher stub tests | Pi provider, TUI, MCP, lifecycle, and two-host runtime tests are missing |

### Implementation options
- **Extend pi.nix**: contribute wrapper/config fixes upstream and consume them.
  Small local surface, but blocked by upstream cadence and project-specific
  provider, sandbox, and Cavemem behavior.
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

### Cavemem privacy blocker
- **Context**: Task 3.2 tried to redact secrets from arbitrary free text by
  recognizing JSON, YAML, environment, shell, URI, PEM, and source-like forms.
- **Findings**: Added grammars repeatedly fixed one leak while creating another
  false positive. Leaks included short authorization values, URL userinfo,
  escaped/unquoted keys, shell assignments, and malformed regions. False
  positives included TypeScript declarations, path-adjacent URL text, and benign
  code. The blocked patch also coupled redaction, retrieval, and embedding work.
- **Implications**: The Pi bridge removes exact runtime values before transport.
  Cavemem recurses over real objects, strips private regions, and applies only a
  finite lexical rule set to opaque strings. It does not parse string leaves as
  embedded languages. Raw retrieval and embedding exclusion form an independent
  storage-policy unit.

### Implementation continuity
- Package Tasks 1.1–1.5 already establish the pinned Pi package, deterministic
  harness, Undici remediation, context recovery, and extension closure.
- Cavemem Task 3.1 already establishes the closed canonical envelope, explicit
  `pi-full-v1` mode, uncompressed insertion flags, and default-mode byte parity.
- The uncommitted Task 2.1 and 3.2 implementations demonstrate why the old
  contracts failed; their scanner details do not constrain the replacement.
- No requirement, Cavemem schema, default hook path, provider count, or extension
  scope changes in this revision.

## Architecture Pattern Evaluation

| Option | Strength | Limitation | Decision |
|---|---|---|---|
| Free-form provider fields plus scanners | Flexible | Equivalent credential channels remain representable | Rejected |
| Closed provider-role and resolver catalogs | Invalid credential-bearing forms have no input shape | New roles require reviewed module changes | Selected |
| Opaque role contract | Closed names with hidden behavior | Tasks must invent routes, headers, and model policy | Rejected |
| Explicit catalog plus persisted/runtime split | Complete behavior and stable concurrent files | Catalog changes require review | Selected |
| Universal free-text privacy parser | Attempts broad leak coverage | Unbounded language ambiguity and false positives | Rejected |
| Structured recursion plus finite lexical rules | Testable leak and false-positive boundary | Opaque embedded languages are intentionally not parsed | Selected |
| Combined redaction/retrieval/embedding patch | One delivery unit | Hides independent failure and review seams | Split by responsibility |

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
- **Credential seam**: root/child Pi alone receive actual provider values;
  other subprocesses are scrubbed and the Capture Bridge redacts exact values.
- **Capture seam**: Cavemem recurses over canonical object values by normalized
  sensitive keys, strips private regions, and applies finite authorization,
  provider-token, JWT, PEM, and lexical URL-userinfo rules to opaque strings.
- **Storage seam**: full-mode raw retrieval and embedding exclusion are separate
  from redaction. Compression state remains the embedding eligibility boundary.
- **Preserved seams**: the six-tool mcpproxy adapter, standalone nono profiles,
  fixed-lock extension closure, and provenance-aware reconciliation remain as
  previously designed.
- **Simplifications**: no arbitrary providers, headers, resolver plugins,
  extension ecosystem, embedded-language privacy parser, Sieve, private Shopify
  extension, exact `devx pi` parity, schema change, or cross-host state sync.

## Risks & Mitigations
- A fixed Shopify route or request policy drifts: revalidate every role against
  the switched-host protocol gate before rollout.
- Concurrent base resolution disagrees under one generation: fail projection
  reconciliation rather than allow last-writer-wins provider state.
- A runtime credential has no known lexical form: bridge exact-value redaction
  remains authoritative before transport.
- An opaque string contains an unrelated secret in embedded syntax: callers must
  send structured data or use `<private>`; tests lock this documented boundary.
- A new provider, resolver, or lexical rule is needed: require a module/design
  review and explicit revalidation rather than an escape hatch.
- Full rows approach SQLite limits and duplicate into FTS: expose database growth
  and active limits in status and validation.

## References
- Pi `v0.83.0` and `pi.nix` `1d37b586` provider/configuration contracts.
- Cavemem `v0.2.1` hook, storage, retrieval, worker, and MCP paths.
- Repository `configurations/shopify/home-manager/opencode.nix` for current
  gateway integration roles.
- `tasks.md` implementation notes for completed Tasks 1.1–1.5 and 3.1; blocked
  partial code is failure evidence only.
