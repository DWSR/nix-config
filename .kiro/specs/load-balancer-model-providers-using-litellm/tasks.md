# Implementation Plan

The catalog lands first because it is the only source of the served ids and of
both client projections; every later unit consumes it. Session identity follows
as pure rules and then the in-process hook, because the gateway packaging step
needs both modules. The gateway then consumes the catalog, splits its routing
policy into placement/affinity and failover, and packages the bridge into the
generated config directory. Both client surfaces move to the catalog ids in the
same change — a partially updated client would call a removed id — and the
guest-eval assertion is rewritten with them. Deterministic checks and the
operator docs close the loop, and the final integration unit verifies the whole
set before the guest rebuild.

## Tasks

- [ ] 1. Deployment catalog
- [ ] 1.1 Create `configurations/fabro-vm/litellm-catalog.nix` with the provider and logical-model tables
  - Declare providers `chatgpt` (prefix `chatgpt/`, no base URL or key var, allowlist `reasoning_effort`, no client-session-header requirement), `opencode-go` (`openai/`, `https://opencode.ai/zen/go/v1`, `OPENCODE_API_KEY`, requires the header), and `opencode-zen` (`openai/`, `https://opencode.ai/zen/v1`, `OPENCODE_API_KEY`, requires the header).
  - Declare the ten logical models and eleven deployments from the design's Initial Logical Model table, with `requestDefaults`, limits, weights, display names that drop the provider parenthetical, Fabro effort levels, and `smallDefault` on `deepseek-v4.1-flash`; `gpt-6-luna` is the only two-deployment group and both of its deployments pin `reasoning_effort = "xhigh"`.
  - Keep the module pure data: no host paths, secrets, or derivations; credentials appear only as environment-variable names, and the table default is `deepseek-v4.1-flash`.
  - Observable: `nix eval` of the exported table reports 10 logical ids, 11 deployments, one two-deployment group, and no `/` in any id.
  - _Requirements: 1.1, 1.3, 1.5, 2.1, 2.7, 3.2, 7.1_

- [ ] 1.2 Add catalog validation and export the pure `mkCatalog` constructor
  - Fail evaluation on a missing required field (`provider`, `upstreamModel`, `mode`, `limits.contextTokens`, `limits.maxOutputTokens`), a deployment naming an unknown provider, a group with zero deployments, a duplicate logical or deployment id, an id containing `/` or a provider key token, and a default model that is not a logical model; default `requestDefaults` to `{ }`, `weight` to `1`, and `displayName` to the id.
  - Fail on group disagreement over `mode`, `requestDefaults`, `limits.contextTokens`, or `limits.maxOutputTokens`, naming the logical model, both deployment ids, and the field, using the design's `litellm-catalog: ...` message shape.
  - Export `mkCatalog` for fixture tables and run validation before constructing any projection.
  - Observable: a fixture omitting `limits.contextTokens` fails naming the deployment and field, and a two-deployment fixture with differing `mode` fails naming both deployment ids.
  - _Requirements: 1.2, 1.4, 1.8, 2.4, 2.5, 2.6, 8.3, 8.6_

- [ ] 1.3 Generate the gateway `modelList`, `forwardClientHeaders`, and catalog metadata
  - Emit one entry per deployment, ordered by sorted logical id then deployment order, with `model_name` = logical id, `model_info.id` = `<logical>@<provider>`, mode and token limits, and `litellm_params` combining the provider prefix, upstream id, `api_base`/`api_key` only when the provider declares them, the deployment's request defaults, the provider allowlist, and an explicit `weight`.
  - Emit `forwardClientHeaders` as the sorted logical ids whose deployment set contains a provider with `requiresClientSessionHeader = true`, plus `maxGroupSize` and sorted `logicalIds`.
  - Preserve provider-field omission instead of emitting nulls, and keep projection output identical across repeated evaluations.
  - Observable: `nix eval` shows 11 entries with unique `model_info.id`s and an explicit weight of `1`, the 7-id forwarding list (`gpt-6-luna`, `deepseek-v4.1-flash`, `glm-5.3-flash`, `beam-free`, `omen-alpha`, `longcat-2.0`, `big-pickle`), `maxGroupSize = 2`, and byte-identical output twice.
  - _Requirements: 1.6, 2.2, 2.3, 2.7, 2.8, 3.2, 5.9, 7.1, 7.2, 7.3, 7.6_

