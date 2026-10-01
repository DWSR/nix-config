import { getModel } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

const FLEX_MODEL_IDS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.6-terra",
] as const;

const flexModels = FLEX_MODEL_IDS.flatMap((id) => {
  const model = getModel("openai", id);
  return model
    ? [
        {
          id: model.id,
          name: `${model.name ?? model.id} [flex]`,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: model.input,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          cost: model.cost,
        },
      ]
    : [];
});

const ONE_MILLION_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
] as const;

const oneMillionModels = ONE_MILLION_MODEL_IDS.flatMap((id) => {
  const model = getModel("openai", id);
  return model
    ? [
        {
          id: model.id,
          name: `${model.name ?? model.id} [1m]`,
          reasoning: model.reasoning,
          thinkingLevelMap: model.thinkingLevelMap,
          input: model.input,
          contextWindow: 1_000_000,
          maxTokens: model.maxTokens,
          cost: model.cost,
        },
      ]
    : [];
});

// The pinned pi-ai catalog predates GPT-6.1 Sol; register it explicitly for Pi.
oneMillionModels.push({
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol [1m]",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" },
  input: ["text", "image"],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: {
    input: 2,
    output: 10,
    cacheRead: 0.1,
    cacheWrite: 2.5,
    tiers: [{ inputTokensAbove: 272_000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 }],
  },
});

export function registerOpenAIProviders(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  const managedBaseUrl = `${baseUrl}/v1`;
  pi.registerProvider("openai", {
    baseUrl: managedBaseUrl,
    apiKey: PROXY_API_KEY,
    headers,
  });
  pi.registerProvider("openai-flex", {
    baseUrl: managedBaseUrl,
    apiKey: PROXY_API_KEY,
    api: "openai-responses",
    headers: { ...headers, "Shopify-Flex-Processing": "true" },
    models: flexModels,
  });
  pi.registerProvider("openai-1m", {
    baseUrl: managedBaseUrl,
    apiKey: PROXY_API_KEY,
    api: "openai-responses",
    headers,
    models: oneMillionModels,
  });
}
