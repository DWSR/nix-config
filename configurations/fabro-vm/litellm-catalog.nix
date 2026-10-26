# Declarative model catalog for the fabro-vm LiteLLM gateway.
#
# This file is the only source of the gateway's served model ids and of the
# model surfaces both clients render: the provider table and the logical-model
# table below are projected into the gateway `model_list`, the forwarding list,
# and the OpenCode/Fabro model maps. Adding a provider, a model, or a weight is
# a table entry, never a client or module change.
#
# Provider-agnostic ids: a logical-model key is the client-callable id, contains
# no `/`, and never embeds a provider key. A Deployment is the provider-side
# binding of one logical model:
#
#   provider         key in `providers`
#   upstreamModel    provider-side model id (the only place a provider-scoped
#                    upstream id is allowed to appear)
#   mode             client-visible wire mode (`chat` or `responses`)
#   requestDefaults  request-affecting defaults pinned on the deployment
#   contextWindow    -> model_info.max_input_tokens
#   maxOutputTokens  -> model_info.max_output_tokens
#   weight           placement weight; emitted explicitly, defaults to 1
#
# Every deployment of a logical model must agree on `mode`, `requestDefaults`,
# `contextWindow`, and `maxOutputTokens`; a semantic difference makes two
# logical models rather than one unified group. `gpt-6-luna` is the only group
# with more than one deployment today.
#
# The table is pure data: no host paths, secrets, or derivations. A credential
# appears only as the runtime environment-variable name the provider consumes.
#
# The module ignores its argument today; the validation and projection helpers
# added beside the table will consume `lib` without changing the import shape.
_:
let
  table = {
    # Shared default for both client surfaces.
    defaultModel = "deepseek-v4.1-flash";

    providers = {
      # ChatGPT subscription (Codex backend): OAuth device flow, no API key or
      # base URL. The proxy holds startup until the flow completes.
      chatgpt = {
        modelPrefix = "chatgpt/";
        apiBase = null;
        apiKeyEnvVar = null;
        allowedOpenAIParams = [ "reasoning_effort" ];
        requiresClientSessionHeader = false;
      };

      # OpenCode Go subscription; the OpenCode API key also reaches the Zen
      # balance endpoint. Its upstream requires a stable client session header.
      opencode-go = {
        modelPrefix = "openai/";
        apiBase = "https://opencode.ai/zen/go/v1";
        apiKeyEnvVar = "OPENCODE_API_KEY";
        allowedOpenAIParams = [ "reasoning_effort" ];
        requiresClientSessionHeader = true;
      };

      # OpenCode Zen balance endpoint (not part of the Go catalog); same key.
      opencode-zen = {
        modelPrefix = "openai/";
        apiBase = "https://opencode.ai/zen/v1";
        apiKeyEnvVar = "OPENCODE_API_KEY";
        allowedOpenAIParams = [ "reasoning_effort" ];
        requiresClientSessionHeader = true;
      };
    };

    logicalModels = {
      # Unified group: the same upstream model on two subscriptions. Both
      # deployments pin the same effort so the group stays semantically equal.
      gpt-6-luna = {
        displayName = "GPT-6 Luna";
        deployments = [
          {
            provider = "chatgpt";
            upstreamModel = "gpt-6-luna";
            mode = "responses";
            requestDefaults = {
              reasoning_effort = "xhigh";
            };
            contextWindow = 1050000;
            maxOutputTokens = 128000;
            weight = 1;
          }
          {
            provider = "opencode-go";
            upstreamModel = "gpt-6-luna";
            mode = "responses";
            requestDefaults = {
              reasoning_effort = "xhigh";
            };
            contextWindow = 1050000;
            maxOutputTokens = 128000;
            weight = 1;
          }
        ];
      };

      # The no-thinking variant stays a separate ChatGPT-only logical model
      # because its request defaults differ from the unified group.
      gpt-6-luna-none = {
        displayName = "GPT-6 Luna (no thinking)";
        deployments = [
          {
            provider = "chatgpt";
            upstreamModel = "gpt-6-luna";
            mode = "responses";
            requestDefaults = {
              reasoning_effort = "none";
            };
            contextWindow = 1050000;
            maxOutputTokens = 128000;
            weight = 1;
          }
        ];
      };

      gpt-6-astra = {
        displayName = "GPT-6 Astra";
        deployments = [
          {
            provider = "chatgpt";
            upstreamModel = "gpt-6-astra";
            mode = "responses";
            requestDefaults = {
              reasoning_effort = "xhigh";
            };
            contextWindow = 1050000;
            maxOutputTokens = 128000;
            weight = 1;
          }
        ];
      };

      "gpt-6.1-sol" = {
        displayName = "GPT-6.1 Sol";
        deployments = [
          {
            provider = "chatgpt";
            upstreamModel = "gpt-6.1-sol";
            mode = "responses";
            requestDefaults = {
              reasoning_effort = "xhigh";
            };
            contextWindow = 1050000;
            maxOutputTokens = 128000;
            weight = 1;
          }
        ];
      };

      "deepseek-v4.1-flash" = {
        displayName = "DeepSeek V4.1 Flash";
        deployments = [
          {
            provider = "opencode-go";
            upstreamModel = "deepseek-v4.1-flash";
            mode = "chat";
            requestDefaults = { };
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
      };

      "longcat-2.5-preview-free" = {
        displayName = "LongCat 2.5 Preview Free";
        deployments = [
          {
            provider = "opencode-go";
            upstreamModel = "longcat-2.5-preview-free";
            mode = "chat";
            requestDefaults = { };
            contextWindow = 1000000;
            maxOutputTokens = 131072;
            weight = 1;
          }
        ];
      };

      big-pickle = {
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
  };
in
{
  inherit table;
}
