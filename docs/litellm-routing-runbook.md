# LiteLLM routing runbook

The fabro-vm guest runs one LiteLLM 1.86.0 gateway on
`http://127.0.0.1:4000`. It serves the provider-free logical model ids
generated from `configurations/fabro-vm/litellm-catalog.nix`. Each response
carries `x-litellm-model-id: <logical>@<provider>`, naming the deployment
that served the request; that header is the primary observation point. A
response also carries `x-litellm-call-id`, which correlates with
`journalctl -u litellm`. `GET /health/liveliness` is the unit's readiness
gate (`ExecStartPost`), so a gateway that cannot load its configuration
never reaches `active (started)`.

The gateway is a single process: affinity pins and cooldowns live in its
in-memory router cache. Do not run two gateway instances behind one
client-facing address.

## Observing placement

The client-callable `model` field is always a logical id; never send a
provider-scoped id. Read the master key from the root-only sops-rendered
`litellm-env` file on the guest (locate it with
`sudo systemctl show litellm.service -p EnvironmentFiles`) and export it
as `LITELLM_MASTER_KEY` in your shell. Do not paste the key into this
document or a terminal transcript.

OpenCode and Fabro send `x-opencode-session` automatically: OpenCode
because its provider id (`opencode-litellm`) starts with `opencode`, and
Fabro through its provider-level `default_headers`. A raw curl must send
it too, or the OpenCode Go/Zen upstream rejects the request with HTTP 400
`Request is missing x-opencode-session`.

```sh
GW=http://127.0.0.1:4000/v1/chat/completions
AUTH="Authorization: Bearer $LITELLM_MASTER_KEY"
BODY='{"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]}'
curl -sS -D - -o /dev/null \
  -H "$AUTH" \
  -H 'Content-Type: application/json' \
  -H 'x-opencode-session: smoke-observe-0001' \
  -H 'x-opencode-session-id: smoke-observe-0001' \
  -d "$BODY" "$GW" \
  | grep -Ei '^x-litellm-(model-id|call-id):'
```

One possible output; a fresh weighted placement may return either
deployment:

```text
x-litellm-model-id: gpt-6-luna@chatgpt
x-litellm-call-id: <uuid>
```

`journalctl -u litellm | grep <uuid>` shows the placement and the
upstream call for that request.

## Editing the catalog

All model composition lives in
`configurations/fabro-vm/litellm-catalog.nix`. The catalog is pure data:
no host paths, derivations, or secret values. Credentials appear only as
environment-variable names. The gateway, OpenCode, and Fabro read
projections of this file, so do not edit their model lists by hand.

### Add a provider

Add an entry to `providers`:

```nix
providers.my-provider = {
  modelPrefix = "openai/";
  apiBase = "https://api.example.com/v1";
  apiKeyEnvVar = "MY_PROVIDER_API_KEY";
  allowedOpenAIParams = [ "reasoning_effort" ];
  requiresClientSessionHeader = false;
};
```

- `modelPrefix` is the LiteLLM provider route used to build the upstream
  model string. The OpenCode deployments use `openai/`.
- `apiBase` is the upstream base URL, or `null` when the provider resolves
  its own endpoint (the ChatGPT deployment uses its OAuth token
  directory).
- `apiKeyEnvVar` is the name of the runtime environment variable, or
  `null`. Never put a key value in the catalog. Add the variable to the
  `litellm-env` sops template in `configurations/fabro-vm/default.nix`.
- `allowedOpenAIParams` lists the OpenAI-shaped parameters passed through
  to the upstream.
- `requiresClientSessionHeader = true` makes every logical model that
  uses this provider forward the client session headers. Forwarding is
  group-scoped, so all deployments of each such model forward them too.

The provider key becomes a forbidden token in logical ids: after adding
`my-provider`, no logical id may contain that string.

### Add a logical model

Add an entry to `logicalModels`:

```nix
logicalModels."my-model" = {
  displayName = "My Model";
  reasoningEffortLevels = [ "low" "high" ];
  smallDefault = true;
  deployments = [ /* at least one deployment */ ];
};
```

- `deployments` is required, ordered, and non-empty.
- `displayName` is optional and defaults to the logical id.
- `reasoningEffortLevels` is optional; Fabro advertises only the listed
  levels.
- `smallDefault` is optional and marks Fabro's small default; today only
  `deepseek-v4.1-flash` sets it.
- The id must be unique, contain no `/`, and contain no provider key.
- The entry appears in both clients at their next restart.

### Add a deployment

Append an entry to an existing group's `deployments` list:

