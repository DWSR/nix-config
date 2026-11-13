# The single source of the fabro-vm gateway's served models. Pure data plus a
# pure constructor: no host paths, derivations, or secret values — provider
# credentials appear only as environment-variable names. `mkCatalog` is
# exported so routing checks can validate fixture tables; the gateway and
# client projections consume the validated catalog in later units.
{ lib }:
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

  # Validate and normalize one table pair, failing evaluation before any
  # projection is constructed. Exported so routing checks can feed it fixture
  # tables that are deliberately incomplete or contradictory.
  mkCatalog =
    {
      providers,
      logicalModels,
      defaultModel,
    }:
    let
      fail = message: throw "litellm-catalog: ${message}";

      providerNames = lib.attrNames providers;

      requiredDeploymentFields = [
        "provider"
        "upstreamModel"
        "mode"
        "limits.contextTokens"
        "limits.maxOutputTokens"
      ];

      agreementFields = [
        "mode"
        "requestDefaults"
        "limits.contextTokens"
        "limits.maxOutputTokens"
      ];

      hasPath =
        value: segments:
        segments == [ ]
        || (
          builtins.isAttrs value
          && builtins.hasAttr (builtins.head segments) value
          && hasPath value.${builtins.head segments} (builtins.tail segments)
        );

      hasField = deployment: field: hasPath deployment (lib.splitString "." field);

      deploymentId = logicalId: deployment: "${logicalId}@${deployment.provider or "unknown"}";

      forceAll = checks: lib.foldl' (acc: check: builtins.seq check acc) null checks;

      assertRequiredFields =
        logicalId: deployment:
        let
          missing = lib.findFirst (field: !(hasField deployment field)) null requiredDeploymentFields;
        in
        if missing == null then
          deployment
        else
          fail "logical model '${logicalId}' deployment '${deploymentId logicalId deployment}' is missing field '${missing}'";

      assertKnownProvider =
        logicalId: deployment:
        if builtins.elem deployment.provider providerNames then
          deployment
        else
          fail "logical model '${logicalId}' deployment '${deploymentId logicalId deployment}' names unknown provider '${deployment.provider}'";

      findDuplicateId =
        ids:
        (lib.foldl'
          (
            state: id:
            if state.found != null then
              state
            else if builtins.elem id state.seen then
              state // { found = id; }
            else
              state // { seen = state.seen ++ [ id ]; }
          )
          {
            seen = [ ];
            found = null;
          }
          ids
        ).found;

      assertNoDuplicateIds =
        logicalId: ids:
        let
          duplicate = findDuplicateId ids;
        in
        if duplicate == null then
          true
        else
          fail "logical model '${logicalId}' has duplicate deployment id '${duplicate}'";

      forbiddenIdToken =
        logicalId:
        if lib.hasInfix "/" logicalId then
          "/"
        else
          lib.findFirst (token: lib.hasInfix token logicalId) null providerNames;

      normalizeDeployment =
        deployment:
        deployment
        // {
          requestDefaults = deployment.requestDefaults or { };
          weight = deployment.weight or 1;
        };

      agreementValue =
        deployment: field:
        if field == "mode" then
          deployment.mode
        else if field == "requestDefaults" then
          deployment.requestDefaults
        else if field == "limits.contextTokens" then
          deployment.limits.contextTokens
        else
          deployment.limits.maxOutputTokens;

      checkAgreement =
        logicalId: first: firstId: deployment: id:
        let
          disagreement = lib.findFirst (
            field: agreementValue first field != agreementValue deployment field
          ) null agreementFields;
        in
        if disagreement == null then
          true
        else
          fail "logical model '${logicalId}' deployments '${firstId}' and '${id}' disagree on '${disagreement}'";

      validateLogicalModel =
        logicalId: model:
        let
          deployments = model.deployments or [ ];
          ids = map (deploymentId logicalId) deployments;
          normalized = map normalizeDeployment deployments;
          checks =
            map (assertRequiredFields logicalId) deployments
            ++ map (assertKnownProvider logicalId) deployments
            ++ [ (assertNoDuplicateIds logicalId ids) ]
            ++ builtins.genList (
              index:
              checkAgreement logicalId (builtins.head normalized) (builtins.head ids) (builtins.elemAt normalized
                (index + 1)
              ) (builtins.elemAt ids (index + 1))
            ) (builtins.length normalized - 1);
        in
        if deployments == [ ] then
          fail "logical model '${logicalId}' has no deployments"
        else if forbiddenIdToken logicalId != null then
          fail "logical model '${logicalId}' must not contain provider or path token '${forbiddenIdToken logicalId}'"
        else
          builtins.seq (forceAll checks) (
            model
            // {
              displayName = model.displayName or logicalId;
              deployments = normalized;
            }
          );

      normalizedLogicalModels = lib.mapAttrs (
        logicalId: model: validateLogicalModel logicalId model
      ) logicalModels;

      validateAll =
        tables: builtins.all (logicalId: builtins.isAttrs tables.${logicalId}) (lib.attrNames tables);
    in
    builtins.seq (validateAll normalizedLogicalModels) (
      if !(builtins.hasAttr defaultModel normalizedLogicalModels) then
        fail "default model '${defaultModel}' is not a logical model"
      else
        {
          tables = {
            inherit providers;
            logicalModels = normalizedLogicalModels;
            inherit defaultModel;
          };
        }
    );
in
{
  inherit mkCatalog;
  catalog = mkCatalog { inherit providers logicalModels defaultModel; };
}
