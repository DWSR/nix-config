export default async function fatalMcpPreparation(): Promise<void> {
  await Promise.resolve();
  throw new Error("MCP direct tool metadata mismatch: deterministic headless fixture");
}
