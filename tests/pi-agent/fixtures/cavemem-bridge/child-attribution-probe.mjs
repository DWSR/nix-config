import path from "node:path";
import { pathToFileURL } from "node:url";

const [, , piRoot, extensionPath, mode] = process.argv;
const runtimeRoot = path.join(
	piRoot,
	"lib/node_modules/@earendil-works/pi-coding-agent/dist",
);
await import(pathToFileURL(path.join(runtimeRoot, "runtime-bootstrap.js")));

const originalEnvironment = process.env;
const malicious = originalEnvironment.TASK37_MALICIOUS_ATTRIBUTION ??
	"task37-malformed-attribution-sensitive-value";
let accessorTouched = false;
const valid = {
	PI_SUBAGENT_CHILD: "1",
	PI_SUBAGENT_PARENT_SESSION: `task37-parent-${originalEnvironment.SHOPIFY_PI_TOKEN}`,
	PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: `task37-parent-${originalEnvironment.SHOPIFY_PI_TOKEN}`,
	PI_SUBAGENT_RUN_ID: "task37-run",
	PI_SUBAGENT_CHILD_AGENT: `task37-agent-${originalEnvironment.PI_AGENT_LAUNCH_ID}`,
	PI_SUBAGENT_CHILD_INDEX: "7",
};

switch (mode) {
	case "valid":
		process.env = { ...valid };
		break;
	case "absent-with-hostile-extras": {
		const environment = {};
		Object.defineProperty(environment, "PI_SUBAGENT_PARENT_SESSION", {
			enumerable: true,
			get() {
				accessorTouched = true;
				throw new Error(malicious);
			},
		});
		process.env = environment;
		break;
	}
	case "partial":
		process.env = { PI_SUBAGENT_CHILD: "1", PI_SUBAGENT_PARENT_SESSION: malicious };
		break;
	case "mismatch":
		process.env = {
			...valid,
			PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: malicious,
		};
		break;
	case "bad-index":
		process.env = { ...valid, PI_SUBAGENT_CHILD_INDEX: `01${malicious}` };
		break;
	case "overlong":
		process.env = { ...valid, PI_SUBAGENT_RUN_ID: malicious.repeat(100) };
		break;
	case "post-redaction-overflow":
		process.env = {
			...valid,
			PI_SUBAGENT_RUN_ID: originalEnvironment.SHOPIFY_PI_TOKEN.repeat(1024),
		};
		break;
	case "post-redaction-aggregate": {
		const repeated = originalEnvironment.SHOPIFY_PI_TOKEN.repeat(80);
		process.env = {
			...valid,
			PI_SUBAGENT_PARENT_SESSION: repeated,
			PI_SUBAGENT_ORCHESTRATOR_SESSION_ID: repeated,
			PI_SUBAGENT_RUN_ID: repeated,
			PI_SUBAGENT_CHILD_AGENT: repeated,
		};
		break;
	}
	case "canonical-envelope-token":
	case "attribution-eviction":
	case "dynamic-key-collision":
	case "dynamic-key-overflow":
	case "startup-reload-new-id":
		process.env = { ...valid };
		break;
	case "accessor": {
		const environment = { ...valid };
		Object.defineProperty(environment, "PI_SUBAGENT_RUN_ID", {
			enumerable: true,
			get() {
				accessorTouched = true;
				throw new Error(malicious);
			},
		});
		process.env = environment;
		break;
	}
	case "nonstring":
		process.env = { ...valid, PI_SUBAGENT_CHILD_AGENT: { value: malicious } };
		break;
	default:
		throw new Error("unknown Task 3.7 attribution probe mode");
}

const calls = [];
const notifications = [];
let error;

async function invokeSessionStart(reason, sessionId, suffix) {
	const bridgeUrl = pathToFileURL(extensionPath);
	bridgeUrl.search = `task37-${mode}-${suffix}`;
	const { createCavememBridge } = await import(bridgeUrl.href);
	const handlers = new Map();
	createCavememBridge({
		runHook: async (request) => {
			calls.push(request);
		},
	})({
		on(event, handler) {
			handlers.set(event, handler);
		},
	});
	const context = {
		cwd: "/task37/attribution",
		sessionManager: {
			getHeader() { return null; },
			getSessionFile() { return undefined; },
			getSessionId() {
				return typeof sessionId === "string" ? sessionId : sessionId.current;
			},
		},
		ui: {
			notify(message, type) {
				notifications.push({ message, type });
			},
		},
	};
	await handlers.get("session_start")(
		{ type: "session_start", reason },
		context,
	);
	return { context, handlers };
}

try {
	const sessionIdentity = mode === "attribution-eviction"
		? { current: "task37-attribution-evicted" }
		: "task37-attribution-child";
	const first = await invokeSessionStart("startup", sessionIdentity, "startup");
	if (mode === "canonical-envelope-token") {
		const input = { schemaVersion: "task37 caller-owned key" };
		first.handlers.get("tool_execution_start")({
			type: "tool_execution_start",
			toolCallId: "task37-canonical-call",
			toolName: "task37_probe",
			args: input,
		}, first.context);
		first.handlers.get("tool_call")({
			type: "tool_call",
			toolCallId: "task37-canonical-call",
			toolName: "task37_probe",
			input,
		}, first.context);
		await first.handlers.get("tool_result")({
			type: "tool_result",
			toolCallId: "task37-canonical-call",
			toolName: "task37_probe",
			input,
			content: [{ type: "text", text: "task37 canonical result" }],
			details: { schemaVersion: "task37 caller-owned details" },
			isError: false,
		}, first.context);
	}
	if (mode === "dynamic-key-overflow") {
		const input = {
			[originalEnvironment.SHOPIFY_PI_TOKEN.repeat(1024)]: "task37 dynamic key",
		};
		first.handlers.get("tool_execution_start")({
			type: "tool_execution_start",
			toolCallId: "task37-dynamic-key-overflow",
			toolName: "task37_probe",
			args: input,
		}, first.context);
		first.handlers.get("tool_call")({
			type: "tool_call",
			toolCallId: "task37-dynamic-key-overflow",
			toolName: "task37_probe",
			input,
		}, first.context);
		await first.handlers.get("tool_result")({
			type: "tool_result",
			toolCallId: "task37-dynamic-key-overflow",
			toolName: "task37_probe",
			input,
			content: [],
			details: null,
			isError: false,
		}, first.context);
	}
	if (mode === "dynamic-key-collision") {
		first.handlers.get("tool_execution_start")({
			type: "tool_execution_start",
			toolCallId: "task37-dynamic-key-collision",
			toolName: "task37_probe",
			args: {
				[originalEnvironment.SHOPIFY_PI_TOKEN]: "redacts",
				"[REDACTED]": "already present",
			},
		}, first.context);
	}
	if (mode === "startup-reload-new-id") {
		await invokeSessionStart("reload", "task37-attribution-child", "reload");
		await invokeSessionStart("new", "task37-attribution-child-next", "new");
	}
	if (mode === "attribution-eviction") {
		for (let index = 0; index < 256; index += 1) {
			sessionIdentity.current = `task37-attribution-eviction-${index}`;
			await first.handlers.get("session_start")(
				{ type: "session_start", reason: "new" },
				first.context,
			);
		}
		sessionIdentity.current = "task37-attribution-evicted";
		await first.handlers.get("session_start")(
			{ type: "session_start", reason: "new" },
			first.context,
		);
	}
} catch (caught) {
	error = caught instanceof Error ? caught.message : "unknown attribution failure";
}

process.env = originalEnvironment;
process.stdout.write(`${JSON.stringify({ accessorTouched, calls, error, notifications })}\n`);
