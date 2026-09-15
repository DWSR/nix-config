import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export type ProviderHeaders = Record<string, string>;

export const PROXY_API_KEY = "$PI_PROXY_API_KEY";
export const PROXY_AUTH_HEADER = "$PI_PROXY_AUTH_HEADER";

export function proxyBaseUrl(): string {
  return (process.env.PI_PROXY_BASE_URL?.trim() || "https://proxy.shopify.ai").replace(/\/+$/, "");
}

export type ProviderRegistrar = (
  pi: ExtensionAPI,
  headers: ProviderHeaders,
  baseUrl: string,
) => void;
