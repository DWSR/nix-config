import type { ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

const metaThinkingLevelMap = (supportsMax: boolean): ThinkingLevelMap => ({
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  ...(supportsMax ? { max: "max" } : {}),
});

const models = [
  { id: "muse-spark-1.3", name: "Muse Spark 1.3", supportsMax: true },
  { id: "muse-spark-1.2", name: "Muse Spark 1.2", supportsMax: false },
  { id: "muse-spark-1.1", name: "Muse Spark 1.1", supportsMax: false },
].map(({ id, name, supportsMax }) => ({
  id,
  name,
  reasoning: true,
  thinkingLevelMap: metaThinkingLevelMap(supportsMax),
  input: ["text", "image"] as ("text" | "image")[],
  contextWindow: 1_048_576,
  maxTokens: 131_072,
  cost: { input: 1.25, output: 4.25, cacheRead: 0.15, cacheWrite: 0 },
  compat: { supportsReasoningEffort: true, includeEncryptedReasoning: true },
}));

export function registerMetaProvider(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  pi.registerProvider("meta", {
    baseUrl: `${baseUrl}/vendors/meta/v1`,
    apiKey: PROXY_API_KEY,
    api: "openai-responses",
    headers,
    models,
  });
}
