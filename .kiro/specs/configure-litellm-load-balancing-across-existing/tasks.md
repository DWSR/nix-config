# Implementation Plan

The catalog lands first because it is the single source of the served ids and
of both client projections; every later unit consumes it. Session identity
follows (pure rules, then the in-process hook), then the gateway consumes the
catalog and wires the router and the bridge, then the two client surfaces move
to the catalog ids in the same change (a partially updated client would call a
removed id). Deterministic checks and the operator docs close the loop, and a
final integration unit verifies the whole set before the guest rebuild.

## Tasks

- [ ] 1. Deployment catalog
- [x] 1.1 Create `configurations/fabro-vm/litellm-catalog.nix` with the provider and logical-model tables
  - Declare providers `chatgpt` (prefix `chatgpt/`, no base URL or key var, allowlist `reasoning_effort`, no client-session-header requirement), `opencode-go` (`openai/`, `https://opencode.ai/zen/go/v1`, `OPENCODE_API_KEY`, requires the header), and `opencode-zen` (`openai/`, `https://opencode.ai/zen/v1`, `OPENCODE_API_KEY`, requires the header).
  - Declare the eight logical models with the deployments, modes, request defaults, limits, and weights from the design's Initial Catalog: `gpt-6-luna` is the only two-deployment group, and the table carries the default model `deepseek-v4.1-flash`.
  - Keep the module pure data: no host paths, secrets, or derivations; credentials appear only as environment-variable names.
  - Observable: `nix eval` of the module's exported table reports 8 logical models, 9 deployments, and one provider-free id per logical model.
  - _Requirements: 1.1, 1.3, 1.5, 2.1, 2.7_

- [x] 1.2 Add catalog validation and export the pure `mkCatalog` constructor
  - Fail evaluation on a missing required field, a deployment naming an unknown provider, and a group with zero deployments, using the design's `litellm-catalog: deployment '<id>' is missing field '<field>'` shape and naming the entry.
  - Fail on an id containing `/` or a provider key token, on a duplicate `model_info.id`, and on group disagreement over `mode`, `requestDefaults`, `contextWindow`, or `maxOutputTokens`, naming the logical model, both deployments, and the field.
  - Export `mkCatalog` so fixture tables can be evaluated in tests, and run validation before returning any projection.
  - Observable: a fixture table missing `contextWindow` fails with `missing field 'contextWindow'`, and a two-deployment fixture with differing `mode` fails naming both deployment ids.
  - _Requirements: 1.2, 1.4, 1.7, 2.3, 2.4, 2.5, 8.6_

- [ ] 1.3 Generate the gateway `modelList` and `forwardClientHeaders` projections
  - Emit one `model_list` entry per deployment, ordered by sorted logical id then deployment order, with `model_name` = logical id, `model_info.id` = `<logical>@<provider>`, the mode and token limits, `litellm_params` combining the provider prefix, upstream id, base URL and key variable when declared, request defaults, and the provider allowlist, plus an explicit numeric `weight` defaulting to `1`.
  - Emit `forwardClientHeaders` as the sorted logical ids whose provider set includes `requiresClientSessionHeader = true`.
  - Observable: `nix eval` shows 9 entries with unique `model_info.id`s and a weight on every entry, the 5-id forwarding list (`gpt-6-luna`, `deepseek-v4.1-flash`, `glm-5.3-flash`, `longcat-2.5-preview-free`, `big-pickle`), and identical output when evaluated twice.
  - _Requirements: 1.3, 2.2, 3.2, 7.3_

- [ ] 1.4 Generate the OpenCode and Fabro client projections
  - Produce `opencode = { defaultModel, models }` keyed by logical id with the display name, and `fabro = { defaultModel, models }` keyed by logical id with `display_name`, `api_model` = the logical id, `limits` from the group, `capabilities` = the `text`/`tools`/`reasoning` baseline plus mapped `reasoningEffortLevels` and `fabroCapabilities`, `small_default` when declared, and forced `caching`/`cache_routing` = true.
  - Use the table-level default model for both surfaces, and never expose a provider prefix, base URL, or key variable in either projection.
  - Observable: `nix eval` shows the same 8 keys on both surfaces, every Fabro record with `caching`/`cache_routing` true and `api_model` equal to its key, and no `/` in any projected id.
  - _Requirements: 2.2, 6.1, 6.2, 6.5, 6.7, 6.9_

