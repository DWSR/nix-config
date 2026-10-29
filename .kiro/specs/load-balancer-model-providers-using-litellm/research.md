# Research: load-balancer-model-providers-using-litellm

## Summary

- **Feature**: provider-agnostic model ids with weighted placement, session
  affinity, in-group failover, and cooldown on the fabro-vm LiteLLM gateway.
- **Scope**: extension of `configurations/fabro-vm/litellm.nix` at the pinned
  LiteLLM 1.86.0, with one in-process Python hook and catalog projections into
  `opencode.nix` and `fabro.nix`.
- **Method**: every router, proxy, and callback claim below was read from the
  pinned package output `python3.13-litellm-1.86.0` installed in this
  environment (paths are relative to
  `lib/python3.13/site-packages/litellm/`). OpenCode and Fabro claims were
  re-checked against the pinned binaries in `/nix/store` and the repository's
  recorded evidence.

## Research Log

### Router settings, weights, and affinity

- **Sources**: `router.py`, `router_strategy/simple_shuffle.py`,
  `router_utils/pre_call_checks/deployment_affinity_check.py`,
  `router_utils/cooldown_handlers.py`,
  `router_utils/fallback_event_handlers.py`, `types/router.py`.
- **Findings**:
  - `Router.__init__` accepts `optional_pre_call_checks`,
    `deployment_affinity_ttl_seconds` (default 3600), `allowed_fails`,
    `cooldown_time`, `num_retries`, `max_fallbacks`, and
    `enable_weighted_failover` (`router.py:262-324`). The proxy accepts every
    `Router.get_valid_args()` key from `router_settings`
    (`proxy/proxy_server.py:4434-4452`).
  - `session_affinity` is a valid optional pre-call check and enables only
    session-id affinity (`router.py:1621-1655`).
  - The affinity cache key is
    `deployment_affinity:v1:session:<model_group>:<session_id>`
    (`deployment_affinity_check.py:40,222-223`). Pins are therefore scoped per
    logical model.
  - The affinity check reads `session_id` from `litellm_metadata` first, then
    `metadata` (`deployment_affinity_check.py:242-284`).
  - Cooldown filtering runs before the affinity callback
    (`router.py:10144-10174`), so a pinned deployment in cooldown is not a
    candidate and the conversation re-picks a sibling.
  - `simple_shuffle` reads `litellm_params.weight` from the first candidate
    and treats a missing weight as `0` when any sibling declares one
    (`router_strategy/simple_shuffle.py:47-70`). Every deployment must
    therefore emit an explicit weight.
  - `enable_weighted_failover` re-picks inside the same model group, excluding
    already-tried and cooling-down deployment ids, and refuses to run outside
    `simple-shuffle` (`router.py:5671-5760`; docstring at `router.py:360`). It
    is honored on the async path the proxy uses and is bounded by
    `max_fallbacks` (`router_utils/fallback_event_handlers.py:117`).
  - `allowed_fails = 0` cools a deployment down on its first eligible failure
    (`cooldown_handlers.py:398-428`). `_is_cooldown_required` excludes
    `APIConnectionError` and cools 429/401/404/408 and non-4xx failures
    (`cooldown_handlers.py:40-75`).
  - `num_retries = 0` raises the first failure into the async fallback path,
    which is where weighted failover runs.
  - When the group is exhausted with no cross-group fallback, the router
    appends `Received Model Group=<requested model>` (`router.py:6013`); an
    empty healthy set raises `RouterRateLimitError`, whose message includes
    `Passed model=<model>` (`types/router.py:706-718`).
  - `Router.cache` is a `DualCache(in_memory_cache=InMemoryCache())`
    (`router.py:462-464`); the proxy supplies no Redis in this deployment, so
    pins and fail counts are process-local.
- **Implications**: use the router natively; emit an explicit weight for every
  deployment and an explicit `model_info.id` (the pin value); set
  `num_retries = 0`, `enable_weighted_failover = true`, `allowed_fails = 0`,
  and a cooldown; derive `max_fallbacks` from the largest group.

### Header-derived session identity

- **Sources**: `proxy/litellm_pre_call_utils.py`.
- **Findings**:
  - `_GENERIC_SESSION_ID_HEADER_RE = ^x-.+-session-id$` (case-insensitive) and
    `_SESSION_ID_VALUE_RE = ^[a-zA-Z0-9_\-]{8,}$`
    (`litellm_pre_call_utils.py:40-44`).
  - Priority is `x-litellm-trace-id`, then `x-litellm-session-id`, then the
    generic header (`litellm_pre_call_utils.py:376-393`).
  - The value is written into `metadata.session_id` before the custom pre-call
    hook runs (`proxy/proxy_server.py:8836-8854`).
  - `x-opencode-session` does not match the generic pattern, so Fabro's static
    upstream header can never become the session identity.
  - Because header values may contain only alphanumerics, `_`, and `-`, a body
    key namespaced with colons can never collide with a header value.
- **Implications**: OpenCode needs no client change; Fabro's static header is
  inert for affinity; the bridge may use a colon-delimited namespace.

### Header forwarding

