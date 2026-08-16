import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , piRoot, extensionPath, command] = process.argv;
const runtimeRoot = path.join(
	piRoot,
	"lib/node_modules/@earendil-works/pi-coding-agent/dist",
);
await import(pathToFileURL(path.join(runtimeRoot, "runtime-bootstrap.js")));

const notifications = [];
let error;
try {
	const bridgeUrl = pathToFileURL(extensionPath);
	bridgeUrl.search = "task37-managed-environment";
	const { createCavememBridge } = await import(bridgeUrl.href);
	const handlers = new Map();
	createCavememBridge({ command, killGraceMs: 100, noProgressMs: 5_000 })({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	await handlers.get("session_start")(
		{ type: "session_start", reason: "startup" },
		{
			cwd: process.cwd(),
			sessionManager: {
				getHeader() { return null; },
				getSessionFile() { return undefined; },
				getSessionId() { return "task37-environment-child"; },
			},
			ui: {
				notify(message, type) {
					notifications.push({ message, type });
				},
			},
		},
	);
} catch (caught) {
	error = caught instanceof Error ? caught.message : "unknown environment failure";
}

process.stdout.write(`${JSON.stringify({ error, notifications })}\n`);