- [ ] 1.4 Generate the OpenCode and Fabro client projections
  - Produce `openCode = { defaultModel, models }` keyed by logical id with `{ name = displayName; }`, and `fabro = { defaultModel, models }` keyed by logical id with `display_name`, `api_model` = the logical id, `limits` from the deployment set, and `capabilities` = the `text`/`tools`/`reasoning` baseline plus the effort-level map (omitted when empty), forced `caching`/`cache_routing` true, and `small_default` when declared.
  - Use the table default for both surfaces and never expose a provider prefix, base URL, or key variable in either projection.
  - Observable: `nix eval` shows the same 10 keys on both surfaces, every Fabro record with `api_model` equal to its key and both capability flags true, and no `/` in any projected id.
  - _Requirements: 2.2, 2.8, 6.1, 6.2, 6.5, 6.8, 6.10_

- [ ] 2. Session identity
- [ ] 2.1 Implement the pure resolver `configurations/fabro-vm/litellm_session_identity.py`
  - `existing_session_id(metadata_dicts)` returns the first non-empty stringified `session_id`, else `None`; `producer_tag(user_agent)` takes the product token before `/`, lowercases it, keeps `[a-z0-9._-]` up to 32 characters, and falls back to `unknown`.
  - `derive_session_identity(prompt_cache_key, user_agent)` returns `None` unless the key is a string that is non-empty after stripping, at most 512 characters, and free of CR, LF, and NUL; otherwise it returns `bridge:v1:<producer>:<sha256 hex of the stripped key>`.
  - `resolve_session_identity(...)` returns a `Resolution(session_id, source)` with `source` `"header"` for a pre-existing metadata id and `"body"` for a derived id, checking metadata first; import only the standard library and never raise.
  - Observable: importing the module from `PYTHONPATH=configurations/fabro-vm` shows a `ses_...` id winning over a body key, the same key under `fabro` and `other` yielding different ids, and non-string, blank, 513-character, and CR-bearing keys yielding `None`.
  - _Requirements: 4.2, 4.4, 4.5, 4.6, 6.9, 8.7_

- [ ] 2.2 Implement the in-process bridge `configurations/fabro-vm/litellm_affinity_bridge.py`
  - `SessionIdentityBridge(CustomLogger).async_pre_call_hook` returns `data` unchanged when `metadata` or `litellm_metadata` already carries a session id; otherwise it reads the case-insensitive request `user-agent`, derives an identity with the resolver, removes `prompt_cache_key` from the outbound body and `proxy_server_request.body`, and writes the derived id to `metadata` (creating it when absent) and to `litellm_metadata` when present.
  - Drop a malformed or unusable key without adding an identity, never raise on a missing metadata, header, or unexpected body shape, and export `proxy_handler_instance`.
  - Observable: under the pinned LiteLLM interpreter, a synthetic pre-call `data` dict carrying only a body `prompt_cache_key` gains a `bridge:v1:` `metadata.session_id` and loses the key, while one whose metadata already carries a header-derived id is returned unchanged.
  - _Requirements: 4.3, 4.4, 4.5, 4.9, 4.10, 4.11, 8.7_
  - _Depends: 2.1_

- [ ] 3. Gateway configuration
- [ ] 3.1 Make `configurations/fabro-vm/litellm.nix` consume the catalog
  - Replace the hand-written `chatgpt/`/`opencode-go/`/`opencode-zen/` `model_list` with `catalog.modelList` and the `opencode-go/*`/`opencode-zen/*` prefix forwarding list with `catalog.forwardClientHeaders`; add no aliases, wildcards, or provider-scoped ids.
  - Keep `environmentFile`, `CHATGPT_TOKEN_DIR`, the health gate, the login wrapper, and the `os.environ/OPENCODE_API_KEY` references untouched, and rewrite the module header comment so it describes catalog sourcing, group-scoped forwarding, and the forwarded allowlist instead of provider-prefixed groups.
  - Observable: `nix eval` of the guest's `services.litellm.settings` shows the 11 catalog entries and 7-id forwarding list, and no provider-scoped model id or `opencode-go/*` glob remains in the module.
  - _Requirements: 1.7, 2.7, 2.8, 3.5, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
  - _Depends: 1.3_

- [ ] 3.2 Add weighted placement and session-affinity router settings
  - Set `routing_strategy = "simple-shuffle"`, `optional_pre_call_checks = [ "session_affinity" ]`, and `deployment_affinity_ttl_seconds = 21600`; leave `deployment_affinity`, `rpm`, and `tpm` unset so placement uses weights plus deployment availability only.
  - Comment that pins are in-process, keyed by logical model and session identity, refreshed on every routed request, and cleared by a gateway restart (which also restarts Fabro).
  - Observable: `nix eval` of the guest's `router_settings` shows exactly the three values with the six-hour TTL, and none of `deployment_affinity`, `rpm`, `tpm`.
  - _Requirements: 3.1, 3.3, 3.4, 3.7, 4.1, 4.7, 4.8, 4.9, 4.12_
  - _Depends: 1.3_

