import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const overlayPath = path.join(repoRoot, "overlays/pi-agent/default.nix");
const redactionPatchPath = path.join(
	repoRoot,
	"overlays/pi-agent/pi-launch-redaction-bootstrap.patch",
);
const environmentPatchPath = path.join(
	repoRoot,
	"overlays/pi-agent/pi-cavemem-environment-bootstrap.patch",
);
const fixtureRoot = path.join(
	repoRoot,
	"tests/pi-agent/fixtures/cavemem-environment-bootstrap",
);
const runtimeProbePath = path.join(fixtureRoot, "runtime-probe.mjs");
const loaderProbePath = path.join(fixtureRoot, "loader-probe.mjs");
const extensionPath = path.join(fixtureRoot, "probe-extension.ts");
const childProbePath = path.join(fixtureRoot, "child-probe.mjs");
const expectedVersion = "0.83.0";
const expectedNpmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
const expectedRedactionPatchSha256 =
	"49a50f6f8d3d6946159f80017acbfb6438b13d773355c389354d2eda27a4cb11";
const expectedAllowlist = [
	"CAVEMEM_DATA_DIR",
	"COLORTERM",
	"HOME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"LOGNAME",
	"NO_COLOR",
	"PATH",
	"SHELL",
	"TERM",
	"TERM_PROGRAM",
	"TMPDIR",
	"USER",
	"XDG_CACHE_HOME",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
];
const environmentDuplicateError = "Cavemem process environment is already installed";
const environmentSerializationError = "Cavemem process environment is not serializable";
const environmentShapeError =
	"Cavemem process environment properties must be own string data properties";
const provider = {
	token: "task28-provider-token-123e4567-e89b-42d3-a456-426614174000",
	launchId: "123e4567-e89b-42d3-a456-426614174000",
};
const childA = {
	token: "task28-child-a-provider-token",
	launchId: "123e4567-e89b-42d3-8456-426614174001",
};
const childB = {
	token: "task28-child-b-provider-token",
	launchId: "223e4567-e89b-42d3-b456-426614174000",
};
const forbiddenSentinel = "task28-forbidden-environment-value";
const commandOptions = {
	cwd: repoRoot,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
	timeout: 1_200_000,
};

let builtPiPath;
let cachedPolicyContract;
let cachedPackageMetadata;