- **Sources**: `proxy/litellm_pre_call_utils.py`.
- **Findings**:
  - `litellm_settings.model_group_settings.forward_client_headers_to_llm_api`
    is matched against the request's model group with alias/wildcard support
    (`litellm_pre_call_utils.py:830-850`).
  - `_get_forwardable_headers` forwards `x-*` except `x-stainless-*`, plus
    `anthropic-beta` (`litellm_pre_call_utils.py:681-700`).
  - `clean_headers` removes the proxy authentication headers before forwarding
    (`litellm_pre_call_utils.py:561-618`).
  - Forwarding is model-group scoped, not per deployment.
- **Implications**: list every logical model whose deployment set contains a
  provider that requires the upstream session header; the whole group receives
  the same headers.

### Custom callback loading

- **Sources**: `proxy/types_utils/utils.py`, `proxy/common_utils/callback_utils.py`,
  `integrations/custom_logger.py`.
- **Findings**:
  - `get_instance_fn(value, config_file_path)` loads
    `<dirname(config.yaml)>/<module path>.py` when a config path is present,
    and raises `ImportError` if the file is absent
    (`proxy/types_utils/utils.py:8-68`).
  - `async_pre_call_hook(user_api_key_dict, cache, data, call_type)` runs
    before deployment selection and may return a modified `data` dict
    (`integrations/custom_logger.py:369-380`).
- **Implications**: the gateway config and both Python modules must live in one
  generated directory; the service `--config` and `PYTHONPATH` point at it.

### Deployment observability

- **Sources**: `proxy/common_request_processing.py`.
- **Findings**: the proxy returns `x-litellm-model-id` with the selected
  deployment's `model_info.id` (`common_request_processing.py:590-593`).
- **Implications**: emit `model_info.id = "<logical>@<provider>"` so the
  response header names the deployment.

### OpenCode 1.19.0 session headers

- **Sources**: pinned `opencode-1.19.0` bundle in `/nix/store`
  (`bin/.opencode-wrapped`); repository evidence in
  `docs/opencode-fabro-vm-handoff.md`.
- **Findings**: every provider request carries
  `x-opencode-session-id: <sessionID>`; the provider-id `opencode*` branch also
  adds `x-opencode-session`, `x-opencode-project`, `x-opencode-request`, and
  `x-opencode-client`. The bundle was re-checked for both header names.
- **Implications**: keep the provider id `opencode-litellm`; do not add a
  static session header.

### Fabro 0.386 cache routing

- **Sources**: pinned `fabro-0.386.0-nightly.0` binary in `/nix/store`;
  recorded evidence in
  `.kiro/specs/configure-litellm-load-balancing-across-existing/research.md`.
- **Findings**: the binary embeds the capability keys `caching` and
  `cache_routing` and the string `prompt_cache_key`. The recorded binary notes
  state that Lithos emits `prompt_cache_key` for models advertising
  `cache_routing`. No current Fabro model record advertises it.
- **Implications**: setting `capabilities.caching` and
  `capabilities.cache_routing` is the whole Fabro-side change for affinity.

### nixpkgs `services.litellm` module

- **Sources**: evaluated `nixosConfigurations.fabro-vm` in this repository.
- **Findings**: the unit's `ExecStart` is
  `<litellm>/bin/litellm --host "127.0.0.1" --port 4000 --config
  /nix/store/<hash>-config.yaml`; the module exposes `package`, `environment`,
  `environmentFile`, and `stateDir`, and renders `settings` to YAML.
- **Implications**: override `ExecStart` with `lib.mkForce` to the generated
  directory and add `PYTHONPATH` through `services.litellm.environment`; the
  existing `DynamicUser` unit keeps working.

## Risks & Mitigations

- **Callback import drift**: a LiteLLM bump could change `get_instance_fn`.
  Mitigation: the routing check asserts the overridden `ExecStart` and
  `callbacks` wiring; the pure identity module is tested without LiteLLM.
- **Cooldown eligibility gap**: 1.86.0 never cools a deployment for
  `APIConnectionError`. Mitigation: the request still fails over in-group; the
  runbook documents the distinction.
- **Header forwarding breadth**: forwarding sends every `x-*` header. Clients
  send no credentials in `x-*`; proxy auth headers are stripped first. Keep
  forwarding limited to groups that need it and document the allowlist.
- **Single-deployment groups and `allowed_fails = 0`**: a single failed request
  takes the only deployment out for the cooldown window. This is the required
  failover/cooldown contract; the runbook states the cooldown duration.

## References

- Pinned `python3.13-litellm-1.86.0` package source under
  `lib/python3.13/site-packages/litellm/`: `router.py`,
  `router_strategy/simple_shuffle.py`,
  `router_utils/pre_call_checks/deployment_affinity_check.py`,
  `router_utils/cooldown_handlers.py`,
  `router_utils/fallback_event_handlers.py`, `types/router.py`,
  `proxy/litellm_pre_call_utils.py`, `proxy/common_utils/callback_utils.py`,
  `proxy/types_utils/utils.py`, `proxy/common_request_processing.py`,
  `integrations/custom_logger.py`.
- Pinned `opencode-1.19.0` bundle (`bin/.opencode-wrapped`) and
  `docs/opencode-fabro-vm-handoff.md`.
- Pinned `fabro-0.386.0-nightly.0` binary and the prior spec's recorded
  binary findings.
- Evaluated `nixosConfigurations.fabro-vm` in this repository
  (`services.litellm.*`, `systemd.services.litellm.*`).