```nix
{
  provider = "opencode-go";
  upstreamModel = "glm-5.3-flash";
  mode = "chat";
  requestDefaults = { };
  limits = {
    contextTokens = 1000000;
    maxOutputTokens = 131072;
  };
  weight = 1;
}
```

- Required fields are `provider`, `upstreamModel`, `mode`,
  `limits.contextTokens`, and `limits.maxOutputTokens`.
  `requestDefaults` defaults to `{ }` and `weight` defaults to `1`.
- Every deployment of a group must agree on `mode`, `requestDefaults`,
  and both limits. Weights may differ.
- Adding a deployment to an existing group does not change its
  client-callable id; the group keeps its id and gains a placement
  sibling.
- Two deployments in one group cannot use the same provider: their
  `<logical>@<provider>` ids would collide and evaluation fails with a
  duplicate deployment id.
- If the new provider sets `requiresClientSessionHeader = true`, the
  whole group starts forwarding the client session headers automatically.

### Change a weight

Weights live on each deployment in the catalog, not in `router_settings`.
Set `weight` to an integer of at least `1`:

```nix
weight = 2;
```

The share is relative within the group. A deployment without a weight is
normalized to `1`. Rebuild and reload the gateway; clients keep the same
ids and need no change.

### Validation and rollout

Evaluation fails before any projection is built, with a
`litellm-catalog: ...` message naming the offending logical model,
deployment, and/or field where applicable. Typical failures are a missing
required field, an unknown provider, an empty deployment list, a duplicate
deployment id, and disagreeing `mode`/`requestDefaults`/`limits`:

```text
litellm-catalog: logical model 'foo' has no deployments
```

Provider-free ids are enforced: a logical id containing `/` or any
provider key fails evaluation with the offending id named.

After a catalog edit:

1. From the repository root on the mac, run `lima-vm-deploy`, which
   streams the tree into the guest and runs
   `sudo nixos-rebuild switch --flake .#fabro-vm` there. On the guest
   itself, run `sudo nixos-rebuild switch --flake .#fabro-vm`.
2. The switch restarts `litellm.service` because its generated config
   path changes. If it did not, run
   `sudo systemctl restart litellm.service`.
3. Confirm the gateway is answering:
   `curl -fsS http://127.0.0.1:4000/health/liveliness`.
4. Restart `fabro.service` if it is not running. Fabro has a hard
   `Requires` on the gateway, so stopping the gateway stops Fabro, and
   Fabro does not start again on its own. OpenCode only `Wants` the
   gateway and may keep running.
5. Both clients read their generated model maps at their normal restart;
   `nixos-rebuild switch` restarts them when the generated file changes.

The gateway and both clients move together when ids change. A client
that still holds a removed provider-scoped id fails loudly, because no
aliases exist.

## Routing settings

The routing knobs live in `configurations/fabro-vm/litellm.nix` under
`services.litellm.settings.router_settings`. Deployment weights do not
live here; they are per-deployment catalog fields.

- `routing_strategy = "simple-shuffle"`: new conversations are placed by
  weight across the available deployments. `enable_weighted_failover`
  works only with this strategy.
- `optional_pre_call_checks = [ "session_affinity" ]`: enables the
  session-id affinity pin and nothing else.
- `deployment_affinity_ttl_seconds = 21600`: six-hour idle TTL, refreshed
  by every routed request. Change the TTL here, not in the catalog.
- `num_retries = 0`: a failed attempt is not retried on the same
  deployment; the first failure enters the failover path.
- `enable_weighted_failover = true`: a failed attempt re-picks a sibling
  inside the same logical model.
- `allowed_fails = 0`: the first cooldown-eligible failure cools the
  deployment.
- `cooldown_time = 60`: seconds out of placement and out of affinity
  selection.
- `max_fallbacks = catalog.maxGroupSize - 1`: bounds the in-group
  attempts. The largest group (`gpt-6-luna`, two deployments) makes this
  `1` today; do not hardcode the number.

`fallbacks`, `context_window_fallbacks`, and `model_group_alias` are
absent on purpose: a request never crosses a logical model. `rpm`,
`tpm`, and `deployment_affinity` are absent too: caller rate and an
extra affinity mode do not influence placement.

## Header forwarding

Forwarding is group-scoped and derived from the catalog's
`requiresClientSessionHeader` provider flag. The gateway lists a logical
model in the forwarding setting when any of its deployments' providers
requires the client session header:

```nix
litellm_settings.model_group_settings.forward_client_headers_to_llm_api =
  catalog.forwardClientHeaders;
```

Every sibling in that group then forwards the same headers, including a
ChatGPT sibling in a unified group. The allowlist is every `x-*` header
except `x-stainless-*`, plus `anthropic-beta`. LiteLLM strips
`Authorization` and its special authentication headers first;
content-type and credentials are never forwarded. Do not put secrets in
`x-*` headers, and do not add static provider headers in OpenCode: the
forwarded client headers are the mechanism.

