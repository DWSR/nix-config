/**
 * Shopify LLM Proxy Extension
 *
 * Registers Shopify's LLM proxy endpoints for all supported providers.
 * Overrides existing providers (anthropic, openai, google, groq, xai, meta) to
 * route through the proxy, adds an anthropic-250k provider for cost-optimized
 * context capping, fireworks/fireworks-300k providers exposing GLM 5.2 and
 * Kimi K3 at their native ~1M and a 300k-capped context plus Fireworks-hosted
 * Kimi K2.7 Code, Qwen3.7 Plus and Qwen3.8 Max models, an openai-flex provider that opts the gpt-5
 * family into the proxy's discounted flex service tier via the
 * Shopify-Flex-Processing header, an anthropic-flex provider that opts the
 * Claude family into the proxy's discounted Anthropic flex tier via that same
 * Shopify-Flex-Processing header, and an openai-1m provider
 * that re-exposes the gpt-5.6 family (sol/terra/luna) at the full 1M OpenAI
 * context window — pi's built-in catalog pins them to the 272k standard-tier
 * ceiling — for tasks that need more than 272k tokens without compaction, and
 * an anthropic-1m provider that exposes Claude Fable 5.1 at its native 1M
 * window (the uncapped counterpart to its anthropic-250k card), since the base
 * anthropic provider only carries a Claude version once pi's upstream catalog
 * ships it.
 *
 * Enables session affinity (sticky load balancing) via the proxy's Level 1
 * mechanism: explicit `X-Shopify-Session-Affinity-Header` + a `pi-session-id`
 * header carrying the pi session UUID. The UUID can change whenever a new
 * session is established, and the SDK signals every such transition with a
 * single `session_start` event whose `reason` is one of
 * `startup | reload | new | resume | fork` — so `session_start` is the one
 * hook that fires (with the new UUID already available) on initial load and
 * on `/new`, `/resume`, and fork. The `session_before_*` events fire *before*
 * the transition and still carry the old UUID, so they are the wrong place to
 * re-register. Tree navigation and compaction stay within the same session
 * file/UUID, so they do not require re-registration.
 *
 * When launched via devx, a `Shopify-Request-Context` header is included
 * with the `DEV_INVOCATION_ID` for BQ cost attribution joins.
 *
 * Also optimizes tool-result images (re-encoding oversized ones as JPEG q80)
 * before they enter history — see the optimize-images section below — and
 * redacts the proxy credential this extension authenticates with out of tool
 * results before they enter history, see `redact-credentials.ts`.
 */

import { execFileSync } from "node:child_process";
import type { ImageContent, TextContent, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { getModel, getModels } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, InputSource } from "@earendil-works/pi-coding-agent";
import { formatDimensionNote, resizeImage } from "@earendil-works/pi-coding-agent";
import { redactToolResultCredentials } from "./redact-credentials.js";

// zone.nix pins these in builds; dev may fall back to PATH.
const WORKTRAIL_BIN = process.env.WORKTRAIL_BIN || "worktrail";
const AI_PROXY_HEADERS_BIN = process.env.AI_PROXY_HEADERS_BIN || "ai-proxy-headers";

// WORKTRAIL_* vars applied to this process's env after a roll so the
// ai-proxy-headers CLI (and child tools) inherit the trace.
const TOOL_TRACE_VARS = [
  "WORKTRAIL_SESSION_ID",
  "WORKTRAIL_TRACE_ID",
  "WORKTRAIL_SPAN_ID",
  "WORKTRAIL_PARENT_TRACE_ID",
  "WORKTRAIL_PARENT_SPAN_ID",
  "WORKTRAIL_NAME",
  "WORKTRAIL_PARENT_NAME",
  // Materialized span ancestry (worktrail #882331).
  "WORKTRAIL_SPAN_PATH",
  "WORKTRAIL_SPAN_DEPTH",
  "WORKTRAIL_ROOT_SPAN_ID",
] as const;

// The one var a failed roll keeps. Everything else in TOOL_TRACE_VARS names a
// unit of work, a position inside one, or the tool boundary that a successful
// roll would have claimed, and none of those exist when the roll fails.
const WORKTRAIL_SESSION_VAR = "WORKTRAIL_SESSION_ID";