- [ ] 3.3 Add within-group failover and cooldown router settings
  - Set `num_retries = 0`, `enable_weighted_failover = true`, `allowed_fails = 0`, `cooldown_time = 60`, and `max_fallbacks = catalog.maxGroupSize - 1` derived from the catalog.
  - Declare no `fallbacks`, `context_window_fallbacks`, or `model_group_alias`, so a retry never crosses a logical model and the attempt count stays bounded by the largest group.
  - Observable: `nix eval` shows the five values with `max_fallbacks = 1`, none of the three fallback keys present, and a third `gpt-6-luna` deployment re-evaluating to `max_fallbacks = 2`.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - _Depends: 1.3_

- [ ] 3.4 Package the bridge with the gateway config and point the service at it
  - Build a `runCommand "litellm-config"` directory holding `config.yaml` rendered from `config.services.litellm.settings` through `pkgs.formats.yaml`, `litellm_affinity_bridge.py`, and `litellm_session_identity.py`, and register `litellm_settings.callbacks = [ "litellm_affinity_bridge.proxy_handler_instance" ]`.
  - Override `systemd.services.litellm.serviceConfig.ExecStart` with `lib.mkForce` to the module's `litellm --host <host> --port <port> --config <dir>/config.yaml` shape, and add `PYTHONPATH` = the directory plus `PYTHONDONTWRITEBYTECODE = "1"` to `services.litellm.environment`.
  - Observable: `nix eval` shows the overridden `ExecStart` and `PYTHONPATH` naming the generated directory, `callbacks` naming the bridge instance, and the guest still evaluating with the existing `DynamicUser` unit and health gate.
  - _Requirements: 4.11_
  - _Depends: 2.2, 3.2, 3.3_

- [ ] 4. Client surfaces
- [ ] 4.1 (P) Point OpenCode at the catalog model map
  - Set `model = "opencode-litellm/${catalog.openCode.defaultModel}"` and `provider.opencode-litellm.models = catalog.openCode.models`; keep the provider id, `npm`, `baseURL`, and `apiKey` unchanged.
  - Add no `options.headers`, and rewrite the provider comment so forwarding is described as group-scoped and the session header as OpenCode's own.
  - Observable: the generated `opencode.json` lists each of the 10 logical ids once, defaults to `opencode-litellm/deepseek-v4.1-flash`, has no provider `headers` key, and contains no `chatgpt/`, `opencode-go/`, or `opencode-zen/` literal.
  - _Requirements: 6.1, 6.3, 6.5, 6.6, 6.10_
  - _Boundary: OpenCode Model Surface_
  - _Depends: 1.4_

- [ ] 4.2 (P) Point Fabro at the catalog model records
  - Set `llm.providers.litellm.models = catalog.fabro.models` and derive `llm.providers.litellm.default_model`, `cli.exec.model.name`, and `run.model.name` from `catalog.fabro.defaultModel`.
  - Delete the `go-gpt-6-luna` record and re-key `go-beam-free`/`go-omen-alpha` to `beam-free`/`omen-alpha`, and keep `default_headers."x-opencode-session" = "fabro-litellm"` with a comment that the upstream requirement is not the affinity identity and that Fabro's `prompt_cache_key` is.
  - Observable: the generated `settings.toml` has 10 model records whose `api_model` equals their key, each with `caching` and `cache_routing` true and limits matching the catalog, and no `go-` key or provider-prefixed `api_model` remains.
  - _Requirements: 6.2, 6.4, 6.5, 6.7, 6.8, 6.9, 6.10_
  - _Boundary: Fabro Model Surface_
  - _Depends: 1.4_

- [ ] 5. Repository checks
- [ ] 5.1 (P) Create the routing test harness and the catalog suite
  - Add `tests/litellm-routing/{helpers.js,package.json,catalog.test.js}` reusing the `nixEvalJson`/`nixEvalFailure` pattern from `tests/litellm-service/helpers.js`, with a `main` field so `node --test` loads the directory.
  - Assert through `mkCatalog` fixtures that disagreeing `mode`, `requestDefaults`, `contextTokens`, or `maxOutputTokens`, a missing required field, an empty group, an unknown provider, a `/` or provider-token id, a duplicate id, and an invalid default model each fail with a message naming the logical model, the deployment, and the field.
  - Assert the real catalog weights every deployment, defaults a missing weight to `1`, and returns identical projections across two evaluations.
  - Observable: `node --test tests/litellm-routing/` passes the catalog suite, and a fixture edited to drop `limits.contextTokens` produces the documented error text.
  - _Requirements: 2.4, 2.5, 2.6, 8.3, 8.6_
  - _Boundary: tests/litellm-routing/catalog.test.js_
  - _Depends: 1.2_

