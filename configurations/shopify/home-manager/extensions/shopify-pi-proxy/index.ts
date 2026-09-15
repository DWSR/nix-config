import type { ExtensionAPI, InputSource } from "@earendil-works/pi-coding-agent";
import { optimizeToolResultImages } from "./image-resizing.js";
import { redactToolResultCredentials } from "./redact-credentials.js";
import { registerAnthropicProviders } from "./providers/anthropic.js";
import { registerFireworksProviders } from "./providers/fireworks.js";
import { registerGoogleProvider } from "./providers/google.js";
import { registerGroqProvider } from "./providers/groq.js";
import { registerMetaProvider } from "./providers/meta.js";
import { registerOpenAIProviders } from "./providers/openai.js";
import { proxyBaseUrl } from "./providers/shared.js";
import { registerXaiProvider } from "./providers/xai.js";

const USAGE_TAG_PREFIX = ["pi", "coding-agent"] as const;
const MODEL_ID_REWRITES: Record<string, string> = {
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
};

export default function shopifyPiProxy(pi: ExtensionAPI): void {
  let currentInputSource: InputSource = "interactive";

  const usageTag = (sessionId?: string): string =>
    JSON.stringify([...USAGE_TAG_PREFIX, currentInputSource, sessionId ?? ""]);

  const registerProviders = (sessionId?: string): void => {
    const headers: Record<string, string> = {
      "Shopify-Usage-Tag": usageTag(sessionId),
    };
    if (sessionId) {
      headers["X-Shopify-Session-Affinity-Header"] = "pi-session-id";
      headers["pi-session-id"] = sessionId;
    }

    const baseUrl = proxyBaseUrl();
    registerAnthropicProviders(pi, headers, baseUrl);
    registerOpenAIProviders(pi, headers, baseUrl);
    registerGoogleProvider(pi, headers, baseUrl);
    registerGroqProvider(pi, headers, baseUrl);
    registerXaiProvider(pi, headers, baseUrl);
    registerMetaProvider(pi, headers, baseUrl);
    registerFireworksProviders(pi, headers, baseUrl);
  };

  registerProviders();

  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.model === "string" && payload.model in MODEL_ID_REWRITES) {
      return { ...payload, model: MODEL_ID_REWRITES[payload.model] };
    }
    return undefined;
  });

  pi.on("input", async (event, ctx) => {
    currentInputSource = event.source;
    registerProviders(ctx.sessionManager.getSessionId());
  });

  pi.on("session_start", async (_event, ctx) => {
    registerProviders(ctx.sessionManager.getSessionId());
  });

  pi.on("tool_result", async (event) => {
    const redacted = redactToolResultCredentials(event.content);
    const optimized = await optimizeToolResultImages(redacted?.content ?? event.content);
    return optimized ?? redacted;
  });
}