// Roll a fresh intent as tool `pi` (--name names the intent's root span) and
// apply WORKTRAIL_* to this process's env so the CLI and child tools share it.
// Called once at launch, then once per unit of work from the `input` hook.
//
// Fail-safe: a missing, timed-out, unparseable, or trace-less roll keeps the
// session anchor and drops everything else. Neither alternative is bounded to a
// single unit of work, because a failure that is not transient repeats until a
// roll succeeds, so the choice is between three shapes rather than three blast
// radii:
//
//   keep everything  - every unit of work until the next success reports the
//                      inherited trace, so this turn's model spend is booked to
//                      a unit of work it did not belong to. Plausible and wrong.
//   clear everything - the session anchor goes too, so the next successful roll
//                      has nothing to preserve, mints a fresh session id, and
//                      detaches the rest of the run from everything before it.
//   this             - the request still reports its session, nothing claims a
//                      unit of work that was never opened, and the next roll
//                      preserves the session.
//
// The tool names go with the rest, which is less obvious than it looks. It is
// `--name pi` that shifts identity (inherited WORKTRAIL_NAME becomes
// WORKTRAIL_PARENT_NAME, `pi` becomes WORKTRAIL_NAME), and a failed roll
// degrades to an `ensure` that *preserves* the inherited name. So the name
// sitting in the env after a failure is the caller's, not pi's: launched under
// a named worktrail caller, keeping it would publish that caller's boundary
// beside this process's requests. `tool=pi` reaches the header from
// resolveRequestContext's `--set`, independent of worktrail, so dropping the
// name loses no true statement about which tool ran.
//
// The resulting shape is not hypothetical: AI proxy rows already arrive as a
// worktrail object carrying session_id alone, from callers that never roll, and
// they group cleanly by session. All three failure shapes are silent to the
// caller, so prefer the one that reports less over the one that reports
// something untrue.
function rollToolTrace(): void {
  const dropUnestablished = () => {
    for (const name of TOOL_TRACE_VARS) {
      if (name !== WORKTRAIL_SESSION_VAR) delete process.env[name];
    }
  };
  let stdout: string;
  try {
    stdout = execFileSync(WORKTRAIL_BIN, ["roll-intent", "--name", "pi", "--shell", "posix"], {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
  } catch {
    dropUnestablished();
    return;
  }
  const rolled = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^export (WORKTRAIL_[A-Z_]+)='([0-9a-z._-]+)'$/.exec(line);
    if (match && (TOOL_TRACE_VARS as readonly string[]).includes(match[1])) {
      rolled.set(match[1], match[2]);
    }
  }
  if (!rolled.has("WORKTRAIL_TRACE_ID")) {
    dropUnestablished();
    return;
  }
  for (const name of TOOL_TRACE_VARS) {
    const value = rolled.get(name);
    if (value) process.env[name] = value;
    else delete process.env[name];
  }
}

// Build Shopify-Request-Context by delegating to the ai-proxy-headers CLI — the
// single source of truth for the shape (worktrail object + dev_invocation_id)
// and the fill merge. `tool` is this wrapper's label. Fail-open: keep whatever
// was inherited if the CLI is unavailable.
function resolveRequestContext(existing: string | undefined): string | undefined {
  try {
    const args = ["from-env", "Shopify-Request-Context", "--set", "tool=pi"];
    if (existing) args.push("--in", existing);
    const out = execFileSync(AI_PROXY_HEADERS_BIN, args, {
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    }).trim();
    return out || undefined;
  } catch {
    return existing;
  }
}

// optimize-images — re-encode oversized tool-result images as JPEG q80 before
// they enter history.
//
// pi normalizes tool-result images, but its budget is per-image: max 2000x2000
// and 4.5MB of base64, and its candidate loop returns PNG whenever PNG fits
// under that cap. A dense 2000x969 screenshot is a legal ~3.6MB PNG, so a
// session with nine of them ships a 27MB request body every turn — enough to
// make the AI proxy worker exceed its Cloudflare memory limit mid-stream
// ("Anthropic stream ended before message_stop"). JPEG q80 gets the same
// screenshot to a few hundred KB.
//
// We reuse pi's exported `resizeImage` rather than driving Photon directly: it
// owns the worker-thread/in-process fallback and the WASM loading dance.
// Passing a small `maxBytes` makes its PNG candidate fail and its first JPEG
// candidate (q80) win.
//
// Runs on the `tool_result` hook, so the shrunk image is what lands in the
// transcript: the saving persists across reload and keeps the .jsonl small.
// pi's own normalizer runs after us in `afterToolCall` and passes our JPEG
// through untouched.

type ToolResultBlock = TextContent | ImageContent;

// Images whose base64 already fits under this are left alone — they are not
// what blows up a request. Anything larger comes back as JPEG q80 (pi steps
// down to q85/70/55/40 and then downscales only if q80 still does not fit).
const IMAGE_MAX_BASE64_BYTES = Number(process.env.PI_IMAGE_MAX_BYTES ?? 512 * 1024);
const IMAGE_JPEG_QUALITY = Number(process.env.PI_IMAGE_JPEG_QUALITY ?? 80);

async function optimizeToolResultImages(
  content: ToolResultBlock[],
): Promise<{ content: ToolResultBlock[] } | undefined> {
  // Despite the type, tool results with missing/null/non-array content exist in
  // the wild (pi's own normalizers handle them); fail open rather than throw.
  if (!Array.isArray(content)) return undefined;
  if (!content.some((block) => block.type === "image")) return undefined;

  const out: ToolResultBlock[] = [];
  let changed = false;

  for (const block of content) {
    if (block.type !== "image" || block.data.length <= IMAGE_MAX_BASE64_BYTES) {
      out.push(block);
      continue;
    }

    let resized: Awaited<ReturnType<typeof resizeImage>> = null;
    try {
      resized = await resizeImage(Buffer.from(block.data, "base64"), block.mimeType, {
        maxBytes: IMAGE_MAX_BASE64_BYTES,
        jpegQuality: IMAGE_JPEG_QUALITY,
      });
    } catch {
      resized = null;
    }

    // Keep the original on failure. The tool produced this image on purpose and
    // an unavailable image backend is not a reason to silently drop its output.
    if (!resized) {
      out.push(block);
      continue;
    }

    out.push({ type: "image", data: resized.data, mimeType: resized.mimeType });

    // `wasResized` is also true for a pure re-encode, which would emit a useless
    // "multiply coordinates by 1.00" note. Only annotate a real dimension change.
    if (resized.width !== resized.originalWidth || resized.height !== resized.originalHeight) {
      const note = formatDimensionNote(resized);
      if (note) out.push({ type: "text", text: note });
    }

    changed = true;
  }

  return changed ? { content: out } : undefined;
}

const USAGE_TAG_PREFIX = ["pi", "coding-agent"] as const;

const MANAGED_OPENAI_BASE_URL = "https://proxy.shopify.ai/v1";
const MANAGED_GOOGLE_BASE_URL = "https://proxy.shopify.ai/apis/google/v1";

// openai-flex = the gpt-5 family re-registered with the Shopify-Flex-Processing
// header, routing them through the proxy's discounted `flex` tier (~50% cheaper,
// higher latency; a no-op for ineligible tokens). Separate provider so flex is
// an explicit per-model pick. Models are read from pi's catalog via getModel; we
// copy only portable fields and drop the catalog provider/baseUrl/api (its
// baseUrl is api.openai.com and would bypass the proxy). Keep `cost` at the
// standard catalog price (pi applies the 0.5 flex multiplier from the response
// `service_tier`) and keep `id` bare: pi-internal calls (auto-compaction) skip
// before_provider_request, so a display id would 400. getModel is imported from
// `/compat` because pi's extension loader only exposes the root/compat/oauth
// pi-ai entrypoints (not `/providers/all`).
const OPENAI_FLEX_MODEL_IDS = [
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

const OPENAI_FLEX_MODELS = OPENAI_FLEX_MODEL_IDS.flatMap((id) => {
  const base = getModel("openai", id);
  if (!base) return [];
  return [
    {
      id: base.id,
      name: `${base.name ?? base.id} [flex]`,
      reasoning: base.reasoning,
      thinkingLevelMap: base.thinkingLevelMap,
      input: base.input,
      contextWindow: base.contextWindow,
      maxTokens: base.maxTokens,
      cost: base.cost,
    },
  ];
});

// anthropic-flex re-registers eligible Claude catalog cards behind the
// proxy's beta flex header. Keep ids bare for pi-internal calls, preserve
// catalog compat/thinking metadata, and pre-discount costs because Anthropic
// usage responses don't include a flex service_tier signal.
// TODO: swap to the GA header and revisit eligibility when flex GA is announced.
const ANTHROPIC_FLEX_DISCOUNT = 0.75;

// Multiply every rate (and any pricing tier) by the flex discount. Rounded to
// avoid binary-float noise in the footer (e.g. 0.3 * 0.75).
const roundRate = (n: number) => Math.round(n * 1e6) / 1e6;
const applyFlexDiscount = (cost: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  tiers?: { inputTokensAbove: number; input: number; output: number; cacheRead: number; cacheWrite: number }[];
}) => ({
  input: roundRate(cost.input * ANTHROPIC_FLEX_DISCOUNT),
  output: roundRate(cost.output * ANTHROPIC_FLEX_DISCOUNT),
  cacheRead: roundRate(cost.cacheRead * ANTHROPIC_FLEX_DISCOUNT),
  cacheWrite: roundRate(cost.cacheWrite * ANTHROPIC_FLEX_DISCOUNT),
  ...(cost.tiers
    ? {
        tiers: cost.tiers.map((t) => ({
          inputTokensAbove: t.inputTokensAbove,
          input: roundRate(t.input * ANTHROPIC_FLEX_DISCOUNT),
          output: roundRate(t.output * ANTHROPIC_FLEX_DISCOUNT),
          cacheRead: roundRate(t.cacheRead * ANTHROPIC_FLEX_DISCOUNT),
          cacheWrite: roundRate(t.cacheWrite * ANTHROPIC_FLEX_DISCOUNT),
        })),
      }
    : {}),
});

// Every Opus model, plus the current flagship Sonnet. Ordered as pi's catalog
// lists them (ascending).
const isAnthropicFlexModel = (id: string) =>
  id.startsWith("claude-opus-") || id === "claude-sonnet-4-6";

const ANTHROPIC_FLEX_MODELS = getModels("anthropic")
  .filter((base) => isAnthropicFlexModel(base.id))
  .map((base) => ({
    id: base.id,
    name: `${base.name ?? base.id} [flex]`,
    reasoning: base.reasoning,
    compat: base.compat,
    thinkingLevelMap: base.thinkingLevelMap,
    input: base.input,
    contextWindow: base.contextWindow,
    maxTokens: base.maxTokens,
    cost: applyFlexDiscount(base.cost),
  }));

// gpt-5.6 sol/terra/luna and gpt-6-astra re-exposed at the full 1M OpenAI
// context window under a dedicated `openai-1m` provider (managed /v1 route,
// openai-responses, no flex header). pi's built-in catalog now ships them under
// the base `openai` provider but pins each `contextWindow` to 272k (the
// standard-tier input ceiling), so long sessions auto-compact there. This provider re-exposes the
// same models at OpenAI's 1M ceiling for tasks that need more than 272k tokens
// without compaction. A separate provider is required because registerProvider
// replaces a provider's model list wholesale, so these 1M twins can't be added
// to `openai` without wiping its catalog — mirroring anthropic-250k /
// fireworks-300k, which likewise carry context-variant twins.
//
// Each model is read from pi's catalog via getModel and inherited wholesale —
// including its tiered `cost` (the >272k tier is ~2x), so the Pi footer price
// stays accurate once a session crosses 272k input tokens — lifting only the
// contextWindow to 1M and adding a `[1m]` name suffix. We copy only portable
// fields and drop the catalog provider/baseUrl/api (its baseUrl is
// api.openai.com and would bypass the proxy). `id` stays bare so pi-internal
// calls (auto-compaction) that skip before_provider_request still resolve. Raw
// `gpt-5.6` is intentionally not exposed.
const OPENAI_1M_CONTEXT_WINDOW = 1_000_000;

// sol recommended, then terra (mid), luna (lightweight), then astra.
//
// gpt-6-astra was a hand-declared card below this list until this pin shipped
// it. 0.85.1's catalog carries the real one, so it graduates into the list and
// the card is gone, which is what keeps two identically named rows out of the
// picker. Its published ceiling is ~1.05M rather than 1M, so the shared
// constant errs about 50k low: that compacts marginally early and can never
// 400, where erring high would. It stays last so the picker order does not move.
const OPENAI_1M_MODEL_IDS = [
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
] as const;

const OPENAI_1M_CATALOG_MODELS = OPENAI_1M_MODEL_IDS.flatMap((id) => {
  const base = getModel("openai", id);
  if (!base) return [];
  return [
    {
      id: base.id,
      name: `${base.name ?? base.id} [1m]`,
      reasoning: base.reasoning,
      thinkingLevelMap: base.thinkingLevelMap,
      input: base.input,
      contextWindow: OPENAI_1M_CONTEXT_WINDOW,
      maxTokens: base.maxTokens,
      cost: base.cost,
    },
  ];
});

const OPENAI_1M_MODELS = OPENAI_1M_CATALOG_MODELS;

// Pi 0.85.1 is the latest release but predates Meta's first-party models.dev
// provider. Keep this temporary list to the three Muse ids AI Proxy configures
// statically; once Pi's release catalog carries `meta`, replace these cards with
// catalog-derived metadata instead of maintaining a second copy.
const META_COMPAT = {
  supportsReasoningEffort: true,
  includeEncryptedReasoning: true,
} as const;

const metaThinkingLevelMap = (supportsMax: boolean): ThinkingLevelMap => ({
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  ...(supportsMax ? { max: "max" as const } : {}),
});

const META_MODELS = [
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
  compat: META_COMPAT,
}));