- [ ] 5.2 (P) Add the gateway configuration suite
  - Assert `model_list` equals `catalog.modelList` with 11 entries, a unique `model_info.id` per entry, and an explicit weight, that `router_settings` matches the documented table including the derived `max_fallbacks`, and that `deployment_affinity` plus every fallback and alias key is absent.
  - Assert forwarding equals `catalog.forwardClientHeaders`, `callbacks` names the bridge instance, and the overridden `ExecStart` plus `PYTHONPATH` name the generated config directory.
  - Render `config.services.litellm.settings` through current-system `pkgs.formats.yaml` and fail when any present `api_key` is not `os.environ/...` or the text contains `sk-` or a sops placeholder, naming the offending logical model.
  - Observable: the gateway suite passes, and a fixture settings value carrying a literal `sk-test` key fails with the offending logical model named.
  - _Requirements: 2.7, 5.9, 7.4, 7.5, 8.2, 8.5, 8.6_
  - _Boundary: tests/litellm-routing/gateway.test.js_
  - _Depends: 3.4, 5.1_

- [ ] 5.3 (P) Add the client parity and legacy-id suite
  - Assert both client projections expose exactly the catalog ids, each surface's default model is a served logical id, and every Fabro record sets `caching`/`cache_routing` with limits equal to the catalog.
  - Scan `configurations/fabro-vm/opencode.nix` and `configurations/fabro-vm/fabro.nix` for provider-scoped literals (`chatgpt/`, `opencode-go/`, `opencode-zen/`) and old Fabro keys (`go-gpt-6-luna`, `go-beam-free`, `go-omen-alpha`), failing with the file path and matched string.
  - Observable: the suite passes, and reintroducing `api_model = "opencode-go/deepseek-v4.1-flash"` fails the legacy-id scan naming the file and id.
  - _Requirements: 6.9, 8.1, 8.4, 8.6_
  - _Boundary: tests/litellm-routing/clients.test.js_
  - _Depends: 4.1, 4.2, 5.1_

- [ ] 5.4 (P) Add `tests/litellm-affinity-bridge/test_session_identity.py`
  - Cover header precedence over a body key, producer-scoped namespacing of the same raw key, `None` for an absent key, `None` for non-string, blank, over-512-character, and CR/LF/NUL-bearing keys, and a `bridge:v1:` result never equalling a `ses_...` header value.
  - Import the resolver through `PYTHONPATH=configurations/fabro-vm` using only the standard library and `unittest`.
  - Observable: `PYTHONPATH=configurations/fabro-vm python3 -m unittest discover -s tests/litellm-affinity-bridge` reports 5 passing tests.
  - _Requirements: 4.5, 4.6, 4.10, 8.7_
  - _Boundary: tests/litellm-affinity-bridge/_
  - _Depends: 2.1_

- [ ] 5.5 Register the `litellm-routing` and `litellm-affinity-bridge` flake checks
  - Add `checks.<system>.litellm-routing` as a `runCommand` with `nativeBuildInputs = [ pkgs.nix pkgs.nodejs ]` that copies the source, exports `HOME` and `NIX_CONFIG`, and runs `node --test tests/litellm-routing/`, mirroring the `litellm-service` check.
  - Add `checks.<system>.litellm-affinity-bridge` as a `runCommand` with `pkgs.python3` that copies the source, exports `PYTHONPATH=configurations/fabro-vm`, and runs the unittest suite.
  - Observable: both checks build green, and each fails when a deliberate assertion or namespacing expectation is inverted.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7_
  - _Depends: 5.1, 5.2, 5.3, 5.4_

- [ ] 6. Rewrite the `fabro-vm-guest-eval` litellm assertion
  - Replace the Go-free-model assertion in `flake.nix` (currently keyed on `opencode-go/beam-free`, `opencode-go/omen-alpha`, `opencode-go/longcat-2.0`, and the `opencode-go/*`/`opencode-zen/*` forwarding globs) with one that asserts the catalog shape.
  - Assert every `model_list` entry's `model_name` is a provider-free logical id, `model_info.id` is unique and of the form `<logical>@<provider>`, every entry carries an integer weight, and the forwarding list equals the 7 ids whose deployment set includes an OpenCode provider.
  - Keep the surrounding credential, env-template, and restart-unit assertions untouched and make the failure message name the offending model.
  - Observable: `nix eval .#nixosConfigurations.fabro-vm` succeeds, and mutating one entry to `model_name = "opencode-go/beam-free"` fails the assertion naming it.
  - _Requirements: 1.1, 1.3, 2.2, 7.1, 7.6_
  - _Depends: 3.1_

