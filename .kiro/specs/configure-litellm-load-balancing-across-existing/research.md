# Research: configure-litellm-load-balancing-across-existing

## Summary

- **Feature**: Unified LiteLLM model groups with weighted placement, session
  affinity, and in-group failover for the fabro-vm gateway.
- **Discovery Scope**: Extension of an existing pinned deployment
  (`configurations/fabro-vm/litellm.nix`) with one new client-side bridge.
- **Key findings**:
  - LiteLLM 1.86.0 supports everything the brief needs natively: deployment
    `weight`, `session_affinity`, `deployment_affinity_ttl_seconds`,
    `enable_weighted_failover`, retries, and cooldowns.
  - Session identity comes from `metadata.session_id`, populated by the proxy
    from `x-litellm-session-id`, `x-litellm-trace-id`, or any
    `x-<vendor>-session-id` header. A bare `x-session-id` and
    `x-opencode-session` are not recognized.
  - OpenCode 1.19.0 sends `x-opencode-session-id` unconditionally, so no
    client change is needed for affinity.
  - Fabro 0.386.0-nightly.0 emits `prompt_cache_key` only for models whose
    Fabro capabilities include `cache_routing`; the gateway can promote that
    body key into `metadata.session_id` with an in-process callback.
  - A custom callback registered through `litellm_settings.callbacks` must be
    importable relative to the config file's directory, which forces the
    gateway config and the bridge module into one generated directory.

## Research Log

### LiteLLM 1.86.0 router settings and affinity

- **Context**: The brief pins the gateway at LiteLLM 1.86.0 and forbids
  relying on current upstream documentation.
- **Sources consulted**: `pkgs.litellm` 1.86.0 from the pinned nixpkgs
  (`lib/python3.13/site-packages/litellm/router.py`,
  `router_utils/pre_call_checks/deployment_affinity_check.py`,
  `router_strategy/simple_shuffle.py`,
  `router_utils/cooldown_handlers.py`,
  `router_utils/fallback_event_handlers.py`); upstream tag `v1.86.0` is the
  canonical equivalent of the package source.
- **Findings**:
  - `Router.__init__` accepts `optional_pre_call_checks`,
    `deployment_affinity_ttl_seconds` (default 3600),
    `model_group_affinity_config`, `allowed_fails`, `cooldown_time`,
    `num_retries`, `max_fallbacks`, and `enable_weighted_failover`. The proxy
    accepts every `Router.get_valid_args()` key from `router_settings`.
  - `session_affinity` is one of the optional pre-call checks. It reads
    `metadata.session_id` or `litellm_metadata.session_id`; a hit returns the
    pinned deployment when that deployment is in the healthy list.
  - The cache key is `deployment_affinity:v1:session:<model_group>:<session_id>`.
    The group component is the deployment's `model_name`, so pins are already
    scoped per logical model.
  - The pin is written by `async_pre_call_deployment_hook`, which runs after
    deployment selection, and its TTL is refreshed on every request. The TTL is
    therefore an idle expiry, not an absolute lifetime.
  - Cooldown filtering happens before affinity filtering in
    `async_get_healthy_deployments`, so a pinned deployment in cooldown is not
    in the candidate list and the conversation re-picks a sibling; the next
    successful request re-pins the conversation to that sibling.
  - `simple_shuffle` uses `litellm_params.weight` and treats a missing weight
    as `0` when any sibling declares one, so the generator must emit an
    explicit weight for every deployment.
  - `enable_weighted_failover` runs on async calls after the failed attempt,
    excludes already-tried deployment ids, and re-picks inside the same model
    group. `max_fallbacks` bounds the chain (`fallback_depth >= max_fallbacks`
    stops it). The sync `router.completion()` path does not honor it; the
    proxy uses the async path.
  - When a request exhausts the in-group attempts with no cross-group
    fallbacks, `async_function_with_fallbacks_common_utils` appends
    `Received Model Group=<requested model>` to the exception message before
    raising it, so the caller's error names the logical model. The
    no-healthy-deployment path raises `RouterRateLimitError(model=...)`
    instead.
  - `num_retries = 0` raises the first failure into the async fallback path,
    which is where weighted failover runs. The default is 2.
  - Cooldown eligibility: 429, 401, 404, 408, and all non-4xx errors are
    cooled down; other 4xx responses are not. `APIConnectionError` is
    deliberately excluded by `_is_cooldown_required`. Setting
    `allowed_fails` to a non-default value selects the per-minute fail-count
    policy; `0` cools a deployment down on its first eligible failure.
- **Implications**: The gateway config can use native router behavior. The
  bridge only has to supply `metadata.session_id`; it must not implement its
  own router.

### LiteLLM header-derived session identity

- **Context**: Requirement 4 needs a session identity from client headers,
  and the brief rejects inventing a bare `x-session-id` contract.
