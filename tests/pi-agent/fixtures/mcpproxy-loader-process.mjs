import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const piPath = process.env.PI_AGENT_TEST_PI_PATH;
const extensionPath = process.env.PI_AGENT_TEST_EXTENSIONS_PATH;
const wrapperPath = process.env.PI_AGENT_TEST_MCP_WRAPPER_PATH;
const agentDir = process.env.PI_CODING_AGENT_DIR;
const workspace = process.env.PI_AGENT_TEST_WORKSPACE;
const fixturePort = Number(process.env.PI_AGENT_TEST_MCP_PORT);
if (!piPath || !extensionPath || !wrapperPath || !agentDir || !workspace) {
  throw new Error("loader fixture paths are required");
}
if (!Number.isInteger(fixturePort) || fixturePort < 1) {
  throw new Error("PI_AGENT_TEST_MCP_PORT must be a positive integer");
}

const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : input;
  const url = new URL(source);
  if (url.hostname === "127.0.0.1" && url.port === "8080") url.port = String(fixturePort);
  if (input instanceof Request) return originalFetch(new Request(url, input), init);
  return originalFetch(input instanceof URL ? url : url.href, init);
};

const piNodeModules = path.join(piPath, "lib/node_modules");
const { createJiti } = await import(pathToFileURL(path.join(piNodeModules, "jiti/lib/jiti.mjs")));
const jiti = createJiti(import.meta.url, {
  moduleCache: false,
  alias: {
    "@earendil-works/pi-ai/compat": path.join(piNodeModules, "@earendil-works/pi-ai/compat.js"),
    "@earendil-works/pi-ai": path.join(piNodeModules, "@earendil-works/pi-ai/index.js"),
    "@earendil-works/pi-coding-agent": path.join(
      piNodeModules,
      "@earendil-works/pi-coding-agent/index.js",
    ),
    "@earendil-works/pi-tui": path.join(piNodeModules, "@earendil-works/pi-tui/index.js"),
    typebox: path.join(extensionPath, "lib/node_modules/typebox/build/index.mjs"),
  },
});
const { DefaultResourceLoader, SettingsManager } = await jiti.import(
  path.join(piNodeModules, "@earendil-works/pi-coding-agent/index.js"),
);
const settingsManager = SettingsManager.create(workspace, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({
  cwd: workspace,
  agentDir,
  settingsManager,
  additionalExtensionPaths: [wrapperPath],
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});
await loader.reload();

const errors = loader.getExtensions().errors;
const tools = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()]);
process.send?.({ type: "loaded", errors, tools });

await new Promise((resolve) => {
  process.on("message", (message) => {
    if (message?.type === "shutdown") resolve();
  });
});
for (const extension of loader.getExtensions().extensions) {
  for (const handler of extension.handlers.get("session_shutdown") ?? []) {
    await handler({ type: "session_shutdown", reason: "quit" });
  }
}
fs.statSync(path.join(agentDir, "mcp-cache.json"));
process.send?.({ type: "stopped" }, () => process.disconnect?.());
