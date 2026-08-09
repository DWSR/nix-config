export const generationV1 = "task-2.3-v1";
export const generationV2 = "task-2.3-v2";
export const providerOrder = ["anthropic", "openai", "google", "groq", "xai"];

const routeSuffixes = {
  anthropic: "/apis/anthropic/v1",
  openai: "/vendors/openai/v1",
  google:
    "/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google",
  groq: "/vendors/groq/openai/v1",
  xai: "/vendors/xai/v1",
};

export function shopifyFactoryInput({
  generation = generationV1,
  roles = providerOrder,
  origin = "https://gateway.example.test",
  defaultModel = { provider: "openai", modelId: "gpt-5.6-sol" },
} = {}) {
  const joinedUrls = Object.fromEntries(roles.map((role) => [role, `${origin}${routeSuffixes[role]}`]));

  return {
    schemaVersion: 1,
    generation,
    providerSelection: {
      mode: "shopify-gateway",
      enabledRoles: [...roles],
      defaultModel: structuredClone(defaultModel),
    },
    joinedUrls,
  };
}

export function personalFactoryInput(generation = generationV2) {
  return {
    schemaVersion: 1,
    generation,
    providerSelection: {
      mode: "personal",
      defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
    },
    joinedUrls: {},
  };
}

export function currentDocuments() {
  return {
    settings: {
      theme: "user-theme",
      packages: ["user-package"],
      defaultProjectTrust: "always",
      auth: { source: "user-auth" },
      unknownSetting: { nested: ["preserve", { bytes: "semantically" }] },
    },
    models: {
      providers: {
        local: {
          baseUrl: "https://local.example.test/v1",
          api: "openai-completions",
          headers: { "X-User-Header": "user-owned" },
        },
      },
      auth: { source: "user-model-auth" },
      trust: { project: true },
      packages: ["user-model-package"],
      sessions: { retained: true },
      unknownModelsValue: [1, { two: 2 }],
    },
  };
}
