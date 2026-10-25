# Brief: configure-litellm-load-balancing-across-existing

## Problem

> As a LiteLLM operator with multiple providers for the same models, I want to use LiteLLM's load balancing and failover features to help with distributing usage across those providers in order to help work around rate limiting and to optimize costs.
>
> The configuration must:
>
> * combine the same models hosted by multiple providers into a single client-callable model to avoid having load balancing decisions encoded in clients
> * support "sticky" session routing using either `x-session-id` or some other header supported by both OpenCode and Fabro in order to route conversations to the same provider to leverage caching
> * support weighted balancing so that multiple providers can be used simultaneously to avoid exhausting all rate limit on one provider within a given window.
> * be able to be extended to other providers in the future.

The gateway serves each model under one provider-scoped id per provider, so OpenCode and Fabro freeze the provider choice in client configuration. A rate-limited or failing provider then takes its clients down with it, subscription capacity cannot be pooled across providers or conversations, and every new client integration repeats the provider decision.

## Current State

- The live gateway is `configurations/fabro-vm/litellm.nix`: `services.litellm` on the fabro guest, loopback `127.0.0.1:4000`, master key and `OPENCODE_API_KEY` from sops-rendered env. `home-manager/common/litellm.nix` still defines the macOS launchd module, but no host enables it; only its render tests exercise it.
- `model_list` holds one deployment per provider-scoped group: `chatgpt/{gpt-6-luna, gpt-6-luna-none, gpt-6-astra, gpt-6.1-sol}`, `opencode-go/{gpt-6-luna, deepseek-v4.1-flash, glm-5.3-flash, longcat-2.5-preview-free}`, and `opencode-zen/big-pickle`. `gpt-6-luna` is the only model currently served by two providers.
- The two `gpt-6-luna` groups disagree on request defaults: the ChatGPT entry pins `reasoning_effort = "xhigh"`, the OpenCode Go entry sets none, and `gpt-6-luna-none` exists only to pin `none`.
- There is no `router_settings`: routing is the default, with no deployment weights, retries, cooldowns, or session affinity. Header forwarding is limited to the `opencode-go/*` and `opencode-zen/*` groups.
- OpenCode 1.19.0 emits `x-opencode-session-id: <sessionID>` on model requests, plus `x-opencode-session` because its provider id starts with `opencode`.
- Fabro 0.386 sends no session header; `default_headers` templates only `{{ vars.* }}` and `{{ secrets.* }}`, so a per-conversation header would need an upstream change. Its Lithos client emits `prompt_cache_key` for models that claim `cache_routing`, and no fabro-vm model claims it. Fabro currently sends a static `x-opencode-session` to satisfy the OpenCode Go upstream.
- LiteLLM is pinned to 1.86.0 by nixpkgs. That version has deployment `weight`, the `session_affinity` pre-call check, per-group affinity config, retries, cooldowns, and `enable_weighted_failover`; its session id comes from `x-litellm-session-id`/`x-litellm-trace-id`, any `x-<vendor>-session-id` header, or `metadata.session_id`. `session_affinity_repin_on_failover` does not exist in this version.
- Both clients encode provider choice in model ids: OpenCode's `provider.opencode-litellm.models` map and Fabro's per-model `api_model` values.

## Desired Outcome

Each logical model has one provider-agnostic id that both clients call. A request is placed on a provider by configured weight; every later request in the same conversation lands on the same deployment until the affinity TTL expires; a 429 or provider failure spills to a sibling deployment and the session keeps working. Adding a provider, model, or weight is a declarative configuration entry, not a client change or a code fork.

## Approach

Generate `model_list` from a per-model deployment table: logical name, ordered deployments with provider, upstream id, wire mode, request defaults, and weight. A unified group only combines deployments whose client-visible semantics match (mode, reasoning-effort defaults, context window); variants such as `gpt-6-luna-none` stay separate single-deployment groups.

Route with `simple-shuffle` and per-deployment weights, enable `optional_pre_call_checks: ["session_affinity"]` with an explicit affinity TTL, and add retries plus `enable_weighted_failover` so a failed deployment re-picks within the group before the caller sees an error. Leave `deployment_affinity` off: every consumer shares the master key, so caller-key affinity would pin all traffic to one deployment.