function filteredFlakeExpression(body) {
	return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-cavemem-environment-tests";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
    in
      ${body}
  `;
}

function run(command, args, options = {}) {
	const result = childProcess.spawnSync(command, args, {
		...commandOptions,
		...options,
	});
	if (result.error) throw result.error;
	return result;
}

function nixEvalJson(expression) {
	const result = run("nix", ["eval", "--json", "--impure", "--expr", expression]);
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

function policyContract() {
	cachedPolicyContract ??= nixEvalJson(
		filteredFlakeExpression(`
      let
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
        policy = import (source + "/home-manager/common/pi-agent/credential-policy.nix") {
          inherit pkgs;
          inherit (pkgs) lib;
        };
      in
      {
        allowlist = policy.cavememEnvironmentAllowlist;
        sensitiveNames = builtins.filter
          (name: name != policy.bashTimeoutBinding.environmentName)
          policy.shellRemoveNames;
      }
    `),
	);
	return cachedPolicyContract;
}

function packageMetadata() {
	cachedPackageMetadata ??= nixEvalJson(
		filteredFlakeExpression(`
      let
        package = flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent;
        upstream = flake.inputs.pi-nix.packages.aarch64-darwin.coding-agent;
      in
      {
        inherit (package) version npmDepsHash;
        npmDepsOutputHash = package.npmDeps.outputHash;
        sourceMatches = package.src == upstream.src;
        patches = map toString package.patches;
      }
    `),
	);
	return cachedPackageMetadata;
}

function buildPi() {
	if (builtPiPath) return builtPiPath;
	const result = run("nix", [
		"build",
		"--no-link",
		"--print-out-paths",
		"--impure",
		"--expr",
		filteredFlakeExpression("flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent"),
	]);
	assert.equal(result.status, 0, result.stderr);
	builtPiPath = result.stdout.trim();
	assert.match(builtPiPath, /^\/nix\/store\/[^\n]+-pi-coding-agent-0\.83\.0$/);
	return builtPiPath;
}

function runtimeModulePath() {
	return path.join(
		buildPi(),
		"lib/node_modules/@earendil-works/pi-coding-agent/dist/runtime-bootstrap.js",
	);
}

function managedEnvironment(overrides = {}) {
	const environment = { ...process.env, NO_COLOR: "1" };
	for (const name of ["SHOPIFY_PI_TOKEN", "PI_AGENT_LAUNCH_ID", "NODE_OPTIONS"]) {
		delete environment[name];
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (value === undefined) delete environment[name];
		else environment[name] = value;
	}
	return environment;
}

function expectedEnvironment(root, dataDir, suffix) {
	const values = {
		CAVEMEM_DATA_DIR: dataDir,
		COLORTERM: `truecolor-${suffix}`,
		HOME: path.join(root, "home"),
		LANG: "C",
		LC_ALL: "C",
		LC_CTYPE: "C",
		LOGNAME: `task28-${suffix}`,
		NO_COLOR: "1",
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		SHELL: process.env.SHELL ?? "/bin/zsh",
		TERM: "xterm-256color",
		TERM_PROGRAM: `task28-${suffix}`,
		TMPDIR: path.join(root, "tmp"),
		USER: `task28-${suffix}`,
		XDG_CACHE_HOME: path.join(root, "xdg-cache"),
		XDG_CONFIG_HOME: path.join(root, "xdg-config"),
		XDG_DATA_HOME: path.join(root, "xdg-data"),
		XDG_STATE_HOME: path.join(root, "xdg-state"),
	};
	for (const name of [
		"HOME",
		"TMPDIR",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
		"XDG_DATA_HOME",
		"XDG_STATE_HOME",
	]) {
		fs.mkdirSync(values[name], { recursive: true });
	}
	fs.mkdirSync(dataDir, { recursive: true });
	return values;
}

function runRuntimeProbe(operation, environment = {}) {
	const result = run(
		process.execPath,
		[runtimeProbePath, runtimeModulePath(), operation],
		{ env: managedEnvironment(environment) },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.notEqual(result.stdout.trim(), "", "runtime probe returned no result");
	return { result, report: JSON.parse(result.stdout) };
}

function assertValueFree(result, values) {
	const output = `${result.stdout}\n${result.stderr}`;
	for (const value of values.filter(Boolean)) assert.equal(output.includes(value), false);
}

function isPatchPath(entry, filePath) {
	const entryName = path.basename(entry);
	const fileName = path.basename(filePath);
	return entryName === fileName || entryName.endsWith(`-${fileName}`);
}

function assertTreeValueFree(root, values) {
	for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
		const entryPath = path.join(root, entry.name);
		if (entry.isDirectory()) {
			assertTreeValueFree(entryPath, values);
			continue;
		}
		if (!entry.isFile()) continue;
		const bytes = fs.readFileSync(entryPath);
		for (const value of values.filter(Boolean)) {
			assert.equal(bytes.includes(Buffer.from(value, "utf8")), false, `runtime value persisted in ${entryPath}`);
		}
	}
}

function assertCapabilityReport(report, environment) {
	assert.equal(report.ok, true);
	assert.equal(report.schemaVersion, 1);
	assert.deepEqual(report.environment, environment);
	assert.equal(report.globalDescriptorLocked, true);
	assert.equal(report.capabilityFrozen, true);
	assert.equal(report.environmentFrozen, true);
	assert.equal(report.environmentPlain, true);
	assert.deepEqual(report.ownKeys, ["schemaVersion", "environment", "toJSON"]);
	assert.equal(report.capabilityDescriptorShape, true);
	assert.equal(report.environmentDescriptorsLocked, true);
	assert.equal(report.mutationIgnored, true);
	assert.equal(report.capabilityMutationRejected, true);
	assert.equal(report.environmentMutationRejected, true);
	assert.equal(report.serializationError, environmentSerializationError);
	assert.equal(report.nestedSerializationError, environmentSerializationError);
	assert.equal(report.noMutationApi, true);
	assert.equal(report.redactionCapabilityPreserved, true);
	assert.equal(report.preclaimAccessorTouched, false);
	assert.equal(report.environmentAccessorTouched, false);
}

function runDirectFixture(suffix, runtimeProvider = {}) {
	const piRoot = buildPi();
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `pi-cavemem-env-${suffix}-`));
	const cwd = path.join(root, "workspace");
	const agentDir = path.join(root, "agent");
	const output = path.join(root, "probe.json");
	const dataDir = path.join(root, "shared-cavemem");
	for (const directory of [cwd, agentDir]) fs.mkdirSync(directory, { recursive: true });
	const expected = expectedEnvironment(root, dataDir, suffix);
	const result = run(
		path.join(piRoot, "bin/pi"),
		[
			"--offline",
			"--approve",
			"--no-extensions",
			"--extension",
			extensionPath,
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--list-models",
		],
		{
			cwd,
			env: managedEnvironment({
				...expected,
				PI_CODING_AGENT_DIR: agentDir,
				PI_CAVEMEM_ENV_FIXTURE_OUTPUT: output,
				PI_CAVEMEM_ENV_FIXTURE_CHILD: childProbePath,
				SHOPIFY_PI_TOKEN: runtimeProvider.token,
				PI_AGENT_LAUNCH_ID: runtimeProvider.launchId,
				PI_AGENT_BASH_TIMEOUT_MS: "90000",
				CAVEMEM_NO_AUTOSTART: "1",
				PI_SUBAGENT_UNDECLARED: forbiddenSentinel,
				UNDECLARED_HOST_VALUE: forbiddenSentinel,
			}),
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(output), true, "direct Pi did not load the Cavemem environment probe");
	return {
		root,
		output,
		expected,
		report: JSON.parse(fs.readFileSync(output, "utf8")),
		result,
	};
}

test("policy generation and package composition preserve the closed bootstrap provenance", () => {
	const overlay = fs.readFileSync(overlayPath, "utf8");
	const redactionPatch = fs.readFileSync(redactionPatchPath, "utf8");
	const environmentPatch = fs.readFileSync(environmentPatchPath, "utf8");
	const contract = policyContract();
	assert.deepEqual(contract.allowlist, expectedAllowlist);
	assert.deepEqual(contract.allowlist, [...new Set(contract.allowlist)].sort());
	for (const name of contract.sensitiveNames) assert.equal(contract.allowlist.includes(name), false);
	for (const name of [
		"PI_AGENT_BASH_TIMEOUT_MS",
		"CAVEMEM_NO_AUTOSTART",
		"PI_SUBAGENT_UNDECLARED",
		"UNDECLARED_HOST_VALUE",
	]) {
		assert.equal(contract.allowlist.includes(name), false);
	}

	assert.equal(
		crypto.createHash("sha256").update(redactionPatch).digest("hex"),
		expectedRedactionPatchSha256,
	);
	assert.match(environmentPatch, /^Task: pi-agent-integration 2\.8$/m);
	assert.match(
		environmentPatch,
		/^Backport-base: https:\/\/github\.com\/earendil-works\/pi\/tree\/v0\.83\.0$/m,
	);
	assert.match(environmentPatch, /^License: MIT /m);
	assert.match(environmentPatch, /@cavememEnvironmentAllowlist@/);
	const changedFiles = [...environmentPatch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(
		([, before, after]) => {
			assert.equal(before, after);
			return before;
		},
	);
	assert.deepEqual(changedFiles, ["packages/coding-agent/src/runtime-bootstrap.ts"]);
	assert.match(
		overlay,
		/piCavememEnvironmentBootstrapPatch = final\.replaceVars \.\/pi-cavemem-environment-bootstrap\.patch/,
	);
	assert.doesNotMatch(overlay, /piCavememEnvironmentBootstrapEnabled/);
	assert.doesNotMatch(
		`${overlay}\n${environmentPatch}`,
		/PI_CAVEMEM_ENVIRONMENT_BOOTSTRAP_ENABLED|TODO.*Cavemem.*environment/i,
	);

	const metadata = packageMetadata();
	assert.equal(metadata.version, expectedVersion);
	assert.equal(metadata.sourceMatches, true);
	assert.equal(metadata.npmDepsHash, expectedNpmDepsHash);
	assert.equal(metadata.npmDepsOutputHash, expectedNpmDepsHash);
	assert.equal(metadata.patches.filter((entry) => isPatchPath(entry, redactionPatchPath)).length, 1);
	assert.equal(metadata.patches.filter((entry) => isPatchPath(entry, environmentPatchPath)).length, 1);
	assert.ok(
		metadata.patches.findIndex((entry) => isPatchPath(entry, redactionPatchPath)) <
			metadata.patches.findIndex((entry) => isPatchPath(entry, environmentPatchPath)),
	);

	const piRoot = buildPi();
	assert.deepEqual(fs.readdirSync(path.join(piRoot, "bin")), ["pi"]);
	const generatedPatchPath = metadata.patches.find(
		(entry) => isPatchPath(entry, environmentPatchPath),
	);
	assert.ok(generatedPatchPath);
	const generatedPatch = fs.readFileSync(generatedPatchPath, "utf8");
	assert.equal(generatedPatch.includes("@cavememEnvironmentAllowlist@"), false);
	assert.equal(generatedPatch.includes(JSON.stringify(expectedAllowlist)), true);
	const runtimeSource = fs.readFileSync(runtimeModulePath(), "utf8");
	const compiledAllowlist = runtimeSource.match(
		/const CAVEMEM_ENVIRONMENT_ALLOW_NAMES = (\[[^\n]+\]);/,
	)?.[1];
	assert.ok(compiledAllowlist);
	assert.deepEqual(JSON.parse(compiledAllowlist), expectedAllowlist);
	assert.doesNotMatch(
		generatedPatch
			.split("\n")
			.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
			.join("\n"),
		/NODE_OPTIONS|node:fs|writeFile|readFile|process\.stdin/,
	);
});

test("runtime capability snapshots the exact policy allowlist without provider values", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-cavemem-env-runtime-"));
	try {
		const expected = expectedEnvironment(root, path.join(root, "cavemem"), "runtime");
		const { sensitiveNames } = policyContract();
		const forbidden = Object.fromEntries(sensitiveNames.map((name) => [name, forbiddenSentinel]));
		const { report, result } = runRuntimeProbe("inspect", {
			...expected,
			...forbidden,
			SHOPIFY_PI_TOKEN: provider.token,
			PI_AGENT_LAUNCH_ID: provider.launchId,
			PI_AGENT_BASH_TIMEOUT_MS: forbiddenSentinel,
			CAVEMEM_NO_AUTOSTART: forbiddenSentinel,
			PI_SUBAGENT_UNDECLARED: forbiddenSentinel,
			UNDECLARED_HOST_VALUE: forbiddenSentinel,
		});
		assertCapabilityReport(report, expected);
		assert.deepEqual(Object.keys(report.environment).sort(), expectedAllowlist);
		assertValueFree(result, [provider.token, provider.launchId, forbiddenSentinel]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("allowed names containing exact provider values are omitted rather than redacted", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-cavemem-env-redaction-"));
	try {
		const expected = expectedEnvironment(root, path.join(root, "cavemem"), "redaction");
		expected.PATH = `/safe/bin:${provider.token}`;
		expected.CAVEMEM_DATA_DIR = path.join(root, provider.launchId);
		const retained = { ...expected };
		delete retained.PATH;
		delete retained.CAVEMEM_DATA_DIR;
		const { report, result } = runRuntimeProbe("inspect", {
			...expected,
			SHOPIFY_PI_TOKEN: provider.token,
			PI_AGENT_LAUNCH_ID: provider.launchId,
		});
		assertCapabilityReport(report, retained);
		assert.equal(Object.values(report.environment).includes("[REDACTED]"), false);
		assertValueFree(result, [provider.token, provider.launchId]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("descriptor-safe capture ignores inherited values and rejects hostile own values value-free", () => {
	for (const operation of ["inherited-data", "inherited-getter"]) {
		const { report, result } = runRuntimeProbe(operation);
		assertCapabilityReport(report, {});
		assert.equal(report.environmentAccessorTouched, false);
		assertValueFree(result, ["task28-descriptor-value", "task28-inherited-getter-value"]);
	}

	const nonenumerable = runRuntimeProbe("own-nonenumerable-string");
	assertCapabilityReport(nonenumerable.report, { PATH: "task28-descriptor-value" });

	for (const operation of ["own-getter", "own-nonstring"]) {
		const { report, result } = runRuntimeProbe(operation);
		assert.equal(report.ok, false);
		assert.equal(report.message, environmentShapeError);
		assert.equal(report.environmentAccessorTouched, false);
		assertValueFree(result, ["task28-own-getter-value", "task28-own-nonstring-value"]);
	}
});

test("preclaimed and duplicate Cavemem symbols fail before Pi with fixed diagnostics", () => {
	const preclaimed = runRuntimeProbe("preclaim", {
		SHOPIFY_PI_TOKEN: provider.token,
		PI_AGENT_LAUNCH_ID: provider.launchId,
	});
	assert.equal(preclaimed.report.ok, false);
	assert.equal(preclaimed.report.message, environmentDuplicateError);
	assert.equal(preclaimed.report.preclaimAccessorTouched, false);
	assertValueFree(preclaimed.result, [provider.token, provider.launchId]);

	const duplicate = runRuntimeProbe("duplicate", {
		SHOPIFY_PI_TOKEN: provider.token,
		PI_AGENT_LAUNCH_ID: provider.launchId,
	});
	assert.equal(duplicate.report.ok, true);
	assert.equal(duplicate.report.duplicateError, "Pi runtime bootstrap is already installed");
	assertValueFree(duplicate.result, [provider.token, provider.launchId]);
});

test("real DefaultResourceLoader reload reuses both process snapshots", () => {
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-cavemem-env-reload-"));
	try {
		const expected = expectedEnvironment(root, path.join(root, "shared-cavemem"), "reload");
		const result = run(process.execPath, [loaderProbePath, buildPi(), extensionPath], {
			env: managedEnvironment({
				...expected,
				SHOPIFY_PI_TOKEN: provider.token,
				PI_AGENT_LAUNCH_ID: provider.launchId,
			}),
		});
		assert.equal(result.status, 0, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.deepEqual(report.firstErrors, []);
		assert.deepEqual(report.secondErrors, []);
		assert.equal(report.loads, 2);
		assert.equal(report.sameEnvironmentCapability, true);
		assert.equal(report.sameRedactionCapability, true);
		assert.equal(report.matchesInstalled, true);
		assert.equal(report.records.length, 2);
		for (const record of report.records) {
			assert.deepEqual(record.environment, expected);
			assert.equal(record.redactionMode, "shopify-gateway");
			assert.equal(record.serializationError, environmentSerializationError);
			assert.equal(record.nestedSerializationError, environmentSerializationError);
		}
		assertValueFree(result, [
			provider.token,
			provider.launchId,
			"task28-reload-mutated-token",
			"223e4567-e89b-42d3-b456-426614174000",
		]);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("direct and foreground child Pi processes create independent scrubbed snapshots", () => {
	const fixtures = [
		runDirectFixture("personal"),
		runDirectFixture("child-a", childA),
		runDirectFixture("child-b", childB),
	];
	try {
		for (const fixture of fixtures) {
			const effectiveExpected = {
				...fixture.expected,
				PATH: fixture.report.environment.PATH,
			};
			assert.ok(fixture.report.environment.PATH.startsWith(fixture.expected.PATH));
			assert.deepEqual(fixture.report.environment, effectiveExpected);
			const childEnvironment = { ...fixture.report.childEnvironment };
			const childPlatformNames = [];
			if (Object.hasOwn(childEnvironment, "__CF_USER_TEXT_ENCODING")) {
				childPlatformNames.push("__CF_USER_TEXT_ENCODING");
				delete childEnvironment.__CF_USER_TEXT_ENCODING;
			}
			assert.deepEqual(childPlatformNames, process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : []);
			assert.deepEqual(childEnvironment, effectiveExpected);
			assert.deepEqual(Object.keys(fixture.report.environment).sort(), expectedAllowlist);
			assert.equal(fixture.report.schemaVersion, 1);
			assert.equal(fixture.report.globalDescriptorLocked, true);
			assert.equal(fixture.report.capabilityFrozen, true);
			assert.equal(fixture.report.environmentFrozen, true);
			assert.equal(fixture.report.environmentPlain, true);
			assert.deepEqual(fixture.report.ownKeys, ["schemaVersion", "environment", "toJSON"]);
			assert.equal(fixture.report.serializationError, environmentSerializationError);
			assert.equal(fixture.report.nestedSerializationError, environmentSerializationError);
			assert.equal(fixture.report.redactionCapabilityPreserved, true);
			assert.equal("PI_AGENT_BASH_TIMEOUT_MS" in fixture.report.childEnvironment, false);
			assert.equal("CAVEMEM_NO_AUTOSTART" in fixture.report.childEnvironment, false);
			assert.equal("PI_SUBAGENT_UNDECLARED" in fixture.report.childEnvironment, false);
			assert.equal("UNDECLARED_HOST_VALUE" in fixture.report.childEnvironment, false);
		}
		assert.equal(fixtures[0].report.redactionMode, "personal");
		assert.equal(fixtures[1].report.redactionMode, "shopify-gateway");
		assert.equal(fixtures[2].report.redactionMode, "shopify-gateway");
		assert.notEqual(
			fixtures[1].report.environment.CAVEMEM_DATA_DIR,
			fixtures[2].report.environment.CAVEMEM_DATA_DIR,
		);
		assertValueFree(fixtures[1].result, Object.values(childA));
		assertValueFree(fixtures[2].result, Object.values(childB));
		assertTreeValueFree(fixtures[1].root, Object.values(childA));
		assertTreeValueFree(fixtures[2].root, Object.values(childB));
	} finally {
		for (const fixture of fixtures) fs.rmSync(fixture.root, { recursive: true, force: true });
	}
});

test("direct pi --version remains 0.83.0 when CAVEMEM_DATA_DIR is absent", () => {
	const result = run(path.join(buildPi(), "bin/pi"), ["--version"], {
		env: managedEnvironment({ CAVEMEM_DATA_DIR: undefined }),
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout.trim(), expectedVersion);
});