- [ ] 2. Session identity
- [ ] 2.1 Implement the pure resolver `configurations/fabro-vm/litellm_session_identity.py`
  - `existing_session_id(metadata_dicts)` returns the first non-empty `session_id`, else `None`; `producer_tag(user_agent)` takes the product token before `/`, lowercases it, keeps `[a-z0-9._-]` up to 32 characters, and falls back to `unknown`.
  - `derive_session_identity(prompt_cache_key, user_agent)` returns `None` unless the key is a stripped non-empty string of at most 512 characters without CR, LF, or NUL; otherwise it returns `bridge:v1:<producer>:<sha256 hex of the stripped key>`.
  - Import only the Python standard library, never raise, and never produce a value shaped like a client session id.
  - Observable: `PYTHONPATH=configurations/fabro-vm python3 -c ...` shows `ses_...` winning over a body key, the same key under `fabro` and `other` yielding different ids, and non-string, blank, 513-character, and CR-bearing keys yielding `None`.
  - _Requirements: 4.2, 4.3, 4.4, 4.5, 6.8_

- [ ] 2.2 Implement the in-process bridge `configurations/fabro-vm/litellm_affinity_bridge.py`
  - `SessionIdentityBridge(CustomLogger).async_pre_call_hook` returns `data` unchanged when `metadata` or `litellm_metadata` already carries a session id; otherwise it removes `prompt_cache_key` from the outbound body and `proxy_server_request.body`, derives an identity with the resolver from the request `user-agent` (case-insensitive lookup), and writes it to `metadata` and `litellm_metadata` when present.
  - Drop a malformed key without an identity, never raise on missing metadata, headers, or an unexpected body shape, and export `proxy_handler_instance`.
  - Observable: under the pinned LiteLLM interpreter, a synthetic request carrying only `prompt_cache_key` gains `metadata.session_id` and loses the key, while one with a header-derived `session_id` is returned unchanged.
  - _Requirements: 4.3, 4.4, 4.5, 4.9, 4.11, 6.6_
  - _Depends: 2.1_

- [ ] 3. Gateway configuration
- [ ] 3.1 Make `configurations/fabro-vm/litellm.nix` consume the catalog
  - Replace the hand-written chatgpt/opencode-go/opencode-zen `model_list` with `catalog.modelList` and the prefix forwarding list with `catalog.forwardClientHeaders`; leave `environmentFile`, `CHATGPT_TOKEN_DIR`, the health gate, and the login wrapper untouched.
  - Rewrite the module header comment so it describes catalog sourcing and group-scoped forwarding instead of provider-scoped ids and prefix matching.
  - Observable: `nix eval` of the guest's `services.litellm.settings` shows the catalog's 9 entries and 5-id forwarding list, and no provider-scoped model id or `opencode-go/*`/`opencode-zen/*` literal remains in the module.
  - _Requirements: 1.6, 2.2, 2.6, 2.7, 3.5, 7.1, 7.2, 7.3, 7.6_
  - _Depends: 1.3_

- [ ] 3.2 Add weighted placement and session-affinity router settings
  - Set `routing_strategy = "simple-shuffle"`, `optional_pre_call_checks = [ "session_affinity" ]`, and `deployment_affinity_ttl_seconds = 21600`; leave `deployment_affinity` and any `rpm`/`tpm` unset so placement uses weights plus router availability only.
  - Comment that pins are in-process and keyed by logical model and session identity, so a gateway restart clears them.
  - Observable: `nix eval` of the guest's `router_settings` shows the three values, `deployment_affinity` absent, and no request-rate or token-rate field.
  - _Requirements: 3.1, 3.3, 3.4, 4.1, 4.6, 4.7, 4.8, 4.10_

- [ ] 3.3 Add within-group failover and cooldown router settings
  - Set `num_retries = 0`, `enable_weighted_failover = true`, `allowed_fails = 0`, `cooldown_time = 60`, and `max_fallbacks = max(largest group size - 1, 0)` derived from the catalog (currently `1`).
  - Declare no `fallbacks`, `context_window_fallbacks`, or `model_group_alias`, so no request crosses a logical model and removed ids fail as unknown models.
  - Observable: `nix eval` shows the five values with `max_fallbacks = 1` and none of the three fallback keys present; adding a third `gpt-6-luna` deployment re-evaluates to `max_fallbacks = 2`.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

- [ ] 3.4 Package the bridge with the gateway config and point the service at it
  - Build a `runCommand "litellm-config"` directory holding `config.yaml` rendered from `services.litellm.settings`, `litellm_affinity_bridge.py`, and `litellm_session_identity.py`, and register `litellm_settings.callbacks = [ "litellm_affinity_bridge.proxy_handler_instance" ]`.
  - Override `systemd.services.litellm.serviceConfig.ExecStart` with `lib.mkForce` to the module's `litellm --host <host> --port <port> --config <dir>/config.yaml` shape, and set `PYTHONPATH` to the directory plus `PYTHONDONTWRITEBYTECODE = "1"` in `services.litellm.environment`.
  - Observable: `nix eval` shows the overridden `ExecStart` and `PYTHONPATH` naming the generated directory, `callbacks` naming the bridge, and the guest still evaluating with the existing `DynamicUser` and health-gate wiring.
  - _Requirements: 2.6, 4.11_
  - _Depends: 2.2, 3.2, 3.3_

