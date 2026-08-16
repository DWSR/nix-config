import { pathToFileURL } from "node:url";

const [, , runtimeModulePath, operation = "inspect"] = process.argv;
const BOOTSTRAP_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const REDACTION_MARKER = "[REDACTED]";
const SERIALIZATION_ERROR = "Pi runtime bootstrap is not serializable";
const INPUT_ERROR = "Pi runtime bootstrap redaction input must be a string";
const ENVIRONMENT_ERROR =
	"Pi runtime bootstrap environment properties must be own string data properties";
const DESCRIPTOR_TOKEN = "task27-descriptor-token";
const DESCRIPTOR_LAUNCH_ID = "523e4567-e89b-42d3-8456-426614174000";
let preclaimAccessorTouched = false;
let environmentAccessorTouched = false;

function replaceEnvironment(environment) {
	Object.defineProperty(process, "env", {
		value: environment,
		configurable: true,
		enumerable: true,
		writable: true,
	});
}

if (operation === "inherited-data") {
	const inherited = Object.create(null);
	Object.defineProperties(inherited, {
		SHOPIFY_PI_TOKEN: { value: DESCRIPTOR_TOKEN, enumerable: true },
		PI_AGENT_LAUNCH_ID: { value: DESCRIPTOR_LAUNCH_ID, enumerable: true },
	});
	replaceEnvironment(Object.create(inherited));
} else if (operation === "inherited-getter") {
	const inherited = Object.create(null);
	for (const name of ["SHOPIFY_PI_TOKEN", "PI_AGENT_LAUNCH_ID"]) {
		Object.defineProperty(inherited, name, {
			get() {
				environmentAccessorTouched = true;
				throw new Error("task27-inherited-getter-value");
			},
		});
	}
	replaceEnvironment(Object.create(inherited));
} else if (operation === "own-getter") {
	const environment = Object.create(null);
	Object.defineProperty(environment, "SHOPIFY_PI_TOKEN", {
		get() {
			environmentAccessorTouched = true;
			throw new Error("task27-own-getter-value");
		},
	});
	Object.defineProperty(environment, "PI_AGENT_LAUNCH_ID", {
		value: DESCRIPTOR_LAUNCH_ID,
	});
	replaceEnvironment(environment);
} else if (operation === "own-nonstring") {
	const environment = Object.create(null);
	const hostileValue = Object.create(null);
	Object.defineProperty(hostileValue, Symbol.toPrimitive, {
		get() {
			environmentAccessorTouched = true;
			throw new Error("task27-own-nonstring-value");
		},
	});
	Object.defineProperties(environment, {
		SHOPIFY_PI_TOKEN: { value: hostileValue },
		PI_AGENT_LAUNCH_ID: { value: DESCRIPTOR_LAUNCH_ID },
	});
	replaceEnvironment(environment);
}

if (operation === "preclaim") {
	Object.defineProperty(globalThis, BOOTSTRAP_SYMBOL, {
		get() {
			preclaimAccessorTouched = true;
			throw new Error("preclaim accessor must not run");
		},
		configurable: true,
	});
}

function fixedError(action) {
	try {
		action();
		return null;
	} catch (error) {
		return error instanceof Error ? error.message : "non-error rejection";
	}
}

function emit(value) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

const runtimeUrl = pathToFileURL(runtimeModulePath).href;
try {
	await import(runtimeUrl);
} catch (error) {
	emit({
		ok: false,
		name: error instanceof Error ? error.name : "unknown",
		message: error instanceof Error ? error.message : "non-error rejection",
		preclaimAccessorTouched,
		environmentAccessorTouched,
	});
	process.exit(0);
}

const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, BOOTSTRAP_SYMBOL);
const capability = globalDescriptor?.value;

if (operation === "duplicate") {
	let duplicateError = null;
	try {
		await import(`${runtimeUrl}?duplicate=1`);
	} catch (error) {
		duplicateError = error instanceof Error ? error.message : "non-error rejection";
	}
	emit({ ok: true, duplicateError });
	process.exit(0);
}