- **Sources consulted**: `proxy/litellm_pre_call_utils.py` (1.86.0).
- **Findings**:
  - `_GENERIC_SESSION_ID_HEADER_RE = ^x-.+-session-id$`,
    case-insensitive. Values must match `^[a-zA-Z0-9_\-]{8,}$`.
  - Priority: `x-litellm-trace-id`, then `x-litellm-session-id`, then the
    generic header. The chosen value is written to
    `metadata.session_id` and `metadata.trace_id` and to `litellm_session_id`
    / `litellm_trace_id`.
  - `x-opencode-session` does not match the pattern, so Fabro's static
    upstream header never becomes a session identity.
  - OpenCode's session ids are `ses_`-prefixed identifiers (the bundle
    special-cases `ses_<64 hex>` for its own cache key), which satisfies the
    value regex.
- **Implications**: Requirement 6.8 holds without special-casing Fabro's
  header. The bridge only fills the gap when no header-derived id exists.

### LiteLLM header forwarding

- **Context**: Requirement 7 constrains which client headers reach upstreams.
- **Sources consulted**: `proxy/litellm_pre_call_utils.py` (`clean_headers`,
  `_get_forwardable_headers`, `add_headers_to_llm_call_by_model_group`).
- **Findings**:
  - `model_group_settings.forward_client_headers_to_llm_api` takes a list of
    model groups, matched with alias/wildcard-aware model access checks.
  - The forwarded set is every header whose lowercase name starts with `x-`
    except `x-stainless-*`, plus `anthropic-beta`.
  - `clean_headers` removes `Authorization`, the special authentication headers
    (`API-Key`, `x-api-key`, `x-goog-api-key`,
    `Ocp-Apim-Subscription-Key`, `x-litellm-api-key`) and the MCP control
    headers before forwarding; other `x-litellm-*` headers still match the
    generic `x-*` rule.
  - Forwarding is model-group scoped: every deployment of a matching group
    receives the same header set.
- **Implications**: A unified group that contains an OpenCode Go deployment
  must be in the forwarding list, and its ChatGPT sibling receives the same
  headers. Groups without an OpenCode provider must stay out of the list.

### LiteLLM custom callback loading

- **Context**: The Fabro bridge must run in the gateway process with no extra
  service.
- **Sources consulted**: `proxy/common_utils/callback_utils.py`,
  `proxy/types_utils/utils.py` (`get_instance_fn`), `proxy/utils.py`
  (`pre_call_hook`, `process_pre_call_hook_response`),
  `integrations/custom_logger.py`.
- **Findings**:
  - `litellm_settings.callbacks = ["<module>.<instance>"]` is resolved by
    `get_instance_fn` with `config_file_path` set to the loaded YAML file.
  - When a config path is present, the module is loaded from
    `<dirname(config.yaml)>/<module path with dots as separators>.py`; a
    missing file raises `ImportError` before any `sys.path` import.
  - `async_pre_call_hook(user_api_key_dict, cache, data, call_type)` may return
    a modified dict. It runs before the router's deployment selection.
  - The callback module's own `import` statements resolve through the
    service's `sys.path`; a sibling helper module therefore needs the config
    directory on `PYTHONPATH`.
- **Implications**: Generate one directory containing `config.yaml`,
  `litellm_affinity_bridge.py`, and `litellm_session_identity.py`, point the
  service `--config` at it, and put that directory on `PYTHONPATH`.

### LiteLLM deployment observability

- **Context**: Requirement 8.9 needs a way to tell which deployment served a
  request.
- **Sources consulted**: `proxy/common_request_processing.py`,
  `proxy/proxy_server.py`.
- **Findings**:
  - The proxy returns `x-litellm-model-id` with the selected deployment's
    `model_info.id`.
  - If `model_info.id` is omitted, `ModelInfo` generates a UUID (and the
    clientside-credential path substitutes a parameter hash, keeping the
    original as `original_model_id`); neither is operator-readable.
- **Implications**: The catalog emits an explicit
  `model_info.id = "<logical>@<provider>"`, making the response header the
  documented observation point.

### opencode 1.19.0 session headers

- **Context**: Requirement 6.4 must be satisfied without client header
  configuration.
- **Sources consulted**: the repo's pinned `pkgs.opencode-pinned` 1.19.0
  package (`bin/.opencode-wrapped`, JavaScript bundle).
- **Findings**:
  - The request header block always includes
    `"x-opencode-session-id": <sessionID>`.
  - Only for provider ids that start with `opencode` does it also add
    `x-opencode-project`, `x-opencode-session`, `x-opencode-request`, and
    `x-opencode-client`.
  - One runner path also sends `x-session-affinity` and `X-Session-Id`; those
    do not match LiteLLM's session-header pattern.
  - The OpenAI provider options carry `promptCacheKey` derived from the
    session id, but the header is always present, so header precedence wins in
    LiteLLM.