- [ ] 4. Client surfaces
- [ ] 4.1 (P) Point OpenCode at the catalog model map
  - Set `model = "opencode-litellm/${catalog.opencode.defaultModel}"` and `provider.opencode-litellm.models = catalog.opencode.models`; keep the provider id, `npm`, `baseURL`, and `apiKey` unchanged.
  - Add no `options.headers`, and update the header comment so forwarding is described as group-scoped rather than keyed on the old provider prefixes.
  - Observable: the generated `opencode.json` lists each logical id once, defaults to `opencode-litellm/deepseek-v4.1-flash`, has no provider `headers` key, and contains no `chatgpt/`, `opencode-go/`, or `opencode-zen/` literal.
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.9_
  - _Boundary: OpenCode Model Surface_
  - _Depends: 1.4_

- [ ] 4.2 (P) Point Fabro at the catalog model records
  - Set `llm.providers.litellm.models = catalog.fabro.models`, and derive `default_model`, `cli.exec.model.name`, and `run.model.name` from `catalog.fabro.defaultModel`.
  - Delete the `go-gpt-6-luna` record, key the LongCat record `longcat-2.5-preview-free`, and keep `default_headers."x-opencode-session"` with a comment that it is not the affinity identity.
  - Observable: the generated `settings.toml` has 8 model records whose `api_model` equals their key, each with `caching` and `cache_routing` true and limits matching the catalog, and no provider-prefixed `api_model` or `go-gpt-6-luna` key.
  - _Requirements: 6.5, 6.6, 6.7, 6.8, 6.9_
  - _Boundary: Fabro Model Surface_
  - _Depends: 1.4_

- [ ] 5. Routing checks
- [ ] 5.1 (P) Create the routing test harness and the catalog suite
  - Add `tests/litellm-routing/{helpers.js,package.json,catalog.test.js}` reusing the `nixEvalJson`/`nixEvalFailure` pattern from `tests/litellm-service/helpers.js`.
  - Assert through `mkCatalog` fixtures that conflicting `mode`, `requestDefaults`, or `contextWindow`, a missing field, an empty group, a `/` or provider-prefixed id, and a duplicate deployment id each fail with a message naming the logical model, deployment, and field.
  - Assert the real catalog weights every deployment, defaults a missing weight to `1`, and returns identical projections across two evaluations.
  - Observable: `node --test tests/litellm-routing/` passes the catalog suite, and a fixture edited to drop `contextWindow` produces the documented error text.
  - _Requirements: 2.3, 2.4, 2.5, 8.3, 8.6_
  - _Boundary: tests/litellm-routing catalog suite_

- [ ] 5.2 (P) Add the gateway configuration suite
  - Assert `model_list` equals `catalog.modelList`, every entry carries an explicit weight and a unique `model_info.id`, `router_settings` matches the documented table including the derived `max_fallbacks`, `deployment_affinity` and the fallback keys are absent, and forwarding equals `catalog.forwardClientHeaders`.
  - Assert `callbacks` names the bridge and the overridden `ExecStart` and `PYTHONPATH` point at the generated directory; render the settings through current-system `pkgs.formats.yaml` and fail if an `api_key` is not `os.environ/...` or the text contains `sk-` or a sops placeholder.
  - Observable: the gateway suite passes, and a fixture settings value carrying a literal `sk-test` key fails with the offending logical model named.
  - _Requirements: 2.6, 5.9, 7.4, 8.2, 8.5, 8.6_
  - _Boundary: tests/litellm-routing gateway suite_
  - _Depends: 3.4, 5.1_

- [ ] 5.3 (P) Add the client parity and legacy-id suite
  - Assert both client projections expose exactly the catalog ids, each default model exists on its surface, and every Fabro record sets `caching`/`cache_routing` with limits equal to the catalog.
  - Scan `opencode.nix` and `fabro.nix` for provider-scoped literals (`chatgpt/`, `opencode-go/`, `opencode-zen/`, `go-gpt-6-luna`) and fail naming the file and matched string.
  - Observable: the suite passes, and reintroducing `api_model = "opencode-go/deepseek-v4.1-flash"` fails the legacy-id scan naming the file and id.
  - _Requirements: 6.9, 8.1, 8.4_
  - _Boundary: tests/litellm-routing client suite_
  - _Depends: 4.1, 4.2, 5.1_

- [ ] 5.4 Register the `litellm-routing` flake check
  - Add `checks.<system>.litellm-routing` as a `runCommand` with `nativeBuildInputs = [ pkgs.nix pkgs.nodejs ]` that copies the source, sets `HOME` and `NIX_CONFIG`, and runs `node --test tests/litellm-routing/`, mirroring the `litellm-service` check.
  - Observable: `nix build .#checks.<system>.litellm-routing` succeeds, and fails when a catalog assertion is deliberately broken.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6_
  - _Depends: 5.1, 5.2, 5.3_

