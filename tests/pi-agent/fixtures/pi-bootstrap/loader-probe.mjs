import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , piRoot, extensionPath] = process.argv;
const BOOTSTRAP_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const FIXTURE_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.fixture.v1");
const runtimeRoot = path.join(
	piRoot,
	"lib/node_modules/@earendil-works/pi-coding-agent/dist",
);

await import(pathToFileURL(path.join(runtimeRoot, "runtime-bootstrap.js")));
const installedCapability = Object.getOwnPropertyDescriptor(globalThis, BOOTSTRAP_SYMBOL)?.value;
const { DefaultResourceLoader, SettingsManager } = await import(
	pathToFileURL(path.join(runtimeRoot, "index.js"))
);

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-bootstrap-loader-"));
const cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
const resourceLoader = new DefaultResourceLoader({
	cwd,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [extensionPath],
	noExtensions: true,
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});

await resourceLoader.reload();
const firstErrors = resourceLoader.getExtensions().errors;
process.env.SHOPIFY_PI_TOKEN = "task27-child-b-token";
process.env.PI_AGENT_LAUNCH_ID = "223e4567-e89b-42d3-b456-426614174000";
await resourceLoader.reload();
const secondErrors = resourceLoader.getExtensions().errors;
const state = Object.getOwnPropertyDescriptor(globalThis, FIXTURE_SYMBOL)?.value;
const records = state?.records ?? [];

process.stdout.write(
	`${JSON.stringify({
		firstErrors,
		secondErrors,
		loads: records.length,
		sameCapability: records.length === 2 && records[0].capability === records[1].capability,
		matchesInstalled:
			records.length === 2 &&
			records[0].capability === installedCapability &&
			records[1].capability === installedCapability,
		records: records.map(({ serializable }) => serializable),
	})}\n`,
);