- **Implications**: The existing `opencode-litellm` provider id (starts with
  `opencode`) remains useful for the extra OpenCode headers, and affinity does
  not depend on it. No static header is added.

### Fabro 0.386.0-nightly.0 cache routing

- **Context**: Requirement 6.6/6.7 need Fabro to send a conversational key.
- **Sources consulted**: the pinned `pkgs.fabro` release binary
  (`fabro-0.386.0-nightly.0`, aarch64 Linux build from
  `f2f9388e9c831ceda55b9b31f664d5ba01a2f1e4`).
- **Findings**:
  - The embedded model schema lists the capability keys `caching` and
    `cache_routing`.
  - Embedded notes state: "Lithos currently emits `prompt_cache_key` for
    `cache_routing`".
  - No Fabro model record in the repo currently claims `cache_routing`, so no
    Fabro request carries the key today.
- **Implications**: Setting `capabilities.cache_routing = true` (and
  `caching = true`) on every gateway model record is the whole Fabro-side
  change; no Fabro upgrade or header feature is needed.

### nixpkgs `services.litellm` module

- **Context**: The bridge packaging must fit the existing module.
- **Sources consulted**: `nixos/modules/services/misc/litellm.nix` from the
  pinned nixpkgs.
- **Findings**:
  - The module renders `settings` to YAML with `pkgs.formats.yaml`, and its
    `ExecStart` is `litellm --host <host> --port <port> --config <generated
    config>`.
  - It exposes `package`, `environment`, `environmentFile`, and `stateDir`, but
    no callback or extra-file option.
  - The rendered unit uses `DynamicUser`, `PrivateUsers`, and reads store paths
    normally; read-only store files are fine.
- **Implications**: Override `ExecStart` with `lib.mkForce` to point at the
  generated config directory, and add `PYTHONPATH` plus
  `PYTHONDONTWRITEBYTECODE=1` through `services.litellm.environment`.

### ChatGPT Responses parameter filter

- **Context**: A new body key (`prompt_cache_key`) must not break the ChatGPT
  deployment when a unified group forwards the request there.
- **Sources consulted**: `llms/chatgpt/responses/transformation.py` (1.86.0).
- **Findings**:
  - `transform_responses_api_request` keeps only `model`, `input`,
    `instructions`, `stream`, `store`, `include`, `tools`, `tool_choice`,
    `reasoning`, `previous_response_id`, and `truncation`.
  - `prompt_cache_key` is therefore dropped before the ChatGPT upstream call.
- **Implications**: Leaving the key in the body is safe for ChatGPT, but the
  bridge still removes it after deriving an identity so no upstream sees a
  key it may reject.

## Risks & Mitigations

- **Callback import drift**: A LiteLLM bump could change `get_instance_fn`
  behavior. Mitigation: the repository check asserts the overridden
  `ExecStart` points at a `litellm-config` directory and that callbacks name
  the bridge; a unit test imports the pure identity module independently.
- **Cooldown eligibility gap**: 1.86.0 never cools a deployment down for
  `APIConnectionError`. Mitigation: the request still fails over inside the
  group; the runbook documents the distinction between transport and provider
  failures.
- **Fabro key semantics**: The key is defined by Fabro/Lithos, not this repo.
  Mitigation: the runbook's affinity smoke confirms stable routing for a Fabro
  conversation; the bridge treats any malformed or absent key as "no session
  identity".
- **Header forwarding breadth**: LiteLLM forwards every `x-*` header. The
  clients send no credentials in `x-*` headers, and auth headers are stripped
  before forwarding. Mitigation: document the allowlist and keep forwarding
  limited to groups that contain an OpenCode provider.

## References

- LiteLLM `v1.86.0` Router and proxy source (package source inspected from
  pinned nixpkgs): `litellm/router.py`,
  `litellm/router_utils/pre_call_checks/deployment_affinity_check.py`,
  `litellm/proxy/litellm_pre_call_utils.py`,
  `litellm/proxy/common_utils/callback_utils.py`,
  `litellm/proxy/types_utils/utils.py`,
  `litellm/router_strategy/simple_shuffle.py`,
  `litellm/router_utils/cooldown_handlers.py`,
  `litellm/router_utils/fallback_event_handlers.py`,
  `litellm/llms/chatgpt/responses/transformation.py`.
- nixpkgs `nixos/modules/services/misc/litellm.nix` (pinned flake input).
- Repo-pinned `pkgs.opencode-pinned` 1.19.0 bundle
  (`bin/.opencode-wrapped`).
- Repo-pinned `pkgs.fabro` 0.386.0-nightly.0 release binary and embedded
  provider notes.
- Existing gateway config and clients:
  `configurations/fabro-vm/litellm.nix`,
  `configurations/fabro-vm/opencode.nix`,
  `configurations/fabro-vm/fabro.nix`.
- `docs/opencode-fabro-vm-handoff.md` for the current operator model.
