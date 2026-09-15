import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

export function registerGroqProvider(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  pi.registerProvider("groq", {
    baseUrl: `${baseUrl}/vendors/groq/openai/v1`,
    apiKey: PROXY_API_KEY,
    headers,
  });
}
