import childProcess from "node:child_process";
import fs from "node:fs";

const BOOTSTRAP_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const CAVEMEM_ENVIRONMENT_SYMBOL = Symbol.for("dwsr.pi-agent.cavemem-environment.v1");
const FIXTURE_SYMBOL = Symbol.for("dwsr.pi-agent.cavemem-environment.fixture.v1");
const SERIALIZATION_ERROR = "Cavemem process environment is not serializable";

interface PiRuntimeBootstrapV1 {
	readonly schemaVersion: 1;
	readonly mode: "personal" | "shopify-gateway";
	readonly redactExact: (value: string) => string;
}

interface CavememProcessEnvironmentV1 {
	readonly schemaVersion: 1;
	readonly environment: Readonly<Record<string, string>>;
}

interface ProbeRecord {
	readonly environmentCapability: CavememProcessEnvironmentV1;
	readonly redactionCapability: PiRuntimeBootstrapV1;
	readonly serializable: Readonly<Record<string, unknown>>;
}

interface ProbeState {
	readonly records: ProbeRecord[];
}

function fixedError(action: () => unknown): string | null {
	try {
		action();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : "non-error rejection";
	}
}

export default function cavememEnvironmentProbe(): void {
	const environmentDescriptor = Object.getOwnPropertyDescriptor(
		globalThis,
		CAVEMEM_ENVIRONMENT_SYMBOL,
	);
	const redactionDescriptor = Object.getOwnPropertyDescriptor(globalThis, BOOTSTRAP_SYMBOL);
	const environmentCapability = environmentDescriptor?.value as
		| CavememProcessEnvironmentV1
		| undefined;
	const redactionCapability = redactionDescriptor?.value as PiRuntimeBootstrapV1 | undefined;
	if (!environmentCapability || !redactionCapability) {
		throw new Error("Pi runtime capabilities are unavailable");
	}

	let childEnvironment: Record<string, string> | null = null;
	const childPath = process.env.PI_CAVEMEM_ENV_FIXTURE_CHILD;
	if (childPath) {
		const child = childProcess.spawnSync(process.execPath, [childPath], {
			env: environmentCapability.environment,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 30_000,
		});
		if (child.error) throw child.error;
		if (child.status !== 0) {
			throw new Error(`Cavemem environment child failed with status ${String(child.status)}`);
		}
		childEnvironment = (JSON.parse(child.stdout) as { environment: Record<string, string> }).environment;
	}

	const serializable = Object.freeze({
		schemaVersion: environmentCapability.schemaVersion,
		environment: { ...environmentCapability.environment },
		childEnvironment,
		redactionMode: redactionCapability.mode,
		globalDescriptorLocked:
			environmentDescriptor?.configurable === false &&
			environmentDescriptor.enumerable === false &&
			environmentDescriptor.writable === false,
		capabilityFrozen: Object.isFrozen(environmentCapability),
		environmentFrozen: Object.isFrozen(environmentCapability.environment),
		environmentPlain: Object.getPrototypeOf(environmentCapability.environment) === Object.prototype,
		ownKeys: Reflect.ownKeys(environmentCapability).map(String),
		serializationError: fixedError(() => JSON.stringify(environmentCapability)),
		nestedSerializationError: fixedError(() => JSON.stringify({ environmentCapability })),
		redactionCapabilityPreserved:
			redactionCapability.schemaVersion === 1 &&
			typeof redactionCapability.redactExact === "function" &&
			Object.isFrozen(redactionCapability),
	});

	if (
		serializable.serializationError !== SERIALIZATION_ERROR ||
		serializable.nestedSerializationError !== SERIALIZATION_ERROR
	) {
		throw new Error("Cavemem process environment serialization contract is invalid");
	}

	let state = Object.getOwnPropertyDescriptor(globalThis, FIXTURE_SYMBOL)?.value as
		| ProbeState
		| undefined;
	if (!state) {
		state = { records: [] };
		Object.defineProperty(globalThis, FIXTURE_SYMBOL, {
			value: state,
			configurable: true,
			writable: false,
			enumerable: false,
		});
	}
	state.records.push({ environmentCapability, redactionCapability, serializable });

	const outputPath = process.env.PI_CAVEMEM_ENV_FIXTURE_OUTPUT;
	if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(serializable)}\n`, "utf8");
}
