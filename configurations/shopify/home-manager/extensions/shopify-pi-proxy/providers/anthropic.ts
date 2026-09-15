import { getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

const FLEX_DISCOUNT = 0.75;

const roundRate = (value: number) => Math.round(value * 1e6) / 1e6;

function discountedCost(cost: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: {
    inputTokensAbove: number;
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[];
}) {
  return {
    input: roundRate(cost.input * FLEX_DISCOUNT),
    output: roundRate(cost.output * FLEX_DISCOUNT),
    cacheRead: roundRate(cost.cacheRead * FLEX_DISCOUNT),
    cacheWrite: roundRate(cost.cacheWrite * FLEX_DISCOUNT),
    ...(cost.tiers
      ? {
          tiers: cost.tiers.map((tier) => ({
            inputTokensAbove: tier.inputTokensAbove,
            input: roundRate(tier.input * FLEX_DISCOUNT),
            output: roundRate(tier.output * FLEX_DISCOUNT),
            cacheRead: roundRate(tier.cacheRead * FLEX_DISCOUNT),
            cacheWrite: roundRate(tier.cacheWrite * FLEX_DISCOUNT),
          })),
        }
      : {}),
  };
}

const flexModels = getModels("anthropic")
  .filter((model) => model.id.startsWith("claude-opus-") || model.id === "claude-sonnet-4-6")
  .map((model) => ({
    id: model.id,
    name: `${model.name ?? model.id} [flex]`,
    reasoning: model.reasoning,
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: discountedCost(model.cost),
  }));

const cappedModels = [
  {
    id: "claude-opus-4-8",
    name: "Claude Opus 4.8 [250k]",
    reasoning: true,
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    contextWindow: 250_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-opus-5",
    name: "Claude Opus 5 [250k]",
    reasoning: true,
    compat: { forceAdaptiveThinking: true },
    thinkingLevelMap: { xhigh: "xhigh" },
    input: ["text", "image"],
    contextWindow: 250_000,
    maxTokens: 128_000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  },
  {
    id: "claude-sonnet-4-6",
    name: "Claude Sonnet 4.6 [250k]",
    reasoning: true,
    compat: { forceAdaptiveThinking: true },
    input: ["text", "image"],
    contextWindow: 250_000,
    maxTokens: 64_000,
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  },
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1 [250k]",
    reasoning: true,
    compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    contextWindow: 250_000,
    maxTokens: 128_000,
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
];

const nativeFableModels = [
  {
    id: "claude-fable-5-1",
    name: "Claude Fable 5.1 [1m]",
    reasoning: true,
    compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
    input: ["text", "image"],
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  },
];

export function registerAnthropicProviders(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  pi.registerProvider("anthropic", {
    baseUrl: `${baseUrl}/apis/anthropic`,
    apiKey: PROXY_API_KEY,
    headers,
  });
  pi.registerProvider("anthropic-250k-prefer-using-this-one", {
    baseUrl: `${baseUrl}/apis/anthropic`,
    apiKey: PROXY_API_KEY,
    api: "anthropic-messages",
    headers,
    models: cappedModels,
  });
  pi.registerProvider("anthropic-1m", {
    baseUrl: `${baseUrl}/apis/anthropic`,
    apiKey: PROXY_API_KEY,
    api: "anthropic-messages",
    headers,
    models: nativeFableModels,
  });
  pi.registerProvider("anthropic-flex", {
    baseUrl: `${baseUrl}/apis/anthropic`,
    apiKey: PROXY_API_KEY,
    api: "anthropic-messages",
    headers: { ...headers, "Shopify-Flex-Processing": "true" },
    models: flexModels,
  });
}
