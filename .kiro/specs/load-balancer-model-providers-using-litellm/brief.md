# Brief: load-balancer-model-providers-using-litellm

## Problem

> As a LiteLLM operator, I want to load balance models across multiple providers in order to avoid encoding provider configuration in harnesses and other clients while also avoiding provider issues like rate limits.
>
> The LiteLLM configuration must:
>
> * do sticky routing of sessions to take advantage of provider caching
> * route sessions based on headers provided by both Fabro and OpenCode
> * do weighted load balancing across different providers to ensure that a single provider does not get all of the requests
> * have automated retries/fallbacks when providers encounter errors
> * combine the same models across both Opencode Go and OpenAI subscriptions

Clients freeze the provider choice in their model ids, so a rate-limited or failing subscription takes its conversations down with it, provider cache affinity depends on which id each client picked, and every new client integration repeats the provider decision.

## Current State

- The live gateway is `configurations/fabro-vm/litellm.nix`: `services.litellm` on the fabro guest, loopback `127.0.0.1:4000`, master key and `OPENCODE_API_KEY` from the sops `litellm-env` template. `home-manager/common/litellm.nix` is the older macOS launchd module; no host enables it and only its render tests exercise it.
- `model_list` serves provider-scoped ids: `chatgpt/{gpt-6-luna, gpt-6-luna-none, gpt-6-astra, gpt-6.1-sol}`, `opencode-go/{gpt-6-luna, deepseek-v4.1-flash, glm-5.3-flash, beam-free, omen-alpha, longcat-2.0}`, and `opencode-zen/big-pickle`.
- `gpt-6-luna` is the only upstream served by two providers. Both deployments use the responses wire and the fabro-vm client records give each a 1.05M context window, but the ChatGPT entry pins `reasoning_effort = "xhigh"` and the OpenCode Go entry sets no default.
- There is no `router_settings`: no deployment weights, retries, cooldowns, or session affinity. Client `x-*` header forwarding is limited to the `opencode-go/*` and `opencode-zen/*` groups.
- OpenCode 1.19.0 emits `x-opencode-session-id` on model requests, which matches LiteLLM's `x-<vendor>-session-id` rule, plus `x-opencode-session` because its provider id starts with `opencode`.
- Fabro 0.386 sends no per-conversation header. It sends a static `x-opencode-session` for the OpenCode Go upstream, and its Lithos client emits `prompt_cache_key` only for models whose capabilities include `cache_routing`; none of the fabro-vm model records claim it.
- Both clients encode the provider: OpenCode's `provider.opencode-litellm.models` map and Fabro's per-model `api_model` values.
- `flake.nix` asserts the current `opencode-go/*` free-model shape and forwarding list; those assertions move with the configuration.

## Desired Outcome

Each logical model is callable under one provider-agnostic id from both clients. A new conversation is placed across providers by configured weight, every later request in that conversation reaches the same deployment until its affinity TTL expires, and a 429 or provider failure spills to a sibling deployment inside the same model group. Adding a provider, model, or weight is a table entry, not a client change.

## Approach

- Declare one deployment table in Nix: each logical id with its ordered deployments, each carrying provider, upstream id, wire mode, request-affecting defaults, effective context window, and weight. Project it into the gateway `model_list`, OpenCode's model map, and Fabro's model records; fail evaluation when a group's deployments disagree.
- Merge deployments of the same upstream only when wire mode, request-affecting defaults, and effective context match. `gpt-6-luna` merges across ChatGPT and OpenCode Go once both deployments pin `reasoning_effort = "xhigh"`; `gpt-6-luna-none` stays a separate single-deployment group.
- Route with `simple-shuffle` and explicit per-deployment weights, enable `optional_pre_call_checks: ["session_affinity"]` with an explicit TTL, and add retries plus `enable_weighted_failover` with a cooldown so a failed deployment is skipped and re-picked inside its group. No cross-group fallback.
- Take session identity from the request header when present; OpenCode needs no client change. Fabro is the gap: enable `cache_routing` on its model records so it emits `prompt_cache_key`, and promote that body key into `metadata.session_id` in an in-process pre-call hook shipped with the gateway, namespaced by producer and never overriding a header-derived id.
- Forward client `x-*` headers for any unified group containing an OpenCode Go deployment, because that upstream requires the forwarded `x-opencode-session`. Fabro's static value stays for the upstream requirement and is not the affinity identity.
- Update both client surfaces and the flake assertions together, add hook unit tests, and document an operator smoke for weight distribution, affinity, and failover.

