import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const overlayPath = path.join(repoRoot, "overlays/pi-agent/default.nix");
const patchPath = path.join(repoRoot, "overlays/pi-agent/pi-launch-redaction-bootstrap.patch");
const fixtureRoot = path.join(repoRoot, "tests/pi-agent/fixtures/pi-bootstrap");
const extensionPath = path.join(fixtureRoot, "probe-extension.ts");
const runtimeProbePath = path.join(fixtureRoot, "runtime-probe.mjs");
const loaderProbePath = path.join(fixtureRoot, "loader-probe.mjs");
const expectedVersion = "0.83.0";
const expectedNpmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
const duplicateError = "Pi runtime bootstrap is already installed";
const partialError =
	"Pi runtime bootstrap requires both SHOPIFY_PI_TOKEN and PI_AGENT_LAUNCH_ID";
const tokenError =
	"Pi runtime bootstrap requires SHOPIFY_PI_TOKEN to contain 1 through 16384 UTF-8 bytes";
const launchIdError =
	"Pi runtime bootstrap requires PI_AGENT_LAUNCH_ID to be a canonical lowercase RFC 4122 v4 UUID";
const serializationError = "Pi runtime bootstrap is not serializable";
const inputError = "Pi runtime bootstrap redaction input must be a string";
const environmentError =
	"Pi runtime bootstrap environment properties must be own string data properties";
const loaderToken = "task27-loader-123e4567-e89b-42d3-a456-426614174000-token";
const loaderLaunchId = "123e4567-e89b-42d3-a456-426614174000";
const childA = {
	token: "task27-child-a-token",
	launchId: "123e4567-e89b-42d3-8456-426614174001",
};
const childB = {
	token: "task27-child-b-token",
	launchId: "223e4567-e89b-42d3-b456-426614174000",
};
const commandOptions = {
	cwd: repoRoot,
	encoding: "utf8",
	stdio: ["ignore", "pipe", "pipe"],
	timeout: 1_200_000,
};

let builtPiPath;

function filteredFlakeExpression(body) {
	return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-bootstrap-tests";
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

function assertCapabilityReport(report, mode) {
	assert.equal(report.ok, true);
	assert.equal(report.schemaVersion, 1);
	assert.equal(report.mode, mode);
	assert.equal(report.globalDescriptorLocked, true);
	assert.equal(report.capabilityFrozen, true);
	assert.equal(report.redactorFrozen, true);
	assert.deepEqual(report.ownKeys, ["schemaVersion", "mode", "redactExact", "toJSON"]);
	assert.equal(report.noRawCollection, true);
	assert.equal(report.redactsExpected, true);
	assert.equal(report.capturedValuesAbsent, true);
	assert.equal(report.mutationIgnored, true);
	assert.equal(report.outputIsString, true);
	assert.equal(report.serializationError, serializationError);
	assert.equal(report.nestedSerializationError, serializationError);
	assert.equal(report.structuredCloneRejected, true);
	assert.equal(report.hostileInputError, inputError);
	assert.equal(report.accessorTouched, false);
	assert.equal(report.intrinsicsCaptured, true);
	assert.equal(report.environmentAccessorTouched, false);
}

function runDirectFixture(scenario, provider = {}) {
	const piRoot = buildPi();
	const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "pi-bootstrap-direct-"));
	const cwd = path.join(root, "workspace");
	const home = path.join(root, "home");
	const agentDir = path.join(root, "agent");
	const output = path.join(root, "probe.json");
	for (const directory of [cwd, home, agentDir]) fs.mkdirSync(directory, { recursive: true });
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
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				PI_BOOTSTRAP_FIXTURE_OUTPUT: output,
				PI_BOOTSTRAP_FIXTURE_SCENARIO: scenario,
				SHOPIFY_PI_TOKEN: provider.token,
				PI_AGENT_LAUNCH_ID: provider.launchId,
			}),
		},
	);
	assert.equal(result.status, 0, result.stderr);
	assert.equal(fs.existsSync(output), true, "direct Pi did not load the bootstrap probe through Jiti");
	return { root, output, report: JSON.parse(fs.readFileSync(output, "utf8")), result };
}

