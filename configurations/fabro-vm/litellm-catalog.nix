# Deployment catalog for the fabro-vm LiteLLM gateway: the single declarative
# source of the served model ids and of both client model surfaces. This file
# is evaluation data only — no host paths, no secrets, no derivations. A
# credential appears here solely as the environment-variable *name* that the
# gateway resolves at request time (`os.environ/<VAR>`).
#
# Shape:
#
#   providers.<key>        how to reach one upstream subscription, and whether
#                          its wire requires the client session header
#   logicalModels.<id>     the client-callable id (never provider-scoped) plus
#                          its ordered deployments and client metadata
#   defaultModel           the id both client surfaces start from
#
# A logical model's deployments must agree on wire mode, request-affecting
# defaults, and effective limits: they are one Unified Model Group, and the
# gateway may serve any of them for the same id. `gpt-6-luna` is the only
# group with more than one deployment today (the ChatGPT subscription and the
# OpenCode Go subscription); every other id is a single-deployment model.
#
# All deployments start at equal `weight`; the operator changes a weight in
# this table and the gateway regenerates its deployment list on reload.
#
# This file is the table alone: it imports nothing, derives nothing, and
# evaluates to a plain attrset. Validation and the gateway/client projections
# are layered on top of it elsewhere in the catalog module.
let
  # Provider table. `modelPrefix` is LiteLLM's provider route (what the
  # upstream call is addressed with), never part of a client-callable id.
  #
  # `allowedOpenAIParams` is the 1.86.0 param-allowlist workaround: the
  # per-provider allowlists predate the ids served here, so `reasoning_effort`
  # — both a consumer's request value and each deployment's pinned default —
  # is rejected by the proxy's UnsupportedParamsError gate before it reaches
  # the upstream unless the model re-permits it. Every provider here serves a
  # deployment that carries reasoning parameters, so every provider lists it.
  #
  # `requiresClientSessionHeader` drives forwarding: the OpenCode Go and Zen
  # gateways reject requests without a stable x-opencode-session header, so
  # the groups that contain one of those providers forward the client's
  # x-* allowlist upstream. The ChatGPT Codex backend needs no such header.
  providers = {
    chatgpt = {
      modelPrefix = "chatgpt/";
      apiBase = null;
      apiKeyEnvVar = null;
      allowedOpenAIParams = [ "reasoning_effort" ];
      requiresClientSessionHeader = false;
    };

    opencode-go = {
      modelPrefix = "openai/";
      apiBase = "https://opencode.ai/zen/go/v1";
      apiKeyEnvVar = "OPENCODE_API_KEY";
      allowedOpenAIParams = [ "reasoning_effort" ];
      requiresClientSessionHeader = true;
    };

    # Big Pickle is not part of the Go catalog: the stealth model serves on
    # the Zen balance endpoint, which the OpenCode API key reaches unchanged
    # (usage draws from the balance behind the Go subscription).
    opencode-zen = {
      modelPrefix = "openai/";
      apiBase = "https://opencode.ai/zen/v1";
      apiKeyEnvVar = "OPENCODE_API_KEY";
      allowedOpenAIParams = [ "reasoning_effort" ];
      requiresClientSessionHeader = true;
    };
  };

  logicalModels = {
    # One Unified Model Group: both subscriptions serve the same upstream
    # model on the same wire with the same pinned effort and window, so either
    # deployment answers the `gpt-6-luna` id. Equal weight keeps the two
    # subscriptions' request shares even until the operator changes them.
    "gpt-6-luna" = {
      displayName = "GPT-6 Luna";
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6-luna";
          mode = "responses";
          requestDefaults.reasoning_effort = "xhigh";
          contextWindow = 1050000;
          maxOutputTokens = 128000;
          weight = 1;
        }
        {
          provider = "opencode-go";
          upstreamModel = "gpt-6-luna";
          mode = "responses";
          requestDefaults.reasoning_effort = "xhigh";
          contextWindow = 1050000;
          maxOutputTokens = 128000;
          weight = 1;
        }
      ];
      # Union of both deployments' advertised efforts; the ChatGPT entry
      # advertises xhigh while the OpenCode Go entry exposes the full range.
      reasoningEffortLevels = [
        "low"
        "medium"
        "high"
        "xhigh"
        "max"
      ];
    };

    # The no-thinking variant stays a separate ChatGPT-only logical model:
    # its pinned `none` effort is a request-affecting default, so it cannot
    # share the group above. Lithos has no `none` effort (minimal..max), so
    # Fabro sends no effort and this deployment default applies.
    "gpt-6-luna-none" = {
      displayName = "GPT-6 Luna (no thinking)";
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6-luna";
          mode = "responses";
          requestDefaults.reasoning_effort = "none";
          contextWindow = 1050000;
          maxOutputTokens = 128000;
          weight = 1;
        }
      ];
    };

    "gpt-6-astra" = {
      displayName = "GPT-6 Astra";
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6-astra";
          mode = "responses";
          requestDefaults.reasoning_effort = "xhigh";
          contextWindow = 1050000;
          maxOutputTokens = 128000;
          weight = 1;
        }
      ];
      reasoningEffortLevels = [ "xhigh" ];
    };

    "gpt-6.1-sol" = {
      displayName = "GPT-6.1 Sol";
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6.1-sol";
          mode = "responses";
          requestDefaults.reasoning_effort = "xhigh";
          contextWindow = 1050000;
          maxOutputTokens = 128000;
          weight = 1;
        }
      ];
      reasoningEffortLevels = [ "xhigh" ];
    };

    # The default model for both client surfaces: the cheap parity tier for
    # chat/completions traffic, and Fabro's small utility-task pick.
    "deepseek-v4.1-flash" = {
      displayName = "DeepSeek V4.1 Flash";
      smallDefault = true;
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "deepseek-v4.1-flash";
          mode = "chat";
          requestDefaults = { };
          # DeepSeek's published V4 ceiling: 1M total context, 384k output.
          contextWindow = 1000000;
          maxOutputTokens = 384000;
          weight = 1;
        }
      ];
    };

    "glm-5.3-flash" = {
      displayName = "GLM-5.3 Flash";
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "glm-5.3-flash";
          mode = "chat";
          requestDefaults = { };
          contextWindow = 1000000;
          maxOutputTokens = 131072;
          weight = 1;
        }
      ];
      reasoningEffortLevels = [
        "low"
        "high"
        "max"
      ];
    };

    "longcat-2.5-preview-free" = {
      displayName = "LongCat 2.5 Preview Free";
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "longcat-2.5-preview-free";
          mode = "chat";
          requestDefaults = { };
          # Same family tier and chat-model window as longcat-2.0's serving;
          # upstream publishes no separate hard output cap.
          contextWindow = 1000000;
          maxOutputTokens = 131072;
          weight = 1;
        }
      ];
    };

    "big-pickle" = {
      displayName = "Big Pickle";
      deployments = [
        {
          provider = "opencode-zen";
          upstreamModel = "big-pickle";
          mode = "chat";
          requestDefaults = { };
          contextWindow = 200000;
          maxOutputTokens = 32000;
          weight = 1;
        }
      ];
    };
  };
in
{
  table = {
    defaultModel = "deepseek-v4.1-flash";
    inherit providers logicalModels;
  };
}