// Fireworks models, exposed through the proxy's Anthropic-compatible managed
// route under the `fireworks` provider (and `fireworks-300k` for capped
// variants). The proxy's Fireworks Anthropic endpoint needs session-affinity
// headers and rejects eager tool-input streaming, cache_control on tools, and
// long cache retention, so every Fireworks model shares these compat flags.
//
// allowEmptySignature: this route returns `thinking` blocks with an empty
// `signature` — verified on every model registered below (GLM 5.2, Qwen3.7 Plus,
// Qwen3.8 Max, Kimi K2.7 Code, Kimi K3, DeepSeek V4 Flash, DeepSeek V4 Pro), so
// it is a property of the route, not of one model.
// Without the flag, pi's anthropic-messages transport rewrites every earlier-turn
// thinking block into a plain TEXT block when it replays history. From turn two on
// the model then sees its own reasoning as ordinary assistant output and imitates
// it, writing reasoning into the visible answer instead of a thinking block (Kimi
// K3, a heavy thinker, is where this shows up worst). pi's built-in `kimi-coding`
// cards set the same flag, and the route accepts a replayed thinking block with
// `signature: ""`, so preserving the block is both safe and closer to the truth.
const FIREWORKS_COMPAT = {
  sendSessionAffinityHeaders: true,
  supportsEagerToolInputStreaming: false,
  supportsCacheControlOnTools: false,
  supportsLongCacheRetention: false,
  allowEmptySignature: true,
};

