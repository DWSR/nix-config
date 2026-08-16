import { pathToFileURL } from "node:url";

const [, , runtimeModulePath, operation = "inspect"] = process.argv;
const BOOTSTRAP_SYMBOL = Symbol.for("dwsr.pi-agent.runtime-bootstrap.v1");
const CAVEMEM_ENVIRONMENT_SYMBOL = Symbol.for("dwsr.pi-agent.cavemem-environment.v1");
const SERIALIZATION_ERROR = "Cavemem process environment is not serializable";
const ENVIRONMENT_ERROR =
	"Cavemem process environment properties must be own string data properties";
const DESCRIPTOR_VALUE = "task28-descriptor-value";
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
		PATH: { value: DESCRIPTOR_VALUE, enumerable: true },
		CAVEMEM_DATA_DIR: { value: "/task28/inherited/data", enumerable: true },
	});
	replaceEnvironment(Object.create(inherited));
} else if (operation === "inherited-getter") {
	const inherited = Object.create(null);
	for (const name of ["PATH", "CAVEMEM_DATA_DIR"]) {
		Object.defineProperty(inherited, name, {
			get() {
				environmentAccessorTouched = true;
				throw new Error("task28-inherited-getter-value");
			},
		});
	}
	replaceEnvironment(Object.create(inherited));
} else if (operation === "own-getter") {
	const environment = Object.create(null);
	Object.defineProperty(environment, "PATH", {
		get() {
			environmentAccessorTouched = true;
			throw new Error("task28-own-getter-value");
		},
	});
	replaceEnvironment(environment);
} else if (operation === "own-nonstring") {
	const environment = Object.create(null);
	const hostileValue = Object.create(null);
	Object.defineProperty(hostileValue, Symbol.toPrimitive, {
		get() {
			environmentAccessorTouched = true;
			throw new Error("task28-own-nonstring-value");
		},
	});
	Object.defineProperty(environment, "PATH", { value: hostileValue });
	replaceEnvironment(environment);
} else if (operation === "own-nonenumerable-string") {
	const environment = Object.create(null);
	Object.defineProperty(environment, "PATH", { value: DESCRIPTOR_VALUE });
	replaceEnvironment(environment);
}

if (operation === "preclaim") {
	Object.defineProperty(globalThis, CAVEMEM_ENVIRONMENT_SYMBOL, {
		get() {
			preclaimAccessorTouched = true;
			throw new Error("task28 preclaim accessor must not run");
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

const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, CAVEMEM_ENVIRONMENT_SYMBOL);
const capability = globalDescriptor?.value;
const redactionCapability = Object.getOwnPropertyDescriptor(globalThis, BOOTSTRAP_SYMBOL)?.value;

if (!capability) {
	emit({ ok: false, message: "Cavemem process environment capability is unavailable" });
	process.exit(0);
}

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

const capturedEnvironment = { ...capability.environment };
const initialPath = capability.environment.PATH;
const initialDataDir = capability.environment.CAVEMEM_DATA_DIR;
replaceEnvironment({
	PATH: "task28-mutated-path",
	CAVEMEM_DATA_DIR: "/task28/mutated/data",
});

const capabilityDescriptors = Object.getOwnPropertyDescriptors(capability);
const environmentDescriptors = Object.getOwnPropertyDescriptors(capability.environment);
const ownKeys = Reflect.ownKeys(capability).map(String);

emit({
	ok: true,
	schemaVersion: capability.schemaVersion,
	environment: capturedEnvironment,
	globalDescriptorLocked:
		globalDescriptor?.configurable === false &&
		globalDescriptor.enumerable === false &&
		globalDescriptor.writable === false,
	capabilityFrozen: Object.isFrozen(capability),
	environmentFrozen: Object.isFrozen(capability.environment),
	environmentPlain: Object.getPrototypeOf(capability.environment) === Object.prototype,
	ownKeys,
	capabilityDescriptorShape:
		capabilityDescriptors.toJSON?.configurable === false &&
		capabilityDescriptors.toJSON.enumerable === false &&
		capabilityDescriptors.toJSON.writable === false &&
		capabilityDescriptors.schemaVersion?.enumerable === true &&
		capabilityDescriptors.environment?.enumerable === true,
	environmentDescriptorsLocked: Object.values(environmentDescriptors).every(
		(descriptor) =>
			descriptor.configurable === false &&
			descriptor.enumerable === true &&
			descriptor.writable === false,
	),
	mutationIgnored:
		capability.environment.PATH === initialPath &&
		capability.environment.CAVEMEM_DATA_DIR === initialDataDir,
	capabilityMutationRejected:
		fixedError(() => {
			capability.environment = {};
		}) !== null,
	environmentMutationRejected:
		fixedError(() => {
			capability.environment.PATH = "task28-replacement-path";
		}) !== null,
	serializationError: fixedError(() => JSON.stringify(capability)),
	nestedSerializationError: fixedError(() => JSON.stringify({ capability })),
	noMutationApi: ownKeys.every((name) => !/(?:mutate|release|replace|set|clear|delete)/i.test(name)),
	redactionCapabilityPreserved:
		redactionCapability?.schemaVersion === 1 &&
		typeof redactionCapability?.redactExact === "function" &&
		Object.isFrozen(redactionCapability),
	expectedSerializationError: SERIALIZATION_ERROR,
	expectedEnvironmentError: ENVIRONMENT_ERROR,
	preclaimAccessorTouched,
	environmentAccessorTouched,
});
