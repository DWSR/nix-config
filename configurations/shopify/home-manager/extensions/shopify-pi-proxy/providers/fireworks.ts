import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

const FIREWORKS_COMPAT = {
  sendSessionAffinityHeaders: true,
  supportsEagerToolInputStreaming: false,
  supportsCacheControlOnTools: false,
  supportsLongCacheRetention: false,
  allowEmptySignature: true,
};

type FireworksModelSpec = {
  id: string;
  name: string;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  capContextWindow?: number;
};

const models: FireworksModelSpec[] = [
  { id: "glm-5.2", name: "GLM 5.2", input: ["text"], contextWindow: 1_048_576, maxTokens: 131_072, cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/routers/glm-5p2-fast", name: "GLM 5.2 Fast (Fireworks)", input: ["text"], contextWindow: 1_048_576, maxTokens: 131_072, cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "kimi-k2.7-code", name: "Kimi K2.7 Code (Fireworks)", input: ["text", "image"], contextWindow: 262_144, maxTokens: 65_536, cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 } },
  { id: "qwen3.7-plus", name: "Qwen3.7 Plus (Fireworks)", input: ["text", "image"], contextWindow: 262_144, maxTokens: 65_536, cost: { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0 } },
  { id: "qwen3.8-max", name: "Qwen3.8 Max (Fireworks)", input: ["text"], contextWindow: 262_144, maxTokens: 131_072, cost: { input: 2, output: 6, cacheRead: 0.25, cacheWrite: 0 } },
  { id: "fireworks:accounts/fireworks/models/kimi-k3", name: "Kimi K3 (Fireworks)", input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/routers/kimi-k3-fast", name: "Kimi K3 Fast (Fireworks)", input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, cost: { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731", name: "DeepSeek V4 Flash (Fireworks)", input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/deepseek-v4-flash-vision-exp", name: "DeepSeek V4 Flash Vision (Fireworks)", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813", name: "DeepSeek V4 Pro (Fireworks)", input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/glm-5p3-flash", name: "GLM 5.3 Flash (Fireworks)", input: ["text", "image"], contextWindow: 1_048_576, maxTokens: 131_072, cost: { input: 0.15, output: 0.5, cacheRead: 0.029, cacheWrite: 0 }, thinkingLevelMap: { off: null }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/glm-5p3", name: "GLM 5.3 (Fireworks)", input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 }, thinkingLevelMap: { off: null }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/routers/glm-5p3-fast", name: "GLM 5.3 Fast (Fireworks)", input: ["text"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 2.1, output: 6.6, cacheRead: 0.39, cacheWrite: 0 }, thinkingLevelMap: { off: null }, capContextWindow: 300_000 },
  { id: "fireworks:accounts/fireworks/models/deepseek-v4p1-flash", name: "DeepSeek V4.1 Flash (Fireworks)", input: ["text", "image"], contextWindow: 1_000_000, maxTokens: 131_072, cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 }, capContextWindow: 300_000 },
];

function windowLabel(value: number): string {
  return value >= 1_000_000 ? `${Math.round(value / 1_000_000)}m` : `${Math.round(value / 1_000)}k`;
}

function fireworksModel(spec: FireworksModelSpec, contextWindow: number) {
  return {
    id: spec.id,
    name: spec.capContextWindow ? `${spec.name} [${windowLabel(contextWindow)}]` : spec.name,
    reasoning: spec.reasoning ?? true,
    thinkingLevelMap: spec.thinkingLevelMap,
    input: spec.input,
    contextWindow,
    maxTokens: spec.maxTokens,
    cost: spec.cost,
    compat: FIREWORKS_COMPAT,
  };
}

export function registerFireworksProviders(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  const config = {
    baseUrl: `${baseUrl}/apis/anthropic`,
    apiKey: PROXY_API_KEY,
    api: "anthropic-messages" as const,
    headers,
  };
  pi.registerProvider("fireworks", {
    ...config,
    models: models.map((model) => fireworksModel(model, model.contextWindow)),
  });
  pi.registerProvider("fireworks-300k", {
    ...config,
    models: models
      .filter((model) => model.capContextWindow !== undefined)
      .map((model) => fireworksModel(model, model.capContextWindow as number)),
  });
}
