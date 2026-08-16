import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , piRoot, extensionPath, mode = "missing"] = process.argv;
const bootstrapSymbol = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const runtimeRoot = path.join(
	piRoot,
	"lib/node_modules/@earendil-works/pi-coding-agent/dist",
);
let accessorTouched = false;
let installedCapability;

if (mode === "malformed") {
	const capability = { schemaVersion: 1, mode: "shopify-gateway" };
	Object.defineProperty(capability, "redactExact", {
		configurable: false,
		enumerable: true,
		get() {
			accessorTouched = true;
			throw new Error("task36 malformed capability accessor");
		},
	});
	Object.defineProperty(capability, "toJSON", {
		configurable: false,
		enumerable: false,
		value: Object.freeze(() => { throw new Error("task36 malformed toJSON"); }),
		writable: false,
	});
	Object.freeze(capability);
	Object.defineProperty(globalThis, bootstrapSymbol, {
		configurable: false,
		enumerable: false,
		value: capability,
		writable: false,
	});
} else if (mode === "bootstrap") {
	await import(pathToFileURL(path.join(runtimeRoot, "runtime-bootstrap.js")));
	installedCapability = Object.getOwnPropertyDescriptor(globalThis, bootstrapSymbol)?.value;
} else if (mode !== "missing") {
	throw new Error("unknown loader probe mode");
}

const { DefaultResourceLoader, SettingsManager } = await import(
	pathToFileURL(path.join(runtimeRoot, "index.js"))
);
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-cavemem-loader-"));
const cwd = path.join(root, "workspace");
const agentDir = path.join(root, "agent");
fs.mkdirSync(cwd, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;

const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
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
const first = resourceLoader.getExtensions();
let second;
if (mode === "bootstrap") {
	process.env.SHOPIFY_PI_TOKEN = "task36-loader-reload-token-must-not-replace-bootstrap";
	process.env.PI_AGENT_LAUNCH_ID = "22345678-1234-4abc-8def-1234567890ab";
	await resourceLoader.reload();
	second = resourceLoader.getExtensions();
}
const retainedCapability = Object.getOwnPropertyDescriptor(globalThis, bootstrapSymbol)?.value;
fs.rmSync(root, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify({
	accessorTouched,
	firstErrors: first.errors,
	firstLoaded: first.extensions.length,
	secondErrors: second?.errors,
	secondLoaded: second?.extensions.length,
	sameCapability:
		mode === "bootstrap" &&
		installedCapability !== undefined &&
		installedCapability === retainedCapability,
})}\n`);