- [ ] 7. Operator documentation
- [ ] 7.1 (P) Write `docs/litellm-routing-runbook.md`
  - Document how to add a provider, logical model, deployment, or weight in `litellm-catalog.nix`; where weights, `deployment_affinity_ttl_seconds`, `cooldown_time`, `num_retries`, and `max_fallbacks` live; and that `x-litellm-model-id` names `<logical>@<provider>` on each response.
  - State the forwarded-header allowlist (`x-*` except `x-stainless-*`, plus `anthropic-beta`), the session-identity rules (header precedence, `bridge:v1:<producer>:<sha256>` for body keys, the stable-`User-Agent` requirement, pins cleared by restart), and that 1.86.0 fails over on transport errors without entering cooldown.
  - Document the three smoke steps — 20 fresh sessions for weight share, one repeated session across OpenCode's header and Fabro's body key for pin stability, and a forced failure by pointing the `opencode-go` `apiBase` at `http://127.0.0.1:9/v1` then reverting — each with its expected observation.
  - Observable: the runbook carries all three steps with expected observations and uses no provider-scoped model id in any instruction.
  - _Requirements: 3.6, 7.5, 8.8, 8.9_
  - _Boundary: docs/litellm-routing-runbook.md_
  - _Depends: 3.3_

- [ ] 7.2 (P) Update `docs/opencode-fabro-vm-handoff.md` to the catalog ids
  - Replace the OpenCode model map, the Fabro model table, the header-forwarding section, the default-model examples, and the "add a model" steps with the catalog ids and group-scoped forwarding.
  - Explain the three session-identity sources (OpenCode's `x-opencode-session-id`, Fabro's bridged `prompt_cache_key`, and the static `x-opencode-session` not being an identity) and that the gateway and both clients move together.
  - Observable: `rg 'chatgpt/|opencode-go/|opencode-zen/' docs/opencode-fabro-vm-handoff.md` returns no model-id occurrence, with any historical note explicitly labelled as history.
  - _Requirements: 6.9, 6.10, 8.10_
  - _Boundary: docs/opencode-fabro-vm-handoff.md_
  - _Depends: 1.4_

- [ ] 7.3 (P) Retire the superseded spec directory
  - Delete `.kiro/specs/configure-litellm-load-balancing-across-existing/` so no current spec document or task instructs a provider-scoped model call.
  - Observable: `rg 'opencode-go/|chatgpt/' .kiro/specs/ --glob '*.md'` reports hits only under `load-balancer-model-providers-using-litellm/`, and the directory is gone.
  - _Requirements: 8.10_
  - _Boundary: .kiro/specs/configure-litellm-load-balancing-across-existing/_

- [ ] 8. Verification
- [ ] 8.1 Run the full deterministic verification set
  - Build `litellm-routing`, `litellm-affinity-bridge`, and the existing `litellm-service` checks, and evaluate `fabro-vm-guest-eval`, `nixosConfigurations.fabro-vm`, and the `opencode`/`fabro` guest settings.
  - Confirm the macOS Home Manager `programs.litellm` render tests still pass unchanged, no source file still names a removed provider-scoped id, and the generated config directory contains only `config.yaml` and the two Python modules.
  - Observable: all three checks build green in one pass, the guest evaluation succeeds, and `rg` over `configurations/fabro-vm/` and `docs/` finds no removed id outside an explicitly labelled historical note.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.10_
  - _Depends: 4.1, 4.2, 5.5, 6, 7.2, 7.3_

- [ ]* 8.2 Execute the operator smoke after the guest rebuild
  - Rebuild the guest, confirm LiteLLM and Fabro restart together, then run the three runbook steps and record the observed `x-litellm-model-id` values.
  - Post-deploy verification only: requirement 8.8 is satisfied by 7.1's documented procedure, so this unit can be deferred without blocking implementation.
  - Observable: the recorded observations show both `gpt-6-luna@chatgpt` and `gpt-6-luna@opencode-go` across 20 fresh sessions, one stable deployment inside a conversation, and a successful sibling response during the forced failure.
  - _Requirements: 3.6, 4.8, 5.5, 8.8_
  - _Depends: 8.1_
