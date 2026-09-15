import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, type ProviderHeaders } from "./shared.js";

export function registerXaiProvider(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  pi.registerProvider("xai", {
    baseUrl: `${baseUrl}/vendors/xai/v1`,
    apiKey: PROXY_API_KEY,
    headers,
  });
}