## Session identity

Affinity is keyed by logical model and session identity. The identity
comes from one of three places:

- OpenCode sends `x-opencode-session-id` per session. It also emits
  `x-opencode-session` because its provider id starts with `opencode`;
  that header satisfies the OpenCode Go upstream requirement but is not
  the affinity identity. LiteLLM writes `x-opencode-session-id` to
  `metadata.session_id` before the bridge runs, so OpenCode needs no
  configuration. Header priority inside LiteLLM is
  `x-litellm-trace-id`, then `x-litellm-session-id`, then the first
  `x-<vendor>-session-id`. The value must match
  `^[a-zA-Z0-9_-]{8,}$`.
- Fabro emits a per-conversation `prompt_cache_key` because its catalog
  records advertise `caching` and `cache_routing`. The in-process bridge
  in `configurations/fabro-vm/litellm_affinity_bridge.py` turns the key
  into `bridge:v1:<producer>:<sha256 of the stripped key>` and removes
  the body key. The producer is the `User-Agent` product token before
  the first `/`, lowercased, restricted to `[a-z0-9._-]` and 32
  characters, else `unknown`. A producer that relies on the body key
  must send a stable `User-Agent`; producers without one share the
  `unknown` namespace.
- Fabro also sends the static `x-opencode-session: fabro-litellm`
  header at the provider level. It satisfies the OpenCode Go upstream
  requirement but does not match the generic session-id header pattern,
  so it is not the affinity identity.

The rules:

- A client session header always wins over a body key. When a header
  wins, the body key is left in place for an upstream that can use it.
- A body-derived id always starts with `bridge:v1:`. The proxy's header
  value regex cannot produce a colon, so a body-derived id can never
  equal a header-derived id.
- Pins are in-process and scoped to one logical model. The TTL is an
  idle expiry. A gateway restart clears every pin, so the next request
  of each conversation is a fresh placement. Fabro also restarts with
  the gateway because of its hard dependency.
- A request with no identity, or with a malformed body key, is placed by
  weight without touching another conversation's pin.
- 1.86.0 boundary: provider-status failures (429, 401, 404, 408, 5xx)
  are cooldown-eligible. Transport errors (`APIConnectionError`) fail
  over inside the group but never enter cooldown, so a dead endpoint is
  retried on later placements.

## Smoke tests

Run these on the guest after a rebuild. Read the master key from the
root-only sops-rendered `litellm-env` file and export it as
`LITELLM_MASTER_KEY` as described in "Observing placement". The recipes
use only client-callable `model` values and print the
`x-litellm-model-id` response header.

Start each shell with:

```sh
GW=http://127.0.0.1:4000/v1/chat/completions
AUTH="Authorization: Bearer $LITELLM_MASTER_KEY"
BODY='{"model":"gpt-6-luna","messages":[{"role":"user","content":"hi"}]}'
```

The ChatGPT OAuth login is a precondition for gateway startup, not just
for Step 3. LiteLLM 1.86 starts the device-code flow while loading each
`chatgpt/` deployment and holds proxy startup until the flow completes;
with no credentials in `CHATGPT_TOKEN_DIR`, `/health/liveliness` never
answers and `litellm.service` fails its health gate. Run
`sudo litellm-chatgpt-login` (or copy the credentials JSON into the guest's
`CHATGPT_TOKEN_DIR`), restart `litellm.service`, and confirm
`curl -fsS http://127.0.0.1:4000/health/liveliness` before running any
step below.

### Step 1 - Weight distribution

Send 20 new conversations, each with a unique session header:

```sh
for i in $(seq -w 1 20); do
  curl -sS -D - -o /dev/null \
    -H "$AUTH" \
    -H 'Content-Type: application/json' \
    -H "x-opencode-session: smoke-weight-$i" \
    -H "x-opencode-session-id: smoke-weight-$i" \
    -d "$BODY" "$GW" \
    | awk 'tolower($1)=="x-litellm-model-id:"{print $2}'
done | sort | uniq -c
```

Expected observation:

```text
      9 gpt-6-luna@chatgpt
     11 gpt-6-luna@opencode-go
```

Both deployment ids appear, in roughly the configured 1:1 share. The
exact split varies; one id taking all 20 requests means placement is
concentrated, so check the deployment weights and that both deployments
are available.

### Step 2 - Affinity stability

Send several requests with one OpenCode session header:

```sh
for i in 1 2 3; do
  curl -sS -D - -o /dev/null \
    -H "$AUTH" \
    -H 'Content-Type: application/json' \
    -H 'x-opencode-session: smoke-affinity-header' \
    -H 'x-opencode-session-id: smoke-affinity-header' \
    -d "$BODY" "$GW" \
    | awk 'tolower($1)=="x-litellm-model-id:"{print $2}'
done
```

Expected observation: the same `x-litellm-model-id` on all three
responses, for example `gpt-6-luna@opencode-go` three times.

Then send several Fabro-shaped requests whose body carries the same
conversational key and a stable `User-Agent`:

```sh
for i in 1 2 3; do
  curl -sS -D - -o /dev/null \
    -H "$AUTH" \
    -H 'Content-Type: application/json' \
    -H 'x-opencode-session: fabro-litellm' \
    -H 'User-Agent: fabro-smoke/1.0' \
    -d '{"model":"gpt-6-luna",
         "prompt_cache_key":"smoke-affinity-body",
         "messages":[{"role":"user","content":"hi"}]}' "$GW" \
    | awk 'tolower($1)=="x-litellm-model-id:"{print $2}'
done
```

The curl sends Fabro's static `x-opencode-session: fabro-litellm` but no
`x-opencode-session-id`, so the body `prompt_cache_key` remains the
identity; a session-id header would win by precedence.

Expected observation: the same `x-litellm-model-id` on all three Fabro
requests, for example `gpt-6-luna@chatgpt` three times. The
header-derived and body-derived conversations are independent
namespaces, so they may land on different deployments. A different
session id or `prompt_cache_key` may choose either deployment.

### Step 3 - Forced deployment failure

This step needs the ChatGPT deployment to be logged in. It also breaks
every OpenCode Go deployment while the stray `apiBase` is set, so keep
the window short.

First, change the `opencode-go` provider's `apiBase` in
`configurations/fabro-vm/litellm-catalog.nix` to
`http://127.0.0.1:9/v1`. Rebuild the guest and restart the gateway.
Restart `fabro.service` if it is down.

Then send six requests to `gpt-6-luna` with fresh session headers:

```sh
for i in 1 2 3 4 5 6; do
  curl -sS -D - -o /dev/null \
    -H "$AUTH" \
    -H 'Content-Type: application/json' \
    -H "x-opencode-session: smoke-fail-$i" \
    -H "x-opencode-session-id: smoke-fail-$i" \
    -d "$BODY" "$GW" \
    | awk 'tolower($1)=="x-litellm-model-id:"{print $2}'
done | sort | uniq -c
```

Expected observation before the revert:

```text
      6 gpt-6-luna@chatgpt
```

Every request succeeds, and no response names `gpt-6-luna@opencode-go`.
Each request the router would have placed on the Go deployment is
retried inside the group and answered by the ChatGPT deployment, which
is the absorption this step proves. Because 1.86.0 does not cool down a
transport error, the gateway keeps trying the dead endpoint on new
placements; the repeated connection errors in `journalctl -u litellm`
are expected.

Finally, revert the `apiBase`, rebuild, and repeat Step 1: both
deployment ids appear again.

## Troubleshooting

### A client receives an unknown-model error

The gateway serves only the catalog's logical ids. Provider-scoped ids
from before the catalog change (the old `<provider>/<model>` form) are
not aliased and fail loudly. Update the client to the logical id; do not
add an alias or wildcard.

### Every deployment of a model is unavailable

The error identifies the requested logical model (LiteLLM reports the
model group and the passed model). Check `journalctl -u litellm` for the
cooldown entries. A single-deployment logical model goes fully
unavailable for `cooldown_time` after its first eligible failure; a
multi-deployment group stays up while a sibling is healthy.

### The gateway does not start after a catalog or bridge change

The callback import fails before the listener opens, so the
`/health/liveliness` gate fails the unit instead of leaving a proxy that
cannot route. `journalctl -u litellm` shows the `ImportError`; verify the
generated config directory contains both `litellm_affinity_bridge.py`
and `litellm_session_identity.py`, and that `PYTHONPATH` names that
directory.

### OpenCode Go deployments fail per request

`OPENCODE_API_KEY` is missing or unset in the runtime environment. The
proxy keeps running; only the deployments that reference
`os.environ/OPENCODE_API_KEY` fail. Check the sops-rendered `litellm-env`
file named by `sudo systemctl show litellm.service -p EnvironmentFiles`.
Rotating the secret restarts the unit through `restartUnits`.

A raw curl can also fail per request when it omits `x-opencode-session`:
the OpenCode Go/Zen upstream returns HTTP 400
`Request is missing x-opencode-session`. OpenCode and Fabro send the
header automatically; add it to manual requests as the observation and
smoke recipes do.