const initialTokenDescriptor = Object.getOwnPropertyDescriptor(process.env, "SHOPIFY_PI_TOKEN");
const initialLaunchIdDescriptor = Object.getOwnPropertyDescriptor(process.env, "PI_AGENT_LAUNCH_ID");
const initialToken =
	initialTokenDescriptor && Object.hasOwn(initialTokenDescriptor, "value") &&
	typeof initialTokenDescriptor.value === "string"
		? initialTokenDescriptor.value
		: undefined;
const initialLaunchId =
	initialLaunchIdDescriptor && Object.hasOwn(initialLaunchIdDescriptor, "value") &&
	typeof initialLaunchIdDescriptor.value === "string"
		? initialLaunchIdDescriptor.value
		: undefined;
const ownInput =
	initialToken !== undefined && initialLaunchId !== undefined
		? `before:${initialToken}:middle:${initialLaunchId}:after`
		: "personal input remains ordinary";
const expectedOwn =
	initialToken !== undefined && initialLaunchId !== undefined
		? `before:${REDACTION_MARKER}:middle:${REDACTION_MARKER}:after`
		: ownInput;
const mutatedToken = "task27-mutated-token";
const mutatedLaunchId = "423e4567-e89b-42d3-8456-426614174000";
const mutatedInput = `before:${mutatedToken}:middle:${mutatedLaunchId}:after`;

let intrinsicResult = null;
if (operation === "intrinsics") {
	const indexOfDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "indexOf");
	const sliceDescriptor = Object.getOwnPropertyDescriptor(String.prototype, "slice");
	try {
		Object.defineProperty(String.prototype, "indexOf", {
			...indexOfDescriptor,
			value() {
				throw new Error("mutated indexOf must not run");
			},
		});
		Object.defineProperty(String.prototype, "slice", {
			...sliceDescriptor,
			value() {
				throw new Error("mutated slice must not run");
			},
		});
		intrinsicResult = capability.redactExact(ownInput);
	} finally {
		Object.defineProperty(String.prototype, "indexOf", indexOfDescriptor);
		Object.defineProperty(String.prototype, "slice", sliceDescriptor);
	}
}

Object.defineProperties(process.env, {
	SHOPIFY_PI_TOKEN: {
		value: mutatedToken,
		configurable: true,
		enumerable: true,
		writable: true,
	},
	PI_AGENT_LAUNCH_ID: {
		value: mutatedLaunchId,
		configurable: true,
		enumerable: true,
		writable: true,
	},
});

let accessorTouched = false;
const hostileInput = Object.create(null);
for (const key of ["toJSON", "toString", "valueOf", Symbol.toPrimitive]) {
	Object.defineProperty(hostileInput, key, {
		get() {
			accessorTouched = true;
			throw new Error("probe accessor must not run");
		},
	});
}
const hostileInputError = fixedError(() => capability.redactExact(hostileInput));
const ownKeys = Reflect.ownKeys(capability).map(String);
const redactedOwnInput = capability.redactExact(ownInput);

emit({
	ok: true,
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
	redactsExpected: redactedOwnInput === expectedOwn,
	capturedValuesAbsent:
		initialToken === undefined ||
		initialLaunchId === undefined ||
		(!redactedOwnInput.includes(initialToken) && !redactedOwnInput.includes(initialLaunchId)),
	mutationIgnored: capability.redactExact(mutatedInput) === mutatedInput,
	outputIsString: typeof capability.redactExact(ownInput) === "string",
	serializationError: fixedError(() => JSON.stringify(capability)),
	nestedSerializationError: fixedError(() => JSON.stringify({ capability })),
	structuredCloneRejected: fixedError(() => structuredClone(capability)) !== null,
	hostileInputError,
	accessorTouched,
	intrinsicsCaptured: operation !== "intrinsics" || intrinsicResult === expectedOwn,
	expectedSerializationError: SERIALIZATION_ERROR,
	expectedInputError: INPUT_ERROR,
	expectedEnvironmentError: ENVIRONMENT_ERROR,
	environmentAccessorTouched,
});
