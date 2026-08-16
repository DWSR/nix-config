import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , piRoot, extensionPath, mode = "missing"] = process.argv;
const bootstrapSymbol = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const environmentSymbol = Symbol.for("dwsr.pi-agent.cavemem-environment.v1");
const stateSymbol = Symbol.for("dwsr.pi-agent.cavemem-runtime-state.v1");
const runtimeRoot = path.join(
	piRoot,
	"lib/node_modules/@earendil-works/pi-coding-agent/dist",
);
let accessorTouched = false;
let installedCapability;

function installValidRuntimeBootstrap() {
	const redactExact = Object.freeze((value) => value);
	const capability = { schemaVersion: 1, mode: "personal", redactExact };
	Object.defineProperty(capability, "toJSON", {
		configurable: false,
		enumerable: false,
		value: Object.freeze(() => { throw new Error("task37 runtime bootstrap is not serializable"); }),
		writable: false,
	});
	Object.freeze(capability);
	Object.defineProperty(globalThis, bootstrapSymbol, {
		configurable: false,
		enumerable: false,
		value: capability,
		writable: false,
	});
}

function installEnvironmentCapability(dataDir) {
	const environment = {};
	Object.defineProperty(environment, "CAVEMEM_DATA_DIR", {
		configurable: false,
		enumerable: true,
		value: dataDir,
		writable: false,
	});
	Object.freeze(environment);
	const capability = { schemaVersion: 1, environment };
	Object.defineProperty(capability, "toJSON", {
		configurable: false,
		enumerable: false,
		value: Object.freeze(() => { throw new Error("task37 environment is not serializable"); }),
		writable: false,
	});
	Object.freeze(capability);
	Object.defineProperty(globalThis, environmentSymbol, {
		configurable: false,
		enumerable: false,
		value: capability,
		writable: false,
	});
}

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
} else if (
	mode === "missing-environment" ||
	mode === "malformed-environment" ||
	mode === "relative-environment" ||
	mode === "nul-environment" ||
	mode === "preclaimed-state" ||
	mode === "malformed-state"
) {
	installValidRuntimeBootstrap();
	if (mode === "malformed-environment") {
		const capability = { schemaVersion: 1 };
		Object.defineProperty(capability, "environment", {
			configurable: false,
			enumerable: true,
			get() {
				accessorTouched = true;
				throw new Error("task37 malformed environment accessor");
			},
		});
		Object.defineProperty(capability, "toJSON", {
			configurable: false,
			enumerable: false,
			value: Object.freeze(() => { throw new Error("task37 malformed environment toJSON"); }),
			writable: false,
		});
		Object.freeze(capability);
		Object.defineProperty(globalThis, environmentSymbol, {
			configurable: false,
			enumerable: false,
			value: capability,
			writable: false,
		});
	}
	if (mode === "relative-environment") installEnvironmentCapability("relative/cavemem");
	if (mode === "nul-environment") installEnvironmentCapability("/task37/cavemem\0other");
	if (mode === "preclaimed-state" || mode === "malformed-state") {
		installEnvironmentCapability("/task37/cavemem");
		if (mode === "preclaimed-state") {
			Object.defineProperty(globalThis, stateSymbol, {
				configurable: false,
				enumerable: false,
				get() {
					accessorTouched = true;
					throw new Error("task37 preclaimed state accessor");
				},
			});
		} else {
			const state = { schemaVersion: 1 };
			Object.defineProperty(state, "stage", {
				configurable: false,
				enumerable: true,
				get() {
					accessorTouched = true;
					throw new Error("task37 malformed state accessor");
				},
			});
			Object.freeze(state);
			Object.defineProperty(globalThis, stateSymbol, {
				configurable: false,
				enumerable: false,
				value: state,
				writable: false,
			});
		}
	}
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