## Scope

- **In**: the deployment table and its projections; unified ids for every logical model; weights, affinity TTL, retries, weighted failover, and cooldowns; the session-identity bridge and its packaging; header forwarding for unified groups; OpenCode and Fabro model updates; eval assertions, hook tests, smoke/runbook, and comment updates.
- **Out**: new subscriptions, providers, credentials, or catalog discovery; cross-model fallbacks; Redis, multi-instance state, or persisted affinity; virtual keys, budgets, or spend reporting; client-side balancing or provider pinning; OpenCode or Fabro upstream changes; the unused macOS launchd agent.

## Boundary Candidates

- Model catalog: logical ids, deployment membership, wire modes, request defaults, context limits.
- Weighting and routing: strategy, weights, affinity TTL, cooldowns, retry bounds.
- Session identity: header precedence, body-key bridge, namespacing.
- Failover: in-group retry and weighted re-pick, cooldown behavior.
- Client surface: OpenCode model map and Fabro model records/capabilities.
- Verification: eval assertions, bridge unit tests, operator smoke, documentation.

## Out of Boundary

- Cross-model fallbacks such as `gpt-6-luna` to `gpt-6.1-sol`; they change answer semantics and are a separate decision.
- A bare `x-session-id` contract; LiteLLM 1.86 does not recognize it and no client sends it.
- Making Fabro emit a per-conversation header; 0.386 cannot interpolate run context into `default_headers`, so that is an upstream dependency.
- Persisting affinity across gateway restarts; the affinity cache is in-process.
- Per-deployment header-forward filtering; forwarding is configured per model group.
- A provider-pinning switch in client configuration for a merged model.
- Redis, virtual keys, budgets, or spend reporting.

## Upstream / Downstream

- **Upstream**: LiteLLM 1.86.0 from the pinned nixpkgs (`weight`, `session_affinity`, cooldowns, `enable_weighted_failover`), nixpkgs `services.litellm`, the sops `litellm-env` secrets, OpenCode 1.19.0 session headers, and Fabro 0.386/Lithos `prompt_cache_key`.
- **Downstream**: OpenCode and Fabro model pickers and saved model references, future providers and models added to the table, cost/cache measurements, and the fabro-vm operator runbook.

## Existing Spec Touchpoints

- **Extends**: `configure-litellm-load-balancing-across-existing` — approved but unimplemented; its verified router and client findings seed this spec, which restates the plan for issue #128 and supersedes that directory when this spec lands.
- **Adjacent**: `nix-built-container-for-default-fabro-environmen` (fabro-vm service wiring and flake assertions); `opencode-cost-diagnosis` (measures cost and cache behavior, does not route); `session-compaction` and `subagent-context-budget` (prompt shape that determines how much cache affinity is worth).

## Constraints

- LiteLLM 1.86.0 is the feature ceiling; router options are verified against the pinned package source, not current upstream docs.
- One proxy process with in-memory affinity state; Fabro hard-requires `litellm.service`, so a gateway restart also restarts Fabro and clears every pin.
- Affinity is keyed by model group and session id; the shared master key provides no per-client isolation, so bridged ids are namespaced.
- A unified group's deployments must agree on wire mode, request-affecting defaults, and effective context window; otherwise the model is split.
- Header forwarding is model-group scoped, so a unified group forwards client `x-*` headers to every provider it contains.
- Configuration is declarative Nix; provider credentials stay `os.environ/...` references backed by sops, never in the store.
- OpenCode and Fabro model ids change together; a partially updated client loses access to the merged model.
