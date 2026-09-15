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