- [ ] 6. Affinity bridge tests
- [ ] 6.1 (P) Add `tests/litellm-affinity-bridge/test_session_identity.py`
  - Cover header precedence over a body key, producer-scoped namespacing of the same raw key, `None` for an absent key, `None` for non-string/blank/over-512/control-character keys, and a `bridge:v1:` result never equalling a `ses_...` header value.
  - Import the module through `PYTHONPATH=configurations/fabro-vm` using only the standard library and `unittest`.
  - Observable: `PYTHONPATH=configurations/fabro-vm python3 -m unittest discover -s tests/litellm-affinity-bridge` reports 5 passing tests.
  - _Requirements: 4.5, 8.7_
  - _Boundary: tests/litellm-affinity-bridge_
  - _Depends: 2.1_

- [ ] 6.2 Register the `litellm-affinity-bridge` flake check
  - Add `checks.<system>.litellm-affinity-bridge` as a `runCommand` with `pkgs.python3` that copies the source, exports `PYTHONPATH=configurations/fabro-vm`, and runs the suite, so a failing test fails the check.
  - Observable: `nix build .#checks.<system>.litellm-affinity-bridge` succeeds, and fails when a namespacing expectation is inverted.
  - _Requirements: 8.7_
  - _Depends: 6.1_

- [ ] 7. Operator documentation
- [ ] 7.1 (P) Write `docs/litellm-routing-runbook.md`
  - Document how to add a provider, logical model, deployment, or weight in `litellm-catalog.nix`; where weights, `deployment_affinity_ttl_seconds`, `cooldown_time`, `num_retries`, and `max_fallbacks` live; and that `x-litellm-model-id` names `<logical>@<provider>` on each response.
  - State the forwarded-header allowlist (`x-*` except `x-stainless-*`, plus `anthropic-beta`), the session-identity rules (header precedence, `bridge:v1:<producer>:<sha256>` for body keys, the stable-`User-Agent` requirement, pins cleared by restart), and that transport errors fail over without entering cooldown on 1.86.0.
  - Document the three smoke steps — 20 new sessions for weight share, one repeated session for a stable deployment, and a forced failure by temporarily pointing the OpenCode Go `apiBase` at `http://127.0.0.1:9/v1` then reverting — each with its expected observation.
  - Observable: the runbook carries all three steps with expected observations and uses no provider-scoped model id in any instruction.
  - _Requirements: 3.6, 7.5, 8.8, 8.9, 8.10_
  - _Boundary: docs/litellm-routing-runbook.md_

- [ ] 7.2 (P) Update `docs/opencode-fabro-vm-handoff.md` to the catalog ids
  - Replace the OpenCode model map, the Fabro model table, the header-forwarding section, and the "add a model" instructions with the catalog ids and group-scoped forwarding.
  - Explain the three session-identity sources (OpenCode's header, Fabro's bridged `prompt_cache_key`, and the static `x-opencode-session` not being an identity) and that the gateway and both clients move together.
  - Observable: `rg 'chatgpt/|opencode-go/|opencode-zen/' docs/opencode-fabro-vm-handoff.md` returns no model-id occurrence, with any historical note explicitly labelled as history.
  - _Requirements: 6.9, 8.10_
  - _Boundary: docs/opencode-fabro-vm-handoff.md_

- [ ] 8. Verification
- [ ] 8.1 Run the full deterministic verification set
  - Build `litellm-routing`, `litellm-affinity-bridge`, the existing `litellm-service` and `fabro-sandbox-tests` checks, and evaluate `fabro-vm-guest-eval`.
  - Confirm no source file still names a removed provider-scoped id and that the macOS Home Manager render tests pass unchanged.
  - Observable: all four checks build green in one pass, the guest evaluation succeeds, and `rg` over `configurations/fabro-vm/` and `docs/` finds no removed id outside an explicitly labelled historical note.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.10_
  - _Depends: 4.1, 4.2, 5.4, 6.2, 7.2_

- [ ]* 8.2 Execute the operator smoke after the guest rebuild
  - Rebuild the guest, confirm LiteLLM and Fabro restart together, then run the three runbook steps and record the observed `x-litellm-model-id` values.
  - Post-deploy verification only: requirement 8.8 is satisfied by 7.1's documented procedure, so this unit can be deferred without blocking implementation.
  - Observable: the recorded observations show both `gpt-6-luna@chatgpt` and `gpt-6-luna@opencode-go`, one stable deployment across a conversation, and a successful sibling response during the forced failure.
  - _Requirements: 3.6, 5.1, 5.2, 8.8_
  - _Depends: 8.1_