test("the loader-stable bootstrap patch is unconditionally composed with provenance", () => {
	const overlay = fs.readFileSync(overlayPath, "utf8");
	const patch = fs.readFileSync(patchPath, "utf8");
	const changedFiles = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(
		([, before, after]) => {
			assert.equal(before, after);
			return before;
		},
	);

	assert.deepEqual(changedFiles, [
		"packages/coding-agent/src/cli.ts",
		"packages/coding-agent/src/runtime-bootstrap.ts",
	]);
	assert.match(patch, /^Task: pi-agent-integration 2\.7$/m);
	assert.match(patch, /^Backport-base: https:\/\/github\.com\/earendil-works\/pi\/tree\/v0\.83\.0$/m);
	assert.match(patch, /^License: MIT /m);
	assert.doesNotMatch(overlay, /piRuntimeBootstrapEnabled/);
	assert.doesNotMatch(`${overlay}\n${patch}`, /PI_RUNTIME_BOOTSTRAP_ENABLED|TODO.*bootstrap/i);
	const added = patch
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.join("\n");
	assert.doesNotMatch(added, /NODE_OPTIONS|node:fs|writeFile|readFile|createReadStream|process\.stdin/);
	assert.doesNotMatch(added, /containsExact\(redacted\)/);
	assert.equal((added.match(/redactWithMarker\(value,/g) ?? []).length, 1);
});

test("Pi package keeps its pin, lock, hashes, and generated executable topology", () => {
	const metadata = nixEvalJson(
		filteredFlakeExpression(`
      let
        package = flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent;
        upstream = flake.inputs.pi-nix.packages.aarch64-darwin.coding-agent;
      in
      {
        inherit (package) version npmDepsHash;
        npmDepsOutputHash = package.npmDeps.outputHash;
        npmDepsRebuilt = package.npmDeps.drvPath != upstream.npmDeps.drvPath;
        sourceMatches = package.src == upstream.src;
        patches = map (entry: builtins.baseNameOf (toString entry)) package.patches;
        postPatch = package.postPatch;
      }
    `),
	);
	assert.equal(metadata.version, expectedVersion);
	assert.equal(metadata.sourceMatches, true);
	assert.equal(metadata.npmDepsHash, expectedNpmDepsHash);
	assert.equal(metadata.npmDepsOutputHash, expectedNpmDepsHash);
	assert.equal(metadata.npmDepsRebuilt, true);
	assert.equal(metadata.patches.filter((name) => name === path.basename(patchPath)).length, 1);
	assert.match(metadata.postPatch, /-pi-package-lock\.json/);

	const piRoot = buildPi();
	assert.deepEqual(fs.readdirSync(path.join(piRoot, "bin")), ["pi"]);
	assertTreeValueFree(piRoot, [
		loaderToken,
		loaderLaunchId,
		childA.token,
		childA.launchId,
		childB.token,
		childB.launchId,
	]);
	const wrapper = fs.readFileSync(path.join(piRoot, "bin/pi"), "utf8");
	assert.equal((wrapper.match(/dist\/cli\.js/g) ?? []).length, 1);
	assert.doesNotMatch(wrapper, /runtime-bootstrap|SHOPIFY_PI_TOKEN|PI_AGENT_LAUNCH_ID|NODE_OPTIONS/);
	assert.equal(fs.existsSync(runtimeModulePath()), true);
	const cli = fs.readFileSync(
		path.join(piRoot, "lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
		"utf8",
	);
	assert.match(cli, /import "\.\/runtime-bootstrap\.js";/);
	assert.match(cli, /await import\("\.\/config\.js"\)/);
	assert.ok(cli.indexOf("configureHttpDispatcher();") < cli.indexOf("main(process.argv.slice(2));"));
});

test("personal and Shopify imports install immutable environment snapshots", () => {
	const personal = runRuntimeProbe("inspect");
	assertCapabilityReport(personal.report, "personal");

	const shopify = runRuntimeProbe("intrinsics", {
		SHOPIFY_PI_TOKEN: loaderToken,
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assertCapabilityReport(shopify.report, "shopify-gateway");
	assertValueFree(shopify.result, [loaderToken, loaderLaunchId]);
});

test("managed provider inputs fail closed with bounded value-free diagnostics", () => {
	const oversizedToken = "é".repeat(8193);
	const cases = [
		[{ SHOPIFY_PI_TOKEN: "task27-partial-token" }, partialError, ["task27-partial-token"]],
		[{ PI_AGENT_LAUNCH_ID: loaderLaunchId }, partialError, [loaderLaunchId]],
		[
			{ SHOPIFY_PI_TOKEN: "", PI_AGENT_LAUNCH_ID: loaderLaunchId },
			tokenError,
			[loaderLaunchId],
		],
		[
			{ SHOPIFY_PI_TOKEN: oversizedToken, PI_AGENT_LAUNCH_ID: loaderLaunchId },
			tokenError,
			[oversizedToken, loaderLaunchId],
		],
		[
			{ SHOPIFY_PI_TOKEN: loaderToken, PI_AGENT_LAUNCH_ID: loaderLaunchId.toUpperCase() },
			launchIdError,
			[loaderToken, loaderLaunchId.toUpperCase()],
		],
		[
			{ SHOPIFY_PI_TOKEN: loaderToken, PI_AGENT_LAUNCH_ID: "123e4567-e89b-52d3-a456-426614174000" },
			launchIdError,
			[loaderToken, "123e4567-e89b-52d3-a456-426614174000"],
		],
	];

	for (const [environment, expectedError, values] of cases) {
		const { report, result } = runRuntimeProbe("inspect", environment);
		assert.equal(report.ok, false);
		assert.equal(report.message, expectedError);
		assertValueFree(result, values);
	}

	const exactBoundary = runRuntimeProbe("inspect", {
		SHOPIFY_PI_TOKEN: "é".repeat(8192),
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assertCapabilityReport(exactBoundary.report, "shopify-gateway");

	const markerCollision = runRuntimeProbe("inspect", {
		SHOPIFY_PI_TOKEN: "[REDACTED]",
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assert.equal(markerCollision.report.ok, true);
	assert.equal(markerCollision.report.capturedValuesAbsent, true);
	assertValueFree(markerCollision.result, [loaderLaunchId]);
});

test("every adversarial exact value is absent after one original-input replacement pass", () => {
	const markerTokens = [
		"REDACTED",
		"[REDACTED]",
		"[REDACTED:",
		"[REDACTED:\ue000]",
		`[REDACTED:${loaderLaunchId}]`,
		"[",
		"]",
		"R",
		":",
		"\ue000",
		`[${Array.from({ length: 5461 }, (_, index) => String.fromCharCode(0xe000 + index)).join("")}`,
	];

	for (const token of markerTokens) {
		const { report } = runRuntimeProbe("inspect", {
			SHOPIFY_PI_TOKEN: token,
			PI_AGENT_LAUNCH_ID: loaderLaunchId,
		});
		assert.equal(report.ok, true, `bootstrap rejected marker token ${JSON.stringify(token)}`);
		assert.equal(report.capturedValuesAbsent, true, `bootstrap retained marker token ${JSON.stringify(token)}`);
		assert.equal(report.outputIsString, true);
	}

	const overlap = runRuntimeProbe("inspect", {
		SHOPIFY_PI_TOKEN: `prefix-${loaderLaunchId}-suffix`,
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assert.equal(overlap.report.capturedValuesAbsent, true);
	assertValueFree(overlap.result, [loaderLaunchId]);
});

test("environment mode snapshots only own string data properties without invoking accessors", () => {
	for (const operation of ["inherited-data", "inherited-getter"]) {
		const { report, result } = runRuntimeProbe(operation);
		assertCapabilityReport(report, "personal");
		assert.equal(report.environmentAccessorTouched, false);
		assertValueFree(result, ["task27-descriptor-token", "523e4567-e89b-42d3-8456-426614174000"]);
	}

	for (const operation of ["own-getter", "own-nonstring"]) {
		const { report, result } = runRuntimeProbe(operation);
		assert.equal(report.ok, false);
		assert.equal(report.message, environmentError);
		assert.equal(report.environmentAccessorTouched, false);
		assertValueFree(result, [
			"task27-own-getter-value",
			"task27-own-nonstring-value",
			"523e4567-e89b-42d3-8456-426614174000",
		]);
	}

	const snapshot = runRuntimeProbe("inspect", {
		SHOPIFY_PI_TOKEN: loaderToken,
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assert.equal(snapshot.report.mutationIgnored, true);
});

test("duplicate and preclaimed symbols fail without invoking values or accessors", () => {
	const duplicate = runRuntimeProbe("duplicate", {
		SHOPIFY_PI_TOKEN: loaderToken,
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assert.equal(duplicate.report.ok, true);
	assert.equal(duplicate.report.duplicateError, duplicateError);
	assertValueFree(duplicate.result, [loaderToken, loaderLaunchId]);

	const preclaimed = runRuntimeProbe("preclaim", {
		SHOPIFY_PI_TOKEN: loaderToken,
		PI_AGENT_LAUNCH_ID: loaderLaunchId,
	});
	assert.equal(preclaimed.report.ok, false);
	assert.equal(preclaimed.report.message, duplicateError);
	assert.equal(preclaimed.report.preclaimAccessorTouched, false);
	assertValueFree(preclaimed.result, [loaderToken, loaderLaunchId]);
});

test("real DefaultResourceLoader Jiti reloads reuse the process capability", () => {
	const result = run(
		process.execPath,
		[loaderProbePath, buildPi(), extensionPath],
		{
			env: managedEnvironment({
				SHOPIFY_PI_TOKEN: loaderToken,
				PI_AGENT_LAUNCH_ID: loaderLaunchId,
				PI_BOOTSTRAP_FIXTURE_SCENARIO: "loader",
			}),
		},
	);
	assert.equal(result.status, 0, result.stderr);
	const report = JSON.parse(result.stdout);
	assert.deepEqual(report.firstErrors, []);
	assert.deepEqual(report.secondErrors, []);
	assert.equal(report.loads, 2);
	assert.equal(report.sameCapability, true);
	assert.equal(report.matchesInstalled, true);
	assert.equal(report.records.length, 2);
	for (const record of report.records) {
		assert.equal(record.mode, "shopify-gateway");
		assert.equal(record.redactsExpected, true);
		assert.equal(record.preservesOther, true);
		assert.equal(record.serializationError, serializationError);
		assert.equal(record.hostileInputError, inputError);
	}
	assertValueFree(result, [loaderToken, loaderLaunchId, childB.token, childB.launchId]);
});

test("direct personal and foreground child Pi processes install isolated capabilities", () => {
	const personal = runDirectFixture("personal");
	assert.equal(personal.report.mode, "personal");
	assert.equal(personal.report.redactsExpected, true);
	assert.equal(personal.report.preservesOther, true);

	const firstChild = runDirectFixture("child-a", childA);
	const secondChild = runDirectFixture("child-b", childB);
	for (const fixture of [firstChild, secondChild]) {
		assert.equal(fixture.report.mode, "shopify-gateway");
		assert.equal(fixture.report.redactsExpected, true);
		assert.equal(fixture.report.preservesOther, true);
		assert.equal(fixture.report.serializationError, serializationError);
		assert.equal(fixture.report.accessorTouched, false);
	}
	assertValueFree(firstChild.result, Object.values(childA));
	assertValueFree(secondChild.result, Object.values(childB));
	assertTreeValueFree(firstChild.root, Object.values(childA));
	assertTreeValueFree(secondChild.root, Object.values(childB));
	for (const fixture of [personal, firstChild, secondChild]) {
		const bytes = fs.readFileSync(fixture.output, "utf8");
		assert.equal(bytes.includes("task27-child-a-token"), false);
		assert.equal(bytes.includes("task27-child-b-token"), false);
		assert.equal(bytes.includes(childA.launchId), false);
		assert.equal(bytes.includes(childB.launchId), false);
	}
});

test("the existing direct executable reports 0.83.0 and rejects partial input before Pi", () => {
	const pi = path.join(buildPi(), "bin/pi");
	const version = run(pi, ["--version"], {
		env: managedEnvironment({
			SHOPIFY_PI_TOKEN: childA.token,
			PI_AGENT_LAUNCH_ID: childA.launchId,
		}),
	});
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), expectedVersion);
	assertValueFree(version, Object.values(childA));

	const partial = run(pi, ["--version"], {
		env: managedEnvironment({ SHOPIFY_PI_TOKEN: childA.token }),
	});
	assert.notEqual(partial.status, 0);
	assert.match(partial.stderr, new RegExp(partialError));
	assertValueFree(partial, [childA.token]);
});
