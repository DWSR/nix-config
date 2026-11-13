# The single source of the fabro-vm gateway's served models. Pure data: no
# host paths, derivations, or secret values — provider credentials appear only
# as environment-variable names. Validation and the gateway/client projections
# consume these tables in later units of this module.
_:
let
  # Upstream providers. `modelPrefix` and `apiBase` shape a deployment's
  # `litellm_params.model`/`api_base`; `apiKeyEnvVar` names the runtime env
  # var (never a value); `requiresClientSessionHeader` decides whether the
  # gateway forwards the client's session headers for the logical model.
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
    opencode-zen = {
      modelPrefix = "openai/";
      apiBase = "https://opencode.ai/zen/v1";
      apiKeyEnvVar = "OPENCODE_API_KEY";
      allowedOpenAIParams = [ "reasoning_effort" ];
      requiresClientSessionHeader = true;
    };
  };

  # One entry per client-callable id. Each deployment carries its own wire
  # mode, request defaults, effective limits, and weight; group agreement is
  # enforced by the validation unit. `reasoningEffortLevels` and
  # `smallDefault` are Fabro-surface extras.
  logicalModels = {
    gpt-6-luna = {
      displayName = "GPT-6 Luna (xhigh)";
      reasoningEffortLevels = [ "xhigh" ];
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6-luna";
          mode = "responses";
          requestDefaults = {
            reasoning_effort = "xhigh";
          };
          limits = {
            contextTokens = 1050000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
        {
          provider = "opencode-go";
          upstreamModel = "gpt-6-luna";
          mode = "responses";
          requestDefaults = {
            reasoning_effort = "xhigh";
          };
          limits = {
            contextTokens = 1050000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
      ];
    };

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
          limits = {
            contextTokens = 1050000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
      ];
    };

    gpt-6-astra = {
      displayName = "GPT-6 Astra (xhigh)";
      reasoningEffortLevels = [ "xhigh" ];
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6-astra";
          mode = "responses";
          requestDefaults = {
            reasoning_effort = "xhigh";
          };
          limits = {
            contextTokens = 1050000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
      ];
    };

    "gpt-6.1-sol" = {
      displayName = "GPT-6.1 Sol (xhigh)";
      reasoningEffortLevels = [ "xhigh" ];
      deployments = [
        {
          provider = "chatgpt";
          upstreamModel = "gpt-6.1-sol";
          mode = "responses";
          requestDefaults = {
            reasoning_effort = "xhigh";
          };
          limits = {
            contextTokens = 1050000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
      ];
    };

    "deepseek-v4.1-flash" = {
      displayName = "DeepSeek V4.1 Flash";
      smallDefault = true;
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "deepseek-v4.1-flash";
          mode = "chat";
          requestDefaults = { };
          limits = {
            contextTokens = 1000000;
            maxOutputTokens = 384000;
          };
          weight = 1;
        }
      ];
    };

    "glm-5.3-flash" = {
      displayName = "GLM-5.3 Flash";
      reasoningEffortLevels = [
        "low"
        "high"
        "max"
      ];
      deployments = [
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
      ];
    };

    beam-free = {
      displayName = "Beam Free";
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "beam-free";
          mode = "chat";
          requestDefaults = { };
          limits = {
            contextTokens = 1048576;
            maxOutputTokens = 131072;
          };
          weight = 1;
        }
      ];
    };

    omen-alpha = {
      displayName = "Omen Alpha";
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "omen-alpha";
          mode = "chat";
          requestDefaults = { };
          limits = {
            contextTokens = 500000;
            maxOutputTokens = 128000;
          };
          weight = 1;
        }
      ];
    };

    "longcat-2.0" = {
      displayName = "LongCat 2.0";
      deployments = [
        {
          provider = "opencode-go";
          upstreamModel = "longcat-2.0";
          mode = "chat";
          requestDefaults = { };
          limits = {
            contextTokens = 1000000;
            maxOutputTokens = 131072;
          };
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
          limits = {
            contextTokens = 200000;
            maxOutputTokens = 32000;
          };
          weight = 1;
        }
      ];
    };
  };

  defaultModel = "deepseek-v4.1-flash";
in
{
  tables = {
    inherit providers logicalModels defaultModel;
  };
}