type FireworksModelSpec = {
  // Model id sent verbatim on every request, INCLUDING pi-internal calls like
  // auto-compaction that skip before_provider_request. It must be valid on the
  // proxy as-is: either the `fireworks:`-prefixed vendor path
  // (`fireworks:accounts/fireworks/models/<id>`), which needs no ai-proxy
  // change, or a deployed virtual-model alias (cleaner footer label, but needs
  // an ai-proxy alias in config/models/other first).
  id: string;
  name: string;
  input: ("text" | "image")[];
  contextWindow: number;
  maxTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  reasoning?: boolean; // defaults to true
  // Per-model thinking-level overrides, passed through to both twins. `null`
  // marks a level unsupported, which drops it from pi's selector and makes
  // `clampThinkingLevel` escalate a saved/flagged value to the next supported
  // one instead of sending it. Use `{ off: null }` for a thinking-only model
  // whose deployment rejects `thinking: { type: "disabled" }`.
  thinkingLevelMap?: ThinkingLevelMap;
  // If set, also register a context-capped twin under `fireworks-300k`
  // (compacts earlier -> lower cache-read cost). The capped label is derived.
  capContextWindow?: number;
};

// >>> To add a Fireworks model, append one entry here. Nothing else to touch.
//     Use a `fireworks:`-prefixed id to skip needing an ai-proxy alias PR. <<<
const FIREWORKS_MODELS: FireworksModelSpec[] = [
  {
    id: "glm-5.2",
    name: "GLM 5.2",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    // Fast-router variant of GLM 5.2, served via Fireworks's serverless tier.
    // Uses the `fireworks:`-prefixed vendor path directly, so no ai-proxy alias
    // PR is needed. The router id uses a `p` infix instead of `.` (glm-5p2-fast).
    id: "fireworks:accounts/fireworks/routers/glm-5p2-fast",
    name: "GLM 5.2 Fast (Fireworks)",
    input: ["text"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    // Fast-tier pricing per https://app.fireworks.ai/models/fireworks/glm-5p2
    // (uncached input $2.10/m, cached input $0.21/m, output $6.60/m).
    cost: { input: 2.1, output: 6.6, cacheRead: 0.21, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code (Fireworks)",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: { input: 0.95, output: 4.0, cacheRead: 0.19, cacheWrite: 0 },
  },
  {
    id: "qwen3.7-plus",
    name: "Qwen3.7 Plus (Fireworks)",
    input: ["text", "image"],
    contextWindow: 262_144,
    maxTokens: 65_536,
    cost: { input: 0.4, output: 1.6, cacheRead: 0.08, cacheWrite: 0 },
  },
  {
    id: "qwen3.8-max",
    name: "Qwen3.8 Max (Fireworks)",
    input: ["text"],
    contextWindow: 262_144,
    maxTokens: 131_072,
    cost: { input: 2.0, output: 6.0, cacheRead: 0.25, cacheWrite: 0 },
  },
  {
    // Kimi K3, served via Fireworks's serverless tier. Uses the
    // `fireworks:`-prefixed vendor path directly, so no ai-proxy alias PR is
    // needed. Natively multimodal — the managed Anthropic route accepts image
    // blocks for both K3 entries.
    id: "fireworks:accounts/fireworks/models/kimi-k3",
    name: "Kimi K3 (Fireworks)",
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    // Standard-tier pricing per https://docs.fireworks.ai/serverless/pricing
    // (uncached input $3.00/m, cached input $0.30/m, output $15.00/m).
    cost: { input: 3.0, output: 15.0, cacheRead: 0.3, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    // Fast variant of Kimi K3. Like glm-5p2-fast the fast tier is a *router*
    // path, not a model path: `accounts/fireworks/models/kimi-k3-fast` is not
    // deployed (the proxy answers NOT_FOUND), `routers/kimi-k3-fast` is.
    id: "fireworks:accounts/fireworks/routers/kimi-k3-fast",
    name: "Kimi K3 Fast (Fireworks)",
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    // Fast-tier pricing per https://docs.fireworks.ai/serverless/pricing
    // (uncached input $4.50/m, cached input $0.45/m, output $22.50/m) — 1.5x the
    // standard tier, the same markup Fireworks applies to glm-5p2-fast.
    cost: { input: 4.5, output: 22.5, cacheRead: 0.45, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    // DeepSeek V4 Flash (0731 retrain), served via Fireworks's serverless tier.
    // Uses the `fireworks:`-prefixed vendor path directly, so no ai-proxy alias
    // PR is needed. Pinned to the dated `-0731` id rather than the rolling
    // `deepseek-v4-flash` alias (both are deployed) so a silent upstream
    // retrain can't change the model under us.
    //
    // Text-only: the managed Anthropic route answers 400 "This model does not
    // support image inputs" for an image block, so pi will not offer it for
    // screenshot/vision work.
    id: "fireworks:accounts/fireworks/models/deepseek-v4-flash-0731",
    name: "DeepSeek V4 Flash (Fireworks)",
    input: ["text"],
    // Fireworks publishes a 1040k window for this model; rounded down to a flat
    // 1M so the cap stays inside what the route actually accepts.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // Standard-tier pricing per https://docs.fireworks.ai/serverless/pricing
    // (uncached input $0.14/m, cached input $0.028/m, output $0.28/m) — by far
    // the cheapest entry in this tier.
    cost: { input: 0.14, output: 0.28, cacheRead: 0.028, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    // DeepSeek V4 Flash Vision, served via Fireworks's serverless tier. Same
    // `fireworks:`-prefixed vendor path as the rest of the DeepSeek family, so
    // no ai-proxy alias PR is needed. `-exp` is upstream's own suffix: the
    // deployment is experimental and can be withdrawn without notice, so keep
    // it out of any default-model wiring.
    //
    // Unlike every other DeepSeek deployment on Fireworks, this one takes image
    // input. Fireworks' own catalogue reports `supports_image_input: true`, and
    // a solid-red PNG round-trips on the managed Anthropic route: the model
    // answers "Red" at 132 input tokens, so the image is tokenized rather than
    // dropped. The text-only siblings return 400 `This model does not support
    // image inputs` for the same request, so the probe discriminates.
    id: "fireworks:accounts/fireworks/models/deepseek-v4-flash-vision-exp",
    name: "DeepSeek V4 Flash Vision (Fireworks)",
    input: ["text", "image"],
    // Fireworks reports `context_length: 1048576`; rounded down to a flat 1M to
    // match the rest of the DeepSeek family and keep the configured cap inside
    // what the route accepts. Output stays at the proxy-supported limit.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // Fireworks' own published rate for this deployment: 0.22 uncached /
    // 0.007 cached / 0.66 output on the standard tier (the priority tier is
    // 1.25x at 0.275 / 0.00875 / 0.825, which pi does not use). Matches
    // DeepSeek's off-peak list price for the family; DeepSeek's peak rate is
    // exactly 2x, which a single flat cost cannot express and Fireworks does
    // not charge.
    //
    // `shopify-dw.infrastructure.ai_pricing_current` — where ai-proxy reads
    // per-model cost — has no row for this model yet, so proxy-side cost is
    // reported as unknown until the pricing sync picks it up. The 0731 entry
    // above still carries that table's 0.14 / 0.028 / 0.28, which contradicts
    // both Fireworks' and DeepSeek's published rates; correcting a shipped
    // price is its own change, so it is deliberately left alone here.
    // Drives pi's footer price only.
    cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    // DeepSeek V4 Pro, served via Fireworks's serverless tier. Pin the dated
    // `-0813` deployment so an upstream alias change cannot move the model.
    //
    // Text-only: the managed Anthropic route answers 400 "This model does not
    // support image inputs" for an image block, so pi will not offer it for
    // screenshot/vision work.
    id: "fireworks:accounts/fireworks/models/deepseek-v4-pro-0813",
    name: "DeepSeek V4 Pro (Fireworks)",
    input: ["text"],
    // Fireworks publishes a 1040k window; rounded down to a flat 1M so the
    // configured cap stays inside what the route accepts. Keep output at the
    // proxy's supported 131072-token limit.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // Pricing for the dated deployment: uncached input $1.32/m, cached input
    // $0.044/m, and output $3.96/m.
    cost: { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
  {
    id: "fireworks:accounts/fireworks/models/glm-5p3-flash",
    name: "GLM 5.3 Flash (Fireworks)",
    input: ["text", "image"],
    contextWindow: 1_048_576,
    maxTokens: 131_072,
    // Standard-tier pricing per https://docs.fireworks.ai/serverless/pricing
    // (uncached input $0.15/m, cached input $0.03/m, output $0.50/m). Fireworks
    // published no GLM 5.3 Flash row when this entry landed, so it carried GLM
    // 5.2 Fast's sheet ($2.10/$6.60/$0.21) as a placeholder, overstating input
    // and output by ~14x. The cached rate is the unrounded 0.029 the proxy
    // catalogue and `shopify-dw.infrastructure.ai_pricing_current` carry, which
    // is what //system/aquifer and //areas/tools/omp already use for this id.
    cost: { input: 0.15, output: 0.5, cacheRead: 0.029, cacheWrite: 0 },
    // Thinking-only deployment: `thinking: { type: "disabled" }` is refused with
    // 400 `thinking='none' is not supported by this deployment because reasoning
    // cannot be disabled`.
    thinkingLevelMap: { off: null },
    capContextWindow: 300_000,
  },
  {
    // GLM 5.3, the flagship tier above GLM 5.3 Flash. Vendor path sent verbatim,
    // so no ai-proxy alias is needed.
    //
    // Text-only, unlike GLM 5.3 Flash: the managed Anthropic route answers 400
    // `This model does not support image inputs` for an image block.
    id: "fireworks:accounts/fireworks/models/glm-5p3",
    name: "GLM 5.3 (Fireworks)",
    input: ["text"],
    // Fireworks publishes a 1040k window; rounded down to a flat 1M like the
    // DeepSeek V4 entries so the configured cap stays inside what the route
    // accepts.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // Serverless pricing per https://fireworks.ai/models/fireworks/glm-5p3
    // (uncached input $1.40/m, cached input $0.26/m, output $4.40/m).
    cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    // Thinking-only, like GLM 5.3 Flash: the route answers 400 `GLM-5.3 is a
    // thinking-only model; disabling thinking (thinking='none') is not
    // supported.` GLM 5.2 accepts disabled thinking, so this is per-model, not
    // a property of the Fireworks route.
    thinkingLevelMap: { off: null },
    capContextWindow: 300_000,
  },
  {
    // GLM 5.3's fast tier. It is a *router* path, not a model path, and the
    // router id uses a `p` infix instead of `.`. Sent verbatim, so no ai-proxy
    // alias is needed; the proxy catalogue lists the same route as
    // `glm-5.3-fast`.
    id: "fireworks:accounts/fireworks/routers/glm-5p3-fast",
    name: "GLM 5.3 Fast (Fireworks)",
    // The route answers 400 `This model does not support image inputs` for an
    // image block.
    input: ["text"],
    // Flat 1M like GLM 5.3, inside the 1040k the route accepts.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // 1.5x GLM 5.3's sheet, Fireworks' fast-tier markup. The proxy catalogue
    // carries no pricing of its own for this route.
    cost: { input: 2.1, output: 6.6, cacheRead: 0.39, cacheWrite: 0 },
    // The route answers 400 `GLM-5.3 is a thinking-only model; disabling
    // thinking (thinking='none') is not supported.`
    thinkingLevelMap: { off: null },
    capContextWindow: 300_000,
  },
  {
    // DeepSeek V4.1 Flash, served via Fireworks's serverless tier. Vendor path
    // sent verbatim, so no ai-proxy alias is needed; the proxy catalogue
    // indexes this exact id. No dated deployment is published for it, so the
    // rolling id is the only option — unlike the V4 Flash and V4 Pro entries,
    // which pin `-0731`/`-0813`.
    //
    // Multimodal, like DeepSeek V4 Flash Vision and unlike the text-only 0731
    // and Pro deployments: Fireworks reports `Support image input: Supported`,
    // and a solid-red PNG round-trips on the managed Anthropic route (224 input
    // tokens, answer "red"), so the image is tokenized rather than dropped.
    //
    // The route accepts `thinking: { type: "disabled" }`, so there is no
    // thinkingLevelMap below and pi keeps its full level selector, unlike the
    // thinking-only GLM 5.3 family.
    id: "fireworks:accounts/fireworks/models/deepseek-v4p1-flash",
    name: "DeepSeek V4.1 Flash (Fireworks)",
    input: ["text", "image"],
    // Fireworks publishes a 1040k window; rounded down to a flat 1M like the
    // rest of the DeepSeek family so the configured cap stays inside what the
    // route accepts. Output stays at the 131072 limit the family uses, below
    // the 384k the proxy catalogue advertises.
    contextWindow: 1_000_000,
    maxTokens: 131_072,
    // Serverless-tier pricing per
    // https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash (uncached
    // input $0.22/m, cached input $0.007/m, output $0.66/m) — the same sheet as
    // DeepSeek V4 Flash Vision, and the same three numbers the proxy
    // catalogue's models.dev block carries for this id. Drives pi's footer
    // price only.
    cost: { input: 0.22, output: 0.66, cacheRead: 0.007, cacheWrite: 0 },
    capContextWindow: 300_000,
  },
];

// Context-window label ("1m", "300k") used to distinguish a capped model's twins.
const fireworksWindowLabel = (w: number): string =>
  w >= 1_000_000 ? `${Math.round(w / 1_000_000)}m` : `${Math.round(w / 1_000)}k`;

// Build a pi model object for a Fireworks spec at a given context window. Models
// with a capped twin get a "[1m]"/"[300k]" suffix so the two stay distinct;
// others use their name verbatim. api/baseUrl are inherited from the provider.
const fireworksModel = (spec: FireworksModelSpec, contextWindow: number) => ({
  id: spec.id,
  name:
    spec.capContextWindow !== undefined
      ? `${spec.name} [${fireworksWindowLabel(contextWindow)}]`
      : spec.name,
  reasoning: spec.reasoning ?? true,
  thinkingLevelMap: spec.thinkingLevelMap,
  input: spec.input,
  contextWindow,
  maxTokens: spec.maxTokens,
  cost: spec.cost,
  compat: FIREWORKS_COMPAT,
});

// Model ID rewrites: pi's built-in catalog may use IDs that differ from
// what the Shopify proxy expects. Map catalog IDs → proxy IDs here so
// users can select the built-in model and have it Just Work.
const MODEL_ID_REWRITES: Record<string, string> = {
  "gpt-5.3-codex-spark": "gpt-5.3-codex-spark-preview",
};

export default function (pi: ExtensionAPI) {
  let currentInputSource: InputSource = "interactive";

  function buildShopifyUsageTag(sessionId?: string) {
    return JSON.stringify([...USAGE_TAG_PREFIX, currentInputSource, sessionId ?? ""]);
  }
  /** Register all providers. When sessionId is provided, includes affinity
   *  headers. Always includes all models `models` so pi rebuilds model
   *  objects with fresh headers on re-registration. */
  function registerAllProviders(sessionId?: string) {
    const headers: Record<string, string> = {
      "Shopify-Usage-Tag": buildShopifyUsageTag(sessionId),
    };

    if (sessionId) {
      headers["X-Shopify-Session-Affinity-Header"] = "pi-session-id";
      headers["pi-session-id"] = sessionId;
    }

    // Shopify-Request-Context carries the current worktrail intent +
    // dev_invocation_id + tool. The ai-proxy-headers CLI owns the shape and the
    // fill merge (a key already set is preserved); we only roll the trace and
    // pass our tool label. Omitted on fail-open when there is nothing to attach.
    const requestContext = resolveRequestContext(headers["Shopify-Request-Context"]);
    if (requestContext) {
      headers["Shopify-Request-Context"] = requestContext;
    }

    // Use the managed route (/apis/anthropic) instead of the vendor route
    // (/vendors/anthropic) to get load balancing and failover across multiple
    // Anthropic orgs, avoiding single-org rate limits (e.g. 429s on Opus 4.6).
    pi.registerProvider("anthropic", {
      baseUrl: "https://proxy.shopify.ai/apis/anthropic",
      apiKey: "$PI_PROXY_API_KEY",
      headers,
    });

    // Cost-optimized variants: same models with a 250k context cap.
    // Anthropic charges for cache reads on every turn proportional to
    // the cached prefix length. On long sessions the cache-read bill
    // dominates. By advertising a smaller contextWindow, Pi compacts
    // the conversation earlier, keeping the cached prefix (and therefore
    // the per-turn cache-read cost) bounded at ~250k tokens instead of
    // growing to the model's native 200k/1M limit.
    pi.registerProvider("anthropic-250k-prefer-using-this-one", {
      baseUrl: "https://proxy.shopify.ai/apis/anthropic",
      apiKey: "$PI_PROXY_API_KEY",
      api: "anthropic-messages",
      headers,
      models: [
        {
          id: "claude-opus-4-8",
          name: "Claude Opus 4.8 [250k]",
          reasoning: true,
          compat: { forceAdaptiveThinking: true },
          thinkingLevelMap: { xhigh: "xhigh" },
          input: ["text", "image"],
          contextWindow: 250000,
          maxTokens: 128000,
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
        {
          id: "claude-opus-5",
          name: "Claude Opus 5 [250k]",
          reasoning: true,
          compat: { forceAdaptiveThinking: true },
          thinkingLevelMap: { xhigh: "xhigh" },
          input: ["text", "image"],
          contextWindow: 250000,
          maxTokens: 128000,
          cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        },
        {
          id: "claude-sonnet-4-6",
          name: "Claude Sonnet 4.6 [250k]",
          reasoning: true,
          compat: { forceAdaptiveThinking: true },
          input: ["text", "image"],
          contextWindow: 250000,
          maxTokens: 64000,
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        },
        // Fable 5.1 released after pi-coding-agent 0.84.3, so it is absent from
        // pi's built-in catalog and this card is currently the only way to
        // select it from pi. Thinking, compat and modalities mirror the
        // catalog's claude-fable-5 card (adaptive thinking, strict tools, the
        // native `max` tier); pricing is 5.1's own, whose cache-read rate is a
        // quarter of Fable 5's. The base `anthropic` and `anthropic-flex`
        // providers derive from the catalog, so they expose 5.1 at its native 1M
        // window automatically once a pin bump ships it — no native-window
        // stopgap provider here, which is the call already made for Opus 5 when
        // `anthropic-1m` was reverted in fecc305fa908.
        {
          id: "claude-fable-5-1",
          name: "Claude Fable 5.1 [250k]",
          reasoning: true,
          compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
          thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
          input: ["text", "image"],
          contextWindow: 250000,
          maxTokens: 128000,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
        },
      ],
    });

    // anthropic-1m: the native-window (1M) twin for Claude versions the upstream
    // pi catalog doesn't carry yet. The base `anthropic` provider serves catalog
    // Claude at its native window, but Fable 5.1 isn't in that catalog yet and
    // registerProvider replaces a provider's model list wholesale — so we can't
    // hand-add a single card to `anthropic` without wiping the rest. A dedicated
    // provider is the same pattern as openai-1m / fireworks-300k: a context
    // variant that can't live on the base provider. Pairs with the 250k card
    // above so Fable 5.1 is selectable at both the capped and native windows.
    // Once the catalog ships claude-fable-5-1, base `anthropic` covers the 1M
    // case and this provider folds away again — it carried Opus 5 for three days
    // on the same terms (da947256aea7, reverted in fecc305fa908).
    pi.registerProvider("anthropic-1m", {
      baseUrl: "https://proxy.shopify.ai/apis/anthropic",
      apiKey: "$PI_PROXY_API_KEY",
      api: "anthropic-messages",
      headers,
      models: [
        {
          id: "claude-fable-5-1",
          name: "Claude Fable 5.1 [1m]",
          reasoning: true,
          compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
          thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
          input: ["text", "image"],
          contextWindow: 1000000,
          maxTokens: 128000,
          cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
        },
      ],
    });

    // anthropic-flex: managed Anthropic Messages route + the shared flex header
    // (see ANTHROPIC_FLEX_MODELS). Anthropic flex applies only to
    // /apis/anthropic/v1/messages, which is exactly this baseUrl + the
    // anthropic-messages api.
    pi.registerProvider("anthropic-flex", {
      baseUrl: "https://proxy.shopify.ai/apis/anthropic",
      apiKey: "$PI_PROXY_API_KEY",
      api: "anthropic-messages",
      headers: {
        ...headers,
        "Shopify-Flex-Processing": "true",
      },
      models: ANTHROPIC_FLEX_MODELS,
    });

    // Use the managed route for OpenAI — the catch-all route handles
    // /v1/chat/completions, /v1/responses, /v1/embeddings, etc. with
    // StrategyRoutingMiddleware (load balancing, circuit breakers, Azure fallback).
    pi.registerProvider("openai", {
      baseUrl: MANAGED_OPENAI_BASE_URL,
      apiKey: "$PI_PROXY_API_KEY",
      headers,
    });

    // openai-flex: managed /v1 route + the flex header (see OPENAI_FLEX_MODELS).
    pi.registerProvider("openai-flex", {
      baseUrl: MANAGED_OPENAI_BASE_URL,
      apiKey: "$PI_PROXY_API_KEY",
      api: "openai-responses",
      headers: {
        ...headers,
        "Shopify-Flex-Processing": "true",
      },
      models: OPENAI_FLEX_MODELS,
    });

    // openai-1m: 1M-context gpt-5.6 sol/terra/luna plus GPT-6 Astra (see
    // OPENAI_1M_MODELS). Same managed /v1 route + responses api as `openai`, no
    // flex header. Astra is only selectable here: the base `openai` provider is
    // catalog-only and no catalog carries it yet.
    pi.registerProvider("openai-1m", {
      baseUrl: MANAGED_OPENAI_BASE_URL,
      apiKey: "$PI_PROXY_API_KEY",
      api: "openai-responses",
      headers,
      models: OPENAI_1M_MODELS,
    });

    // Use the managed Google-native route so pi keeps the Gemini request shape
    // (`/models/{model}:generateContent`) while the proxy owns provider/project
    // selection, fallback, telemetry, and dev-tier routing.
    pi.registerProvider("google", {
      baseUrl: MANAGED_GOOGLE_BASE_URL,
      apiKey: "$PI_PROXY_API_KEY",
      headers: {
        ...headers,
        Authorization: "$PI_PROXY_AUTH_HEADER",
      },
    });

    pi.registerProvider("groq", {
      baseUrl: "https://proxy.shopify.ai/vendors/groq/openai/v1",
      apiKey: "$PI_PROXY_API_KEY",
      headers,
    });

    pi.registerProvider("xai", {
      baseUrl: "https://proxy.shopify.ai/vendors/xai/v1",
      apiKey: "$PI_PROXY_API_KEY",
      headers,
    });

    pi.registerProvider("meta", {
      baseUrl: "https://proxy.shopify.ai/vendors/meta/v1",
      apiKey: "$PI_PROXY_API_KEY",
      api: "openai-responses",
      headers,
      models: META_MODELS,
    });

    const fireworksProviderConfig = {
      baseUrl: "https://proxy.shopify.ai/apis/anthropic",
      apiKey: "$PI_PROXY_API_KEY",
      api: "anthropic-messages" as const,
      headers,
    };
    // Models are declared in FIREWORKS_MODELS (top of file); adding one is a
    // single entry there. `fireworks` exposes each at its native window;
    // `fireworks-300k` adds the cost-capped twin for any model with
    // `capContextWindow` set, mirroring anthropic-250k.
    pi.registerProvider("fireworks", {
      ...fireworksProviderConfig,
      models: FIREWORKS_MODELS.map((m) => fireworksModel(m, m.contextWindow)),
    });
    pi.registerProvider("fireworks-300k", {
      ...fireworksProviderConfig,
      models: FIREWORKS_MODELS.filter((m) => m.capContextWindow !== undefined).map((m) =>
        fireworksModel(m, m.capContextWindow as number),
      ),
    });
  }

  // Seed the hierarchy at launch so anything before the first prompt — and any
  // child git/tool spawned there — already carries a trace named `pi`. Each
  // idle `input` rolls the next one.
  rollToolTrace();
  registerAllProviders();

  // Rewrite model IDs in outgoing API requests so pi's built-in catalog
  // names map to the IDs the Shopify proxy expects.
  pi.on("before_provider_request", async (event) => {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.model === "string" && payload.model in MODEL_ID_REWRITES) {
      return { ...payload, model: MODEL_ID_REWRITES[payload.model] };
    }
    return undefined;
  });

  // One worktrail intent per unit of work, rolled before the providers are
  // re-registered so the fresh trace is what lands in Shopify-Request-Context.
  //
  // `ctx.isIdle()` is the same flag the agent session itself tests to decide
  // whether a prompt starts a run or is queued into the one in flight (it
  // returns `!isAgentRunActive`). So an idle input opens a new unit of work,
  // while a "steer" or "followUp" is queued into the run already active —
  // prompt() returns right after queueing and that run's own loop drains it —
  // and belongs to that run's trace. Rolling there would split one run across
  // two intents and chain it to itself through WORKTRAIL_PARENT_TRACE_ID.
  //
  // `event.streamingBehavior` looks like the same test and is not: prompt()
  // hands it to this hook as `isStreaming ? behavior : undefined`, so a caller
  // that prompts a *busy* agent without a delivery mode also arrives here as
  // `undefined` and is rejected immediately after this hook returns. Rolling
  // for it would move the live run's attribution onto a prompt that never ran.
  pi.on("input", async (event, ctx) => {
    currentInputSource = event.source;
    if (ctx.isIdle()) rollToolTrace();
    registerAllProviders(ctx.sessionManager.getSessionId());
  });

  // Re-register with affinity headers once the session ID is known.
  // registerProvider() internally refreshes the active model reference.
  // `session_start` fires for startup/reload/new/resume/fork (see its `reason`
  // field), so it covers session switches and forks too — the new session ID
  // is available here, unlike the `session_before_*` events which fire before
  // the transition with the old ID.
  async function onSessionChange(_event: unknown, ctx: ExtensionContext) {
    registerAllProviders(ctx.sessionManager.getSessionId());
  }

  pi.on("session_start", onSessionChange);

  // One handler for both tool-result passes, in this order: redaction runs
  // first so the credential is gone from the content the image pass (and
  // everything after it) sees, and a single registration keeps the two from
  // racing to replace `content`. Each returns `undefined` when it changed
  // nothing, so an unremarkable tool result still costs one substring scan.
  pi.on("tool_result", async (event) => {
    const redacted = redactToolResultCredentials(event.content);
    const optimized = await optimizeToolResultImages(redacted?.content ?? event.content);
    return optimized ?? redacted;
  });
}