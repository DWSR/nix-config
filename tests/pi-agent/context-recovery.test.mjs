import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedVersion = "0.83.0";
const expectedNpmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
const upstreamCommit = "32850ef7c5edff7a6eee0214516fbb7382bf292d";
const upstreamParent = "e56893f4cd6545ab1498b72ae4e1e2241a0926f4";
const overlayPath = path.join(repoRoot, "overlays/pi-agent/default.nix");
const patchPath = path.join(repoRoot, "overlays/pi-agent/pi-context-recovery.patch");
const upstreamTests = [
  "packages/ai/test/openai-responses-terminal-event.test.ts",
  "packages/ai/test/overflow.test.ts",
  "packages/coding-agent/test/assistant-message.test.ts",
  "packages/coding-agent/test/suite/agent-session-compaction.test.ts",
];
const terminalBaselineTests = [
  "packages/coding-agent/test/suite/agent-session-retry-events.test.ts",
];
const patchedFiles = [
  "packages/ai/src/api/azure-openai-responses.ts",
  "packages/ai/src/api/openai-responses-shared.ts",
  "packages/ai/src/api/openai-responses.ts",
  "packages/ai/src/utils/overflow.ts",
  ...upstreamTests,
  "packages/coding-agent/src/core/agent-session.ts",
  "packages/coding-agent/src/modes/interactive/components/assistant-message.ts",
].sort();
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 1_200_000,
};

function command(commandName, args) {
  try {
    return childProcess.execFileSync(commandName, args, commandOptions).trim();
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${commandName} failed: ${detail || error.message}`);
  }
}

function flakeExpression(body) {
  return `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    in
      ${body}
  `;
}

function nixEvalJson(expression) {
  return JSON.parse(command("nix", ["eval", "--json", "--impure", "--expr", expression]));
}

function nixBuild(expression) {
  const outputs = command("nix", [
    "build",
    "--no-link",
    "--print-out-paths",
    "--impure",
    "--expr",
    expression,
  ]).split("\n");

  assert.equal(outputs.length, 1);
  return outputs[0];
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

test("the complete upstream context-recovery patch carries source and test provenance", () => {
  const overlay = fs.readFileSync(overlayPath, "utf8");
  const patch = fs.readFileSync(patchPath, "utf8");
  const changedFiles = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
    .map(([, before, after]) => {
      assert.equal(before, after);
      return before;
    })
    .sort();

  assert.deepEqual(changedFiles, patchedFiles);
  assert.match(patch, new RegExp(`^From ${upstreamCommit} `));
  assert.match(patch, new RegExp(`Backport-of: https://github\\.com/earendil-works/pi/commit/${upstreamCommit}`));
  assert.match(patch, new RegExp(`Upstream-parent: ${upstreamParent}`));
  assert.match(patch, /^Backport-base: https:\/\/github\.com\/earendil-works\/pi\/tree\/v0\.83\.0$/m);
  assert.match(patch, /^License: MIT /m);
  assert.match(patch, /isRecoverableLength\(assistantMessage, this\.model\?\.maxTokens \?\? 0\)/);
  assert.match(patch, /lastMsg\.stopReason === "error" \|\| lastMsg\.stopReason === "length"/);
  assert.match(patch, /getLastAssistantText\(\)\)\.toBe\("completed response"\)/);
  assert.doesNotMatch(overlay, /contextRecoveryEnabled|PI_CONTEXT_RECOVERY/);
});

test("Pi 0.83.0 composes context recovery after the rebuilt Undici dependency closure", () => {
  const metadata = nixEvalJson(
    flakeExpression(`
      let
        package = flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent;
        upstream = flake.inputs.pi-nix.packages.aarch64-darwin.coding-agent;
      in
      {
        inherit (package) version npmDepsHash;
        npmDepsOutputHash = package.npmDeps.outputHash;
        npmDepsRebuilt = package.npmDeps.drvPath != upstream.npmDeps.drvPath;
        sourceMatches = package.src == upstream.src;
        patches = map (patch: builtins.unsafeDiscardStringContext (toString patch)) package.patches;
        test = builtins.unsafeDiscardStringContext (toString package.passthru.tests."context-recovery");
      }
    `),
  );

  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.sourceMatches, true);
  assert.equal(metadata.npmDepsHash, expectedNpmDepsHash);
  assert.equal(metadata.npmDepsOutputHash, expectedNpmDepsHash);
  assert.equal(metadata.npmDepsRebuilt, true);
  assert.equal(metadata.patches.filter((entry) => /\/pi-undici-8\.9\.0\.patch$/.test(entry)).length, 1);
  assert.equal(metadata.patches.filter((entry) => /\/pi-context-recovery\.patch$/.test(entry)).length, 1);
  assert.match(metadata.test, /pi-agent-context-recovery-tests-0\.83\.0/);
});

test("focused upstream tests compact, resume, and preserve terminal semantics", () => {
  const output = nixBuild(
    flakeExpression(`flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent.passthru.tests."context-recovery"`),
  );
  assert.deepEqual(fs.readdirSync(output), ["manifest.json"]);
  const manifest = JSON.parse(fs.readFileSync(path.join(output, "manifest.json"), "utf8"));
  const { summary, tests, ...metadata } = manifest;

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    piVersion: expectedVersion,
    upstreamCommit,
    upstreamParent,
    upstreamTests,
    terminalBaselineTests,
  });
  assert.deepEqual(summary, { failed: 0, files: 5, passed: 67, total: 67 });
  assert.equal(tests.length, summary.total);
  assert.ok(tests.every((entry) => entry.status === "pass"));
  assert.ok(tests.every((entry) => Object.keys(entry).join(",") === "id,status"));

  const identifiers = tests.map(({ id }) => id);
  assert.deepEqual(identifiers, [...identifiers].sort(compareText));
  assert.equal(new Set(identifiers).size, identifiers.length);
  assert.deepEqual(
    [...new Set(identifiers.map((id) => id.slice(0, id.indexOf(" > "))))].sort(compareText),
    [...upstreamTests, ...terminalBaselineTests].sort(compareText),
  );
  assert.ok(identifiers.every((id) => !/\/(?:nix|private|var)\//.test(id)));

  for (const expected of [
    "finalizes completed terminal events as stop",
    "rejects failed terminal events with the provider error",
    "finalizes content-filtered incomplete responses as non-retryable errors",
    "compacts and resumes after a length stop below the desired output limit",
    "does not compact when a length stop reaches the desired output limit",
    "stops after one compact-and-retry when a second response is also truncated",
    "emits agent_end for aborted runs and persists the aborted assistant message",
  ]) {
    assert.ok(identifiers.some((id) => id.endsWith(` > ${expected}`)), `missing focused result: ${expected}`);
  }
});