Take session identity from what the clients already send rather than inventing an `x-session-id` contract; LiteLLM 1.86 does not recognize a bare `x-session-id`, and neither client sends one. OpenCode's `x-opencode-session-id` is already recognized natively. Fabro is the gap: enable `caching`/`cache_routing` on its model records so Lithos emits `prompt_cache_key`, and ship a small Python pre-call hook with the gateway that promotes that key into `metadata.session_id` (namespaced, and never overriding an id derived from a request header).

Keep client `x-*` forwarding for groups that include OpenCode Go, since its upstream requires the forwarded session header; a unified group therefore also forwards those headers to its ChatGPT deployment. Update both clients to the unified ids and refresh the fabro-vm handoff and operator runbook, with eval assertions and hook unit tests as the deterministic gate and a documented smoke for affinity, weight distribution, and failover.

## Scope

- **In**: A deployment table and generated `model_list`; unified ids for every logical model; weights and router settings; native affinity for OpenCode; the Fabro session-id bridge (hook, packaging, capability); header forwarding for unified groups; OpenCode and Fabro model-config updates; eval assertions, hook tests, and a runtime smoke/runbook; comment and handoff-doc updates.
- **Out**: Provisioning new subscriptions, providers, credentials, or catalog discovery (the table must accept them; this spec adds none); cross-model fallbacks; Redis or multi-instance state; virtual keys, budgets, or spend reporting; client-side balancing; OpenCode or Fabro upstream changes; the unused macOS launchd agent.

## Boundary Candidates

- Model catalog: logical names, deployment membership, wire modes, request defaults, context limits.
- Weighting and routing: strategy, per-deployment weights, session-affinity TTL, cooldowns.
- Session identity: header-derived ids, body-key bridge, namespacing, precedence.
- Failover: retries, within-group weighted failover, cooldown behavior.
- Client surface: OpenCode model map and Fabro model records/capabilities.
- Verification: eval tests, hook unit tests, operator smoke, documentation.

## Out of Boundary

- Cross-model fallbacks such as `gpt-6-luna` to `gpt-6.1-sol`; they change answer semantics and are a separate decision.
- A bare `x-session-id` contract; no client sends it and LiteLLM 1.86 would not read it.
- Per-deployment header-forward filtering; `forward_client_headers_to_llm_api` is model-group scoped.
- Persisting affinity across gateway restarts; the cache is in-process and a restart clears pins.
- Requiring Fabro to send a dynamic header; that is an upstream feature request, not this spec.
- Provider pinning or an "always use provider X" switch in client configuration; for a merged model the group is the only client-facing routing surface.

## Upstream / Downstream

- **Upstream**: LiteLLM 1.86.0 router (`weight`, `session_affinity`, `model_group_affinity_config`, `enable_weighted_failover`), nixpkgs `services.litellm`, OpenCode 1.19.0 session headers, Fabro 0.386/Lithos `prompt_cache_key`, and the sops `litellm-env` secrets.
- **Downstream**: OpenCode and Fabro model pickers and saved model references; future providers and models added to the table; cost and cache measurements; the fabro-vm operational runbook.

## Existing Spec Touchpoints

- **Extends**: None.
- **Adjacent**: `nix-built-container-for-default-fabro-environmen` (fabro-vm host, service wiring, and flake assertions); `opencode-cost-diagnosis` (measures cost and cache behavior; it does not route); `session-compaction` and `subagent-context-budget` (client prompt/token behavior that determines how much caching affinity is worth).

## Constraints

- LiteLLM 1.86.0 is the ceiling: use only features present in the pinned package, and verify router options against it rather than current upstream docs.
- One proxy process with in-memory affinity state; the hard fabro dependency means a gateway restart restarts Fabro and drops all pins.
- Affinity is keyed by model group and session id; the shared master key provides no per-client isolation, so bridge keys must be namespaced.
- A unified group's deployments must agree on wire mode, request-affecting defaults, and effective context window; otherwise the model is split.
- Header forwarding is model-group scoped and cannot be narrowed per deployment, so a unified group forwards client `x-*` headers to every provider it contains.
- Configuration is declarative Nix; provider credentials stay in `os.environ/...` references backed by sops, never in the store.
- OpenCode and Fabro model ids change together; a partially updated client loses access to the merged model.
- Fabro's static `x-opencode-session` remains for the OpenCode Go upstream requirement and is not the affinity identity.
