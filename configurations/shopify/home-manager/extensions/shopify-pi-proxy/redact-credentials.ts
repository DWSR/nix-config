import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

type ToolResultBlock = TextContent | ImageContent;

export const CREDENTIAL_PLACEHOLDER = "[redacted:ai-proxy-credential]";

const CREDENTIAL_ENV_VARS = ["PI_PROXY_API_KEY", "PI_PROXY_AUTH_HEADER"] as const;
const MIN_REDACTABLE_LENGTH = 24;

export function collectCredentialValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values: string[] = [];
  const add = (candidate: string) => {
    if (candidate.length >= MIN_REDACTABLE_LENGTH && !values.includes(candidate)) values.push(candidate);
  };

  for (const name of CREDENTIAL_ENV_VARS) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    add(raw);
    add(raw.replace(/^Bearer\s+/i, ""));
  }

  return values.sort((left, right) => right.length - left.length);
}

export function redactCredentials(text: string, secrets: string[]): string {
  return secrets.reduce((result, secret) => result.split(secret).join(CREDENTIAL_PLACEHOLDER), text);
}

export function redactToolResultCredentials(
  content: ToolResultBlock[],
  secrets: string[] = collectCredentialValues(),
): { content: ToolResultBlock[] } | undefined {
  try {
    if (!Array.isArray(content) || secrets.length === 0) return undefined;

    let changed = false;
    const output = content.map((block) => {
      if (block.type !== "text") return block;
      const text = redactCredentials(block.text, secrets);
      if (text === block.text) return block;
      changed = true;
      return { ...block, text };
    });
    return changed ? { content: output } : undefined;
  } catch {
    return undefined;
  }
}
