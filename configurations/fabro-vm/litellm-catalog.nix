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
# `mkCatalog` is a pure constructor exported for fixture-based tests; it
# validates the table before returning any projection and throws at evaluation
# time on a missing required field, an unknown provider reference, a group with
# no deployments, a provider-scoped or duplicate id, or a group whose
# deployments disagree on their client-visible semantics. `catalog` is the
# repository table already passed through `mkCatalog`.
{ lib }:
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
let
  # ---------------------------------------------------------------------------
  # Validation
  #
  # Validation is a total function over the table and runs before any
  # projection is returned, so a malformed table fails Nix evaluation instead
  # of producing a gateway or client config with a bad id. Every message names
  # the offending logical model, provider, or deployment and the field.
  # ---------------------------------------------------------------------------

  error = message: "litellm-catalog: ${message}";

  requiredProviderFields = [
    "modelPrefix"
    "apiBase"
    "apiKeyEnvVar"
    "allowedOpenAIParams"
    "requiresClientSessionHeader"
  ];

  requiredLogicalModelFields = [
    "displayName"
    "deployments"
  ];

  requiredDeploymentFields = [
    "provider"
    "upstreamModel"
    "mode"
    "requestDefaults"
    "contextWindow"
    "maxOutputTokens"
  ];

  # A difference in any of these makes two logical models rather than one
  # unified group, so the group must agree on all of them.
  agreementFields = [
    "mode"
    "requestDefaults"
    "contextWindow"
    "maxOutputTokens"
  ];

  hasField = attrs: field: builtins.hasAttr field attrs;

  # Error messages label a deployment `<logical>/<provider>`, matching the
  # design's `deployment '<id>' is missing field '<field>'` shape. The
  # client-visible deployment id is `<logical>@<provider>` and is only built
  # when generating the gateway `model_list`.
  deploymentLabel = logicalId: deployment: "${logicalId}/${deployment.provider or "<no-provider>"}";

  missingFieldErrors =
    kind: label: fields: attrs:
    map (field: error "${kind} '${label}' is missing field '${field}'") (
      builtins.filter (field: !(hasField attrs field)) fields
    );

  # Strings are quoted with single quotes to match the design text; everything
  # else uses its JSON form, which is deterministic for attrsets and lists.
  renderValue = value: if builtins.isString value then "'${value}'" else builtins.toJSON value;

  providersOf = catalogTable: catalogTable.providers or { };

  providerErrors =
    catalogTable:
    lib.concatLists (
      lib.mapAttrsToList (
        key: provider: missingFieldErrors "provider" key requiredProviderFields provider
      ) (providersOf catalogTable)
    );

  # Ids are client-callable and provider-agnostic: no slash (the provider-scoped
  # shape) and no provider key token anywhere in the id.
  idErrors =
    catalogTable: logicalId:
    lib.optional (lib.hasInfix "/" logicalId) (
      error "logical model id '${logicalId}' must not contain '/' (client-callable ids are provider-agnostic)"
    )
    ++
      map
        (
          providerKey:
          error "logical model id '${logicalId}' embeds provider key token '${providerKey}' (client-callable ids are provider-agnostic)"
        )
        (
          builtins.filter (providerKey: lib.hasInfix providerKey logicalId) (
            builtins.attrNames (providersOf catalogTable)
          )
        );

  deploymentErrors =
    catalogTable: logicalId: deployment:
    let
      label = deploymentLabel logicalId deployment;
      provider = deployment.provider or null;
    in
    missingFieldErrors "deployment" label requiredDeploymentFields deployment
    ++ lib.optional (provider != null && !(builtins.hasAttr provider (providersOf catalogTable))) (
      error "deployment '${label}' names unknown provider '${provider}'"
    )
    ++
      lib.optional
        (
          hasField deployment "mode"
          && !(builtins.elem deployment.mode [
            "chat"
            "responses"
          ])
        )
        (
          error "deployment '${label}' has invalid mode ${renderValue deployment.mode} (expected 'chat' or 'responses')"
        )
    ++
      lib.optional
        (hasField deployment "weight" && !(builtins.isInt deployment.weight && deployment.weight >= 1))
        (
          error "deployment '${label}' has invalid weight ${renderValue deployment.weight} (expected a positive integer)"
        );

  # Duplicate `model_info.id`s can only occur inside one group, because the id
  # is `<logical>@<provider>` and logical ids are attrset keys.
  duplicateIdErrors =
    logicalId: deployments:
    let
      modelInfoIds = map (
        deployment: "${logicalId}@${deployment.provider or "<no-provider>"}"
      ) deployments;
      duplicated = builtins.filter (
        id: builtins.length (builtins.filter (other: other == id) modelInfoIds) > 1
      ) (lib.unique modelInfoIds);
    in
    map (id: error "logical model '${logicalId}' declares duplicate model_info.id '${id}'") duplicated;

  # Each later deployment is compared with the group's first deployment; the
  # message names the field, the logical model, and both deployments.
  conflictErrors =
    logicalId: deployments:
    if deployments == [ ] then
      [ ]
    else
      let
        reference = builtins.head deployments;
        referenceLabel = deploymentLabel logicalId reference;
      in
      lib.concatMap (
        field:
        map
          (
            deployment:
            error "logical model '${logicalId}' disagrees on ${field}: '${referenceLabel}'=${
              renderValue (reference.${field} or null)
            }, '${deploymentLabel logicalId deployment}'=${renderValue (deployment.${field} or null)}"
          )
          (
            builtins.filter (deployment: (deployment.${field} or null) != (reference.${field} or null)) (
              builtins.tail deployments
            )
          )
      ) agreementFields;

  logicalModelErrors =
    catalogTable: logicalId:
    let
      logicalModel = catalogTable.logicalModels.${logicalId};
      deployments = logicalModel.deployments or [ ];
    in
    idErrors catalogTable logicalId
    ++ missingFieldErrors "logical model" logicalId requiredLogicalModelFields logicalModel
    ++ lib.optional (hasField logicalModel "deployments" && deployments == [ ]) (
      error "logical model '${logicalId}' has no deployments (a client-callable id must resolve to at least one)"
    )
    ++ lib.concatMap (deploymentErrors catalogTable logicalId) deployments
    ++ duplicateIdErrors logicalId deployments
    ++ conflictErrors logicalId deployments;

  tableErrors =
    catalogTable:
    providerErrors catalogTable
    ++ lib.concatMap (logicalModelErrors catalogTable) (
      builtins.attrNames (catalogTable.logicalModels or { })
    );

  # Validate before returning anything; the first error in table order is the
  # one reported, so a fixture failure is deterministic.
  validate =
    catalogTable: result:
    let
      errors = tableErrors catalogTable;
    in
    if errors == [ ] then result else throw (builtins.head errors);

  # Pure constructor exported for fixture-based failure tests. Later units add
  # the gateway and client projections here, after this validation.
  mkCatalog =
    catalogTable:
    validate catalogTable {
      logicalModels = catalogTable.logicalModels;
    };
in
{
  inherit table mkCatalog;

  # The repository's table, already validated.
  catalog = mkCatalog table;
}
