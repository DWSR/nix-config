import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { PROXY_API_KEY, PROXY_AUTH_HEADER, type ProviderHeaders } from "./shared.js";

export function registerGoogleProvider(
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
): void {
  pi.registerProvider("google", {
    baseUrl: `${baseUrl}/apis/google/v1`,
    apiKey: PROXY_API_KEY,
    headers: { ...headers, Authorization: PROXY_AUTH_HEADER },
  });
}
