{
  lib,
  pkgs,
  shellPath,
}:
let
  supportedSystem = "aarch64-darwin";
  extensionNames = [
    "cavemem"
    "mcp"
    "subagents"
    "plan"
    "timestamps"
    "bashTimeout"
    "questions"
    "codeIntelligence"
    "backgroundTasks"
  ];

  tokenEnvironmentReference = {
    kind = "environment-reference";
    name = "SHOPIFY_PI_TOKEN";
    template = "\${SHOPIFY_PI_TOKEN}";
  };
  launchEnvironmentReference = {
    kind = "environment-reference";
    name = "PI_AGENT_LAUNCH_ID";
    template = "\${PI_AGENT_LAUNCH_ID}";
  };
  affinityHeaders = [
    {
      name = "X-Shopify-Session-Affinity-Header";
      value = {
        kind = "fixed-public-literal";
        value = "pi-agent-session-id";
      };
    }
    {
      name = "pi-agent-session-id";
      value = launchEnvironmentReference;
    }
    {
      name = "Shopify-Usage-Tag";
      value = {
        kind = "fixed-public-literal";
        value = "pi-agent";
      };
    }
  ];
  requestPolicies = {
    personal-pi-auth-v1 = {
      kind = "personal-pi-auth-v1";
      credential.kind = "pi-auth";
      headers = [ ];
    };
    shopify-standard-v1 = {
      kind = "shopify-standard-v1";
      credential = {
        field = "apiKey";
        value = tokenEnvironmentReference;
      };
      headers = affinityHeaders;
    };
    shopify-google-bearer-v1 = {
      kind = "shopify-google-bearer-v1";
      credential = {
        field = "apiKey";
        value = tokenEnvironmentReference;
      };
      headers = affinityHeaders ++ [
        {
          name = "Authorization";
          value = {
            kind = "bearer-environment-reference";
            name = "SHOPIFY_PI_TOKEN";
            template = "Bearer \${SHOPIFY_PI_TOKEN}";
          };
        }
      ];
    };
  };

  shopifyCatalog = [
    {
      role = "anthropic";
      providerId = "anthropic";
      route = {
        owner = "pi-agent-module";
        role = "anthropic-api-v1";
        suffix = "/apis/anthropic/v1";
      };
      api = "anthropic-messages";
      modelSource = "pi-0.83.0-built-in:anthropic";
      modelOverrides = "none";
      requestPolicy = requestPolicies.shopify-standard-v1.kind;
    }
    {
      role = "openai";
      providerId = "openai";
      route = {
        owner = "pi-agent-module";
        role = "openai-vendor-v1";
        suffix = "/vendors/openai/v1";
      };
      api = "openai-responses";
      modelSource = "pi-0.83.0-built-in:openai";
      modelOverrides = "none";
      requestPolicy = requestPolicies.shopify-standard-v1.kind;
    }
    {
      role = "google";
      providerId = "google";
      route = {
        owner = "pi-agent-module";
        role = "google-vertex-global";
        suffix = "/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google";
      };
      api = "google-generative-ai";
      modelSource = "pi-0.83.0-built-in:google";
      modelOverrides = "none";
      requestPolicy = requestPolicies.shopify-google-bearer-v1.kind;
    }
    {
      role = "groq";
      providerId = "groq";
      route = {
        owner = "pi-agent-module";
        role = "groq-openai-v1";
        suffix = "/vendors/groq/openai/v1";
      };
      api = "openai-completions";
      modelSource = "pi-0.83.0-built-in:groq";
      modelOverrides = "none";
      requestPolicy = requestPolicies.shopify-standard-v1.kind;
    }
    {
      role = "xai";
      providerId = "xai";
      route = {
        owner = "pi-agent-module";
        role = "xai-vendor-v1";
        suffix = "/vendors/xai/v1";
      };
      api = "pi-per-model";
      modelSource = "pi-0.83.0-built-in:xai";
      modelOverrides = "none";
      requestPolicy = requestPolicies.shopify-standard-v1.kind;
    }
  ];
  providerCatalog = {
    schemaVersion = 1;
    personal = {
      role = "personal-openai";
      providerId = "openai";
      api = "openai-responses";
      modelSource = "pi-0.83.0-built-in:openai";
      modelOverrides = "none";
      requestPolicy = requestPolicies.personal-pi-auth-v1.kind;
    };
    shopify = shopifyCatalog;
    defaults = {
      personal = {
        model = "openai/gpt-5.6-sol";
        reasoning = "xhigh";
      };
      shopify = {
        model = "openai/gpt-5.6-sol";
        reasoning = "xhigh";
      };
    };
    unsupported = [
      {
        providerId = "cohere";
        policy = "reject";
        reason = "no-pi-core-api";
      }
      {
        providerId = "perplexity";
        policy = "reject";
        reason = "no-required-coding-tool-path";
      }
    ];
  };

  projectionFactory = pkgs.writeTextFile {
    name = "pi-agent-provider-projection-factory";
    destination = "/bin/pi-agent-provider-projection";
    executable = true;
    text = ''
      #!${pkgs.nodejs}/bin/node
      "use strict";

      const fs = require("node:fs");
      const CATALOG = ${builtins.toJSON providerCatalog};
      const REQUEST_POLICIES = ${builtins.toJSON requestPolicies};
      const ROLE_SET = new Set(CATALOG.shopify.map((entry) => entry.role));
      const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*$/;
      const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*(\/[A-Za-z0-9][A-Za-z0-9._+,:=@~-]*)*$/;

      function invalid(path, message) {
        throw new Error("invalid factory input at " + path + ": " + message);
      }

      function requireObject(value, path) {
        if (value === null || Array.isArray(value) || typeof value !== "object") {
          invalid(path, "expected an object");
        }
      }

      function requireExactKeys(value, expected, path) {
        requireObject(value, path);
        const actual = Object.keys(value).sort();
        const required = [...expected].sort();
        if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
          invalid(path, "fields must match the closed schema");
        }
      }

      function requireSafeString(value, pattern, path) {
        if (typeof value !== "string" || !pattern.test(value)) {
          invalid(path, "invalid closed reference");
        }
      }

      function validateModel(model, path) {
        requireExactKeys(model, ["provider", "modelId"], path);
        if (!ROLE_SET.has(model.provider)) {
          invalid(path + ".provider", "unknown provider role");
        }
        requireSafeString(model.modelId, SAFE_MODEL_ID, path + ".modelId");
      }

      function projectModel(model) {
        return {
          provider: model.provider,
          modelId: model.modelId,
        };
      }

      function projectEnvironmentReference(reference) {
        return {
          kind: reference.kind,
          name: reference.name,
          template: reference.template,
        };
      }

      function projectCredential(credential) {
        if (credential.kind === "pi-auth") {
          return { kind: credential.kind };
        }
        return {
          field: credential.field,
          value: projectEnvironmentReference(credential.value),
        };
      }

      function projectHeaderValue(value) {
        if (value.kind === "fixed-public-literal") {
          return {
            kind: value.kind,
            value: value.value,
          };
        }
        return {
          kind: value.kind,
          name: value.name,
          template: value.template,
        };
      }

      function projectHeader(header) {
        return {
          name: header.name,
          value: projectHeaderValue(header.value),
        };
      }

      function validateJoinedUrl(role, value) {
        if (typeof value !== "string") {
          invalid("joinedUrls." + role, "expected an HTTPS URL");
        }

        let parsed;
        try {
          parsed = new URL(value);
        } catch (_error) {
          invalid("joinedUrls." + role, "expected an HTTPS URL");
        }

        const entry = CATALOG.shopify.find((candidate) => candidate.role === role);
        if (
          parsed.protocol !== "https:" ||
          parsed.origin === "null" ||
          parsed.username !== "" ||
          parsed.password !== "" ||
          parsed.search !== "" ||
          parsed.hash !== "" ||
          value !== parsed.origin + entry.route.suffix
        ) {
          invalid("joinedUrls." + role, "expected the catalog route joined to an HTTPS origin");
        }
      }

      function validateInput(input) {
        requireExactKeys(
          input,
          ["schemaVersion", "generation", "providerSelection", "joinedUrls"],
          "$",
        );
        if (input.schemaVersion !== 1) {
          invalid("schemaVersion", "expected version 1");
        }
        requireSafeString(input.generation, SAFE_IDENTIFIER, "generation");
        requireObject(input.joinedUrls, "joinedUrls");

        const selection = input.providerSelection;
        requireObject(selection, "providerSelection");
        if (selection.mode === "personal") {
          requireExactKeys(selection, ["mode", "defaultModel"], "providerSelection");
          validateModel(selection.defaultModel, "providerSelection.defaultModel");
          if (selection.defaultModel.provider !== "openai") {
            invalid("providerSelection.defaultModel.provider", "personal mode requires openai");
          }
          if (
            selection.defaultModel.provider + "/" + selection.defaultModel.modelId !==
              CATALOG.defaults.personal.model
          ) {
            invalid("providerSelection.defaultModel", "personal mode requires the catalog default");
          }
          requireExactKeys(input.joinedUrls, [], "joinedUrls");
          return;
        }

        if (selection.mode !== "shopify-gateway") {
          invalid("providerSelection.mode", "unknown provider mode");
        }
        requireExactKeys(
          selection,
          ["mode", "enabledRoles", "defaultModel"],
          "providerSelection",
        );
        if (!Array.isArray(selection.enabledRoles) || selection.enabledRoles.length === 0) {
          invalid("providerSelection.enabledRoles", "expected a non-empty role set");
        }

        const selectedRoles = new Set();
        for (const role of selection.enabledRoles) {
          if (!ROLE_SET.has(role) || selectedRoles.has(role)) {
            invalid("providerSelection.enabledRoles", "roles must be unique catalog entries");
          }
          selectedRoles.add(role);
        }
        validateModel(selection.defaultModel, "providerSelection.defaultModel");
        if (!selectedRoles.has(selection.defaultModel.provider)) {
          invalid("providerSelection.defaultModel.provider", "default provider is not enabled");
        }

        requireExactKeys(input.joinedUrls, selectedRoles, "joinedUrls");
        for (const role of selectedRoles) {
          validateJoinedUrl(role, input.joinedUrls[role]);
        }
      }

      function canonicalize(value) {
        if (Array.isArray(value)) {
          return value.map(canonicalize);
        }
        if (value !== null && typeof value === "object") {
          const result = {};
          for (const key of Object.keys(value).sort()) {
            result[key] = canonicalize(value[key]);
          }
          return result;
        }
        return value;
      }

      function createProjection(input) {
        const selection = input.providerSelection;
        const defaults = CATALOG.defaults[selection.mode === "personal" ? "personal" : "shopify"];
        const projection = {
          schemaVersion: 1,
          generation: input.generation,
          mode: selection.mode,
          default: {
            model: projectModel(selection.defaultModel),
            reasoning: defaults.reasoning,
          },
          providers: [],
        };

        if (selection.mode === "personal") {
          return projection;
        }

        const selectedRoles = new Set(selection.enabledRoles);
        projection.providers = CATALOG.shopify
          .filter((entry) => selectedRoles.has(entry.role))
          .map((entry) => {
            const policy = REQUEST_POLICIES[entry.requestPolicy];
            return {
              providerId: entry.providerId,
              catalogRole: entry.role,
              baseUrl: input.joinedUrls[entry.role],
              api:
                entry.api === "pi-per-model"
                  ? { kind: "pi-per-model-api", providerApiField: "omit" }
                  : { kind: "provider-api", value: entry.api },
              modelCatalog: { source: entry.modelSource, overrides: [] },
              credential: projectCredential(policy.credential),
              headers: policy.headers.map(projectHeader),
            };
          });
        return projection;
      }

      function main() {
        if (process.argv.length !== 2) {
          throw new Error("does not accept command arguments");
        }

        let input;
        try {
          input = JSON.parse(fs.readFileSync(0, "utf8"));
        } catch (_error) {
          invalid("$", "malformed JSON");
        }
        validateInput(input);
        process.stdout.write(JSON.stringify(canonicalize(createProjection(input))) + "\n");
      }

      try {
        main();
      } catch (error) {
        process.stderr.write("pi-agent-provider-projection: " + error.message + "\n");
        process.exitCode = 1;
      }
    '';
  };

  validateSystem =
    cfg:
    if cfg.enable && pkgs.stdenv.hostPlatform.system != supportedSystem then
      throw "programs.pi-agent supports only aarch64-darwin; disable programs.pi-agent.enable on ${pkgs.stdenv.hostPlatform.system}"
    else
      cfg;

  projectModelRef = model: {
    inherit (model) provider modelId;
  };
  renderReference = reference: "${reference.package.outPath}/${reference.relativePath}";
  render =
    unvalidatedCfg:
    let
      cfg = validateSystem unvalidatedCfg;
      manifests = map renderReference cfg.manifests;
      selectedRoles = map (entry: entry.role) (
        builtins.filter (entry: builtins.elem entry.role cfg.provider.enabledRoles) shopifyCatalog
      );
      defaultModel = projectModelRef cfg.provider.defaultModel;
      providerSelection =
        if cfg.provider.mode == "personal" then
          {
            mode = "personal";
            inherit defaultModel;
          }
        else
          {
            mode = "shopify-gateway";
            enabledRoles = selectedRoles;
            inherit defaultModel;
          };
      managedConfigValue = {
        schemaVersion = 1;
        inherit (cfg.state) generation;
        agentDir = cfg.state.location;
        settings = {
          inherit defaultModel;
          defaultThinkingLevel =
            providerCatalog.defaults.${
              if cfg.provider.mode == "personal" then "personal" else "shopify"
            }.reasoning;
          installTelemetry = false;
          inherit shellPath;
          selfUpdate = false;
          unmanagedPackages = false;
        };
        timeouts.bashDefaultMs = cfg.timeouts.bashDefaultMs;
        inherit providerCatalog providerSelection;
        extensionManifest =
          if builtins.length manifests == 1 then
            builtins.head manifests
          else
            throw "programs.pi-agent.manifests must contain exactly one package-backed extension manifest when enabled";
        extensionOrder = builtins.filter (name: cfg.extensions.${name} != null) extensionNames;
        instructionResources = map renderReference (cfg.instructions ++ cfg.resources);
        lspExecutables = lib.mapAttrs (_name: renderReference) cfg.languageServers;
        mcpEndpoint = "http://127.0.0.1:${toString cfg.mcp.port}/mcp";
        sandboxDefault = cfg.sandbox.defaultState;
      };
    in
    {
      managedConfig = pkgs.writeText "pi-agent-managed-config.json" (builtins.toJSON managedConfigValue);
      inherit projectionFactory;
    };
in
{
  inherit
    providerCatalog
    render
    supportedSystem
    validateSystem
    ;
}
