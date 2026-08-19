import fs from "node:fs";
import path from "node:path";

export const PROVIDER_ENVIRONMENT_NAMES = Object.freeze([
  "AI_GATEWAY_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANT_LING_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_OPENAI_API_KEY",
  "CEREBRAS_API_KEY",
  "CLOUDFLARE_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "HF_TOKEN",
  "KIMI_API_KEY",
  "LLAMA_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "NVIDIA_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_API_KEY",
  "OPENROUTER_API_KEY",
  "PI_AGENT_LAUNCH_ID",
  "QWEN_TOKEN_PLAN_API_KEY",
  "QWEN_TOKEN_PLAN_CN_API_KEY",
  "RADIUS_API_KEY",
  "SHOPIFY_PI_TOKEN",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
  "ZAI_API_KEY",
  "ZAI_CODING_CN_API_KEY",
]);

export function createProviderFreeEnvironment(root, source = process.env) {
  const paths = {
    HOME: path.join(root, "home"),
    TMPDIR: path.join(root, "tmp"),
    XDG_CACHE_HOME: path.join(root, "xdg-cache"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_RUNTIME_DIR: path.join(root, "xdg-runtime"),
    XDG_STATE_HOME: path.join(root, "xdg-state"),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });

  const environment = { ...source, ...paths };
  for (const name of PROVIDER_ENVIRONMENT_NAMES) delete environment[name];
  return Object.freeze(environment);
}
