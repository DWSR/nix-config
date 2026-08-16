import fs from "node:fs";

const BOOTSTRAP_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const FIXTURE_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.fixture.v1");
const REDACTION_MARKER = "[REDACTED]";
const SERIALIZATION_ERROR = "Pi runtime bootstrap is not serializable";
const INPUT_ERROR = "Pi runtime bootstrap redaction input must be a string";

const scenarios = {
	loader: {
		mode: "shopify-gateway",
		token: "task27-loader-123e4567-e89b-42d3-a456-426614174000-token",
		launchId: "123e4567-e89b-42d3-a456-426614174000",
		otherToken: "task27-child-b-token",
		otherLaunchId: "223e4567-e89b-42d3-b456-426614174000",
	},
	"child-a": {
		mode: "shopify-gateway",
		token: "task27-child-a-token",
		launchId: "123e4567-e89b-42d3-8456-426614174001",
		otherToken: "task27-child-b-token",
		otherLaunchId: "223e4567-e89b-42d3-b456-426614174000",
	},
	"child-b": {
		mode: "shopify-gateway",
		token: "task27-child-b-token",
		launchId: "223e4567-e89b-42d3-b456-426614174000",
		otherToken: "task27-child-a-token",
		otherLaunchId: "123e4567-e89b-42d3-8456-426614174001",
	},
	personal: {
		mode: "personal",
		token: "task27-personal-unchanged-token",
		launchId: "323e4567-e89b-42d3-8456-426614174000",
		otherToken: "task27-child-a-token",
		otherLaunchId: "123e4567-e89b-42d3-8456-426614174001",
	},
} as const;

interface PiRuntimeBootstrapV1 {
	readonly schemaVersion: 1;
	readonly mode: "personal" | "shopify-gateway";
	readonly redactExact: (value: string) => string;
}

interface ProbeRecord {
	readonly capability: PiRuntimeBootstrapV1;
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

export default function bootstrapProbe(): void {
	const scenarioName = process.env.PI_BOOTSTRAP_FIXTURE_SCENARIO as keyof typeof scenarios;
	const scenario = scenarios[scenarioName];
	if (!scenario) throw new Error("Pi bootstrap fixture scenario is invalid");

	const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, BOOTSTRAP_SYMBOL);
	const capability = globalDescriptor?.value as PiRuntimeBootstrapV1 | undefined;
	if (!capability) throw new Error("Pi runtime bootstrap capability is unavailable");

	const ownInput = `before:${scenario.token}:middle:${scenario.launchId}:after`;
	const expectedOwn =
		scenario.mode === "shopify-gateway"
			? `before:${REDACTION_MARKER}:middle:${REDACTION_MARKER}:after`
			: ownInput;
	const otherInput = `before:${scenario.otherToken}:middle:${scenario.otherLaunchId}:after`;
	let accessorTouched = false;
	const hostileInput = Object.create(null) as Record<PropertyKey, unknown>;
	for (const key of ["toJSON", "toString", "valueOf", Symbol.toPrimitive]) {
		Object.defineProperty(hostileInput, key, {
			get() {
				accessorTouched = true;
				throw new Error("fixture accessor must not run");
			},
		});
	}
	const hostileInputError = fixedError(() => capability.redactExact(hostileInput as unknown as string));
	const ownKeys = Reflect.ownKeys(capability).map(String);
	const serializable = Object.freeze({
		schemaVersion: capability.schemaVersion,
		mode: capability.mode,
		globalDescriptorLocked:
			globalDescriptor?.configurable === false &&
			globalDescriptor.enumerable === false &&
			globalDescriptor.writable === false,
		capabilityFrozen: Object.isFrozen(capability),
		redactorFrozen: Object.isFrozen(capability.redactExact),
		ownKeys,
		noRawCollection:
			!Array.isArray(capability) &&
			!(capability instanceof Set) &&
			!(Symbol.iterator in capability) &&
			ownKeys.join(",") === "schemaVersion,mode,redactExact,toJSON",
		redactsExpected: capability.redactExact(ownInput) === expectedOwn,
		preservesOther: capability.redactExact(otherInput) === otherInput,
		outputIsString: typeof capability.redactExact(ownInput) === "string",
		serializationError: fixedError(() => JSON.stringify(capability)),
		nestedSerializationError: fixedError(() => JSON.stringify({ capability })),
		structuredCloneRejected: fixedError(() => structuredClone(capability)) !== null,
		hostileInputError,
		accessorTouched,
	});

	if (serializable.serializationError !== SERIALIZATION_ERROR) {
		throw new Error("Pi runtime bootstrap serialization contract is invalid");
	}
	if (serializable.hostileInputError !== INPUT_ERROR || accessorTouched) {
		throw new Error("Pi runtime bootstrap input contract is invalid");
	}

	let state = Object.getOwnPropertyDescriptor(globalThis, FIXTURE_SYMBOL)?.value as ProbeState | undefined;
	if (!state) {
		state = { records: [] };
		Object.defineProperty(globalThis, FIXTURE_SYMBOL, {
			value: state,
			configurable: true,
			writable: false,
			enumerable: false,
		});
	}
	state.records.push({ capability, serializable });

	const outputPath = process.env.PI_BOOTSTRAP_FIXTURE_OUTPUT;
	if (outputPath) fs.writeFileSync(outputPath, `${JSON.stringify(serializable)}\n`, "utf8");
}
