{
  lib,
  pkgs,
  trustedDevxOutPath ? null,
}:
let
  bashTimeoutBinding = {
    environmentName = "PI_AGENT_BASH_TIMEOUT_MS";
    targets = [
      "rootPi"
      "foregroundChildPi"
    ];
  };
  resolverKinds = [
    "pi-auth"
    "shopify-gateway-token"
    "shopify-gateway-base"
  ];
  sensitiveNames = lib.sort builtins.lessThan [
    "AGENTMEMORY_SECRET"
    "AI_GATEWAY_API_KEY"
    "ANTHROPIC_API_KEY"
    "ANTHROPIC_AUTH_TOKEN"
    "ANTHROPIC_OAUTH_TOKEN"
    "ANT_LING_API_KEY"
    "AWS_ACCESS_KEY_ID"
    "AWS_BEARER_TOKEN_BEDROCK"
    "AWS_CONTAINER_CREDENTIALS_FULL_URI"
    "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI"
    "AWS_PROFILE"
    "AWS_SECRET_ACCESS_KEY"
    "AWS_SESSION_TOKEN"
    "AWS_WEB_IDENTITY_TOKEN_FILE"
    "AZURE_OPENAI_API_KEY"
    "CEREBRAS_API_KEY"
    "CLOUDFLARE_API_KEY"
    "COPILOT_GITHUB_TOKEN"
    "DEEPSEEK_API_KEY"
    "FIREWORKS_API_KEY"
    "GEMINI_API_KEY"
    "GOOGLE_APPLICATION_CREDENTIALS"
    "GOOGLE_CLOUD_API_KEY"
    "GROQ_API_KEY"
    "HF_TOKEN"
    "KIMI_API_KEY"
    "LLAMA_API_KEY"
    "MCPPROXY_API_KEY"
    "MINIMAX_API_KEY"
    "MINIMAX_CN_API_KEY"
    "MISTRAL_API_KEY"
    "MOONSHOT_API_KEY"
    "NVIDIA_API_KEY"
    "OPENAI_API_KEY"
    "OPENCODE_API_KEY"
    "OPENROUTER_API_KEY"
    "PI_AGENT_LAUNCH_ID"
    "QWEN_TOKEN_PLAN_API_KEY"
    "QWEN_TOKEN_PLAN_CN_API_KEY"
    "RADIUS_API_KEY"
    "SHOPIFY_PI_TOKEN"
    "TOGETHER_API_KEY"
    "XAI_API_KEY"
    "XIAOMI_API_KEY"
    "XIAOMI_TOKEN_PLAN_AMS_API_KEY"
    "XIAOMI_TOKEN_PLAN_CN_API_KEY"
    "XIAOMI_TOKEN_PLAN_SGP_API_KEY"
    "ZAI_API_KEY"
    "ZAI_CODING_CN_API_KEY"
  ];
  shellAllowlist = [
    "COLORTERM"
    "HOME"
    "LANG"
    "LC_ALL"
    "LC_CTYPE"
    "LOGNAME"
    "NO_COLOR"
    "PATH"
    "SHELL"
    "TERM"
    "TERM_PROGRAM"
    "TMPDIR"
    "USER"
    "XDG_CACHE_HOME"
    "XDG_CONFIG_HOME"
    "XDG_DATA_HOME"
    "XDG_STATE_HOME"
  ];
  rootPiEnvironmentAllowlist = lib.sort builtins.lessThan (
    shellAllowlist
    ++ [
      "NIX_SSL_CERT_FILE"
      "SSL_CERT_FILE"
    ]
  );
  shellRemoveNames = lib.sort builtins.lessThan (
    lib.unique (sensitiveNames ++ [ bashTimeoutBinding.environmentName ])
  );
  managedShell = pkgs.callPackage ../../../scripts/pi-agent-shell.nix {
    inherit shellAllowlist;
    removeNames = shellRemoveNames;
  };
  shellExecutable = "${managedShell}/bin/pi-agent-shell";
  spawnEnvironmentPartitions = {
    rootPi = "rootPiEnvironment";
    foregroundChildPi = "childPiEnvironment";
    builtInBash = "scrubbedEnvironment";
    backgroundPipe = "scrubbedEnvironment";
    backgroundPty = "scrubbedEnvironment";
    languageServer = "scrubbedEnvironment";
    statusProbe = "scrubbedEnvironment";
    validatorProbe = "scrubbedEnvironment";
  };
  fixedArgv = {
    shopify-gateway-token = [
      "llm-gateway"
      "print-token"
      "--key"
    ];
    shopify-gateway-base = [
      "llm-gateway"
      "print-token"
      "--base"
    ];
  };
  deriveResolverPlans =
    { hostSelection }:
    if hostSelection.mode == "personal" then
      [ { kind = "pi-auth"; } ]
    else if hostSelection.mode == "shopify-gateway" then
      let
        executable =
          if trustedDevxOutPath == null then
            throw "pi-agent credential policy requires a trusted module-owned devx output in Shopify mode"
          else
            "${trustedDevxOutPath}/bin/devx";
      in
      [
        {
          kind = "shopify-gateway-token";
          inherit executable;
        }
        {
          kind = "shopify-gateway-base";
          inherit executable;
        }
      ]
    else
      throw "pi-agent credential policy host selection must be personal or shopify-gateway";
  renderRuntimeModule =
    mode: resolverPlans:
    pkgs.writeTextFile {
      name = "pi-agent-credential-policy";
      destination = "/lib/pi-agent/credential-policy.mjs";
      text = ''
        const MODE = ${builtins.toJSON mode};
        const BASH_TIMEOUT_BINDING_VALUE = ${builtins.toJSON bashTimeoutBinding};
        const ROOT_PI_ENVIRONMENT_ALLOWLIST_VALUES = ${builtins.toJSON rootPiEnvironmentAllowlist};
        const RESOLVER_PLAN_VALUES = ${builtins.toJSON resolverPlans};
        const SENSITIVE_NAME_VALUES = ${builtins.toJSON sensitiveNames};
        const SHELL_ALLOWLIST_VALUES = ${builtins.toJSON shellAllowlist};
        const SHELL_REMOVE_NAME_VALUES = ${builtins.toJSON shellRemoveNames};
        const SPAWN_ENVIRONMENT_PARTITION_VALUES = ${builtins.toJSON spawnEnvironmentPartitions};

        function deepFreeze(value) {
          if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
            for (const child of Object.values(value)) {
              deepFreeze(child);
            }
            Object.freeze(value);
          }
          return value;
        }

        function invalid(path, message) {
          throw new Error("invalid credential policy input at " + path + ": " + message);
        }

        function snapshotPlainObject(value, expected, path) {
          if (
            value === null ||
            Array.isArray(value) ||
            typeof value !== "object" ||
            Object.getPrototypeOf(value) !== Object.prototype
          ) {
            invalid(path, "expected a closed plain data object");
          }
          const ownKeys = Reflect.ownKeys(value);
          if (ownKeys.some((key) => typeof key === "symbol")) {
            invalid(path, "symbol properties are not permitted");
          }
          const actual = ownKeys.sort();
          const required = [...expected].sort();
          if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
            invalid(path, "fields must match the closed schema");
          }
          const snapshot = {};
          for (const key of required) {
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !("value" in descriptor)) {
              invalid(path, "fields must be own plain data properties");
            }
            snapshot[key] = descriptor.value;
          }
          return Object.freeze(snapshot);
        }

        function requireNonEmptyString(value, path) {
          if (typeof value !== "string" || value.length === 0) {
            invalid(path, "expected an injected validated non-empty string");
          }
        }

        function requireCanonicalLaunchUuid(value) {
          if (
            typeof value !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
          ) {
            invalid("launchId", "expected a canonical version 4 UUID");
          }
        }

        function requireBashDefaultMs(value) {
          if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
            invalid("bashDefaultMs", "expected an integer from 1 through 2147483647 milliseconds");
          }
        }

        function nonSerializableObject(values, description) {
          const result = { ...values };
          Object.defineProperty(result, "toJSON", {
            configurable: false,
            enumerable: false,
            writable: false,
            value() {
              throw new Error(description + " is not serializable");
            },
          });
          return Object.freeze(result);
        }

        function readonlySecretMembership(values) {
          const membership = new Set(values);
          const view = {};
          Object.defineProperties(view, {
            size: {
              configurable: false,
              enumerable: false,
              get: () => membership.size,
            },
            has: {
              configurable: false,
              enumerable: false,
              writable: false,
              value: (candidate) => membership.has(candidate),
            },
            values: {
              configurable: false,
              enumerable: false,
              writable: false,
              value: () => membership.values(),
            },
            toJSON: {
              configurable: false,
              enumerable: false,
              writable: false,
              value() {
                throw new Error("exact redaction values are not serializable");
              },
            },
            [Symbol.iterator]: {
              configurable: false,
              enumerable: false,
              writable: false,
              value: () => membership.values(),
            },
          });
          return Object.freeze(view);
        }

        function scrubbedEnvironmentSnapshot(environment) {
          if (
            environment === null ||
            Array.isArray(environment) ||
            typeof environment !== "object" ||
            Object.getPrototypeOf(environment) !== Object.prototype
          ) {
            invalid("environment", "expected a plain data object");
          }
          const scrubbed = {};
          for (const name of Reflect.ownKeys(environment)) {
            if (typeof name === "symbol") {
              invalid("environment", "symbol properties are not permitted");
            }
            const descriptor = Object.getOwnPropertyDescriptor(environment, name);
            if (!descriptor || !("value" in descriptor)) {
              invalid("environment", "fields must be own plain data properties");
            }
            if (
              SHELL_ALLOWLIST_VALUES.includes(name) &&
              !shellRemoveNameSet.has(name) &&
              typeof descriptor.value === "string"
            ) {
              scrubbed[name] = descriptor.value;
            }
          }
          return Object.freeze(scrubbed);
        }

        export const bashTimeoutBinding = deepFreeze(BASH_TIMEOUT_BINDING_VALUE);
        export const rootPiEnvironmentAllowlist = deepFreeze(ROOT_PI_ENVIRONMENT_ALLOWLIST_VALUES);
        export const resolverPlans = deepFreeze(RESOLVER_PLAN_VALUES);
        export const sensitiveNames = deepFreeze(SENSITIVE_NAME_VALUES);
        export const spawnEnvironmentPartitions = deepFreeze(SPAWN_ENVIRONMENT_PARTITION_VALUES);
        export const scrubbedShellContract = deepFreeze({
          kind: "allowlist-v1",
          environment: "scrubbedEnvironment",
          allow: [...SHELL_ALLOWLIST_VALUES],
          remove: [...SHELL_REMOVE_NAME_VALUES],
        });

        const shellRemoveNameSet = new Set(SHELL_REMOVE_NAME_VALUES);

        export function scrubEnvironment(environment) {
          return scrubbedEnvironmentSnapshot(environment);
        }

        export function createBashRuntimeInputs(input) {
          const runtimeInput = snapshotPlainObject(input, ["bashDefaultMs"], "$bashRuntime");
          requireBashDefaultMs(runtimeInput.bashDefaultMs);
          const value = String(runtimeInput.bashDefaultMs);
          return deepFreeze({
            rootPiEnvironment: { [bashTimeoutBinding.environmentName]: value },
            childPiEnvironment: { [bashTimeoutBinding.environmentName]: value },
          });
        }

        export function createProviderRuntimeSecrets(input) {
          const runtimeInput = snapshotPlainObject(input, ["resolverResults", "launchId"], "$runtime");

          if (MODE === "personal") {
            snapshotPlainObject(runtimeInput.resolverResults, [], "resolverResults");
            if (runtimeInput.launchId !== null) {
              invalid("launchId", "personal mode does not accept a launch UUID");
            }
            return nonSerializableObject(
              {
                mode: "personal",
                rootPiEnvironment: nonSerializableObject({}, "root Pi provider environment"),
                childPiEnvironment: nonSerializableObject({}, "child Pi provider environment"),
                exactRedactionValues: readonlySecretMembership([]),
              },
              "provider runtime secrets",
            );
          }

          const resolverResults = snapshotPlainObject(
            runtimeInput.resolverResults,
            ["shopify-gateway-token", "shopify-gateway-base"],
            "resolverResults",
          );
          const token = resolverResults["shopify-gateway-token"];
          const launchId = runtimeInput.launchId;
          requireNonEmptyString(token, "resolverResults.shopify-gateway-token");
          requireNonEmptyString(
            resolverResults["shopify-gateway-base"],
            "resolverResults.shopify-gateway-base",
          );
          requireCanonicalLaunchUuid(launchId);

          const rootPiEnvironment = nonSerializableObject({
            SHOPIFY_PI_TOKEN: token,
            PI_AGENT_LAUNCH_ID: launchId,
          }, "root Pi provider environment");
          const childPiEnvironment = nonSerializableObject({
            SHOPIFY_PI_TOKEN: token,
            PI_AGENT_LAUNCH_ID: launchId,
          }, "child Pi provider environment");
          return nonSerializableObject(
            {
              mode: "shopify-gateway",
              token,
              launchId,
              rootPiEnvironment,
              childPiEnvironment,
              exactRedactionValues: readonlySecretMembership([token, launchId]),
            },
            "provider runtime secrets",
          );
        }

        export function createCredentialBoundary(input) {
          const boundaryInput = snapshotPlainObject(
            input,
            ["resolverResults", "launchId", "environment"],
            "$boundary",
          );
          return nonSerializableObject(
            {
              resolvers: resolverPlans,
              runtime: createProviderRuntimeSecrets({
                resolverResults: boundaryInput.resolverResults,
                launchId: boundaryInput.launchId,
              }),
              scrubbedEnvironment: scrubEnvironment(boundaryInput.environment),
              sensitiveNames,
            },
            "credential boundary",
          );
        }
      '';
    };
  renderEnabled =
    { hostSelection }:
    let
      resolverPlans = deriveResolverPlans { inherit hostSelection; };
      launcherInvocation =
        plan:
        if plan.kind == "pi-auth" && plan == { kind = "pi-auth"; } then
          null
        else if builtins.elem plan resolverPlans && builtins.hasAttr plan.kind fixedArgv then
          {
            inherit (plan) executable;
            argv = fixedArgv.${plan.kind};
          }
        else
          throw "pi-agent credential policy received a resolver plan outside the closed plan set";
      runtimeModule = renderRuntimeModule hostSelection.mode resolverPlans;
      executionPlans = map (
        plan:
        let
          invocation = launcherInvocation plan;
        in
        {
          inherit (plan) kind;
          executable = if invocation == null then null else invocation.executable;
          argv = if invocation == null then null else invocation.argv;
        }
      ) resolverPlans;
      executionPlanDigest = builtins.hashString "sha256" (builtins.toJSON executionPlans);
      resolverExecutor = import ../../../scripts/pi-agent-credential-resolver.nix {
        inherit executionPlanDigest executionPlans pkgs;
        credentialRuntimeModule = runtimeModule;
      };
    in
    {
      inherit
        launcherInvocation
        resolverExecutor
        resolverPlans
        runtimeModule
        ;
    };
in
{
  inherit
    bashTimeoutBinding
    managedShell
    resolverKinds
    shellAllowlist
    shellExecutable
    shellRemoveNames
    ;
  render = renderEnabled;
}
