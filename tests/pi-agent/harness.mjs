import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(testsDir, "fixtures");
const repoRoot = path.resolve(testsDir, "../..");
const gateStatuses = new Set(["pass", "fail", "manual-required"]);
const hostFixturePaths = {
  personal: "tests/pi-agent/fixtures/personal-host.nix",
  shopify: "tests/pi-agent/fixtures/shopify-host.nix",
};
const expectedShopifyRoles = ["anthropic", "openai", "google", "groq", "xai"];
const expectedExtensionOrder = [
  "agentmemory",
  "mcp",
  "subagents",
  "plan",
  "timestamps",
  "bashTimeout",
  "questions",
  "codeIntelligence",
  "backgroundTasks",
];
const declaredProviderDeltaCommands = new Set([
  "launcher",
  "status",
  "validator",
  "managed",
  "managedStatus",
  "managedValidator",
]);
const privateSourcePatterns = [
  /github\.shopify\.(?:com|net)/i,
  /(?:^|[\/'" ])(?:shopify|shop-pi-fy)[-_](?:private|internal|source)(?:[\/'" ]|$)/i,
  /@shopify\/(?:private|internal)(?:[\/'" ]|$)/i,
];
const mutableSourcePatterns = [
  /\b(?:source|resolved|fetch|download|tarball|archive)\b\s*=\s*["'`]?https?:\/\/[^\s"'`]+\/(?:main|master|develop|trunk|latest)(?:[/?#\s"'`]|$)/i,
  /\b(?:source|resolved|fetch|download|tarball|archive)\b\s*=\s*["'`]?https?:\/\/[^\s"'`]+\/refs\/heads\//i,
];
const literalSecretPatterns = [
  /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----(?:\\n|\r?\n)[A-Za-z0-9+/=]{32,}(?:\\n|\r?\n)-----END (?:[A-Z]+ )?PRIVATE KEY-----/,
  /\b(?:sk-[A-Za-z0-9]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /\bBearer\s+[A-Za-z0-9._~-]{24,}\b/,
];
const knownPublicFixturePaths = [/\/node_modules\/ssh2\/test\/fixtures\//];
const credentialSentinels = [
  "resolved-token",
  "resolved-launch-id",
  "task-6-5-token-sentinel",
  "task-6-5-launch-id-sentinel",
];

export const PROBE_NAMES = Object.freeze([
  "pi",
  "provider",
  "mcpproxy",
  "agentmemory",
  "nono",
  "language-server",
  "subprocess",
]);

function requireFixtureName(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid fixture name: ${name}`);
  }
}

function makeWritable(target) {
  const stat = fs.lstatSync(target);

  if (stat.isSymbolicLink()) {
    return;
  }

  fs.chmodSync(target, stat.mode | (stat.isDirectory() ? 0o700 : 0o600));
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      makeWritable(path.join(target, entry));
    }
  }
}

export async function withFixtureWorkspace(name, operation) {
  requireFixtureName(name);
  if (typeof operation !== "function") {
    throw new TypeError("fixture operation must be a function");
  }

  const source = path.join(fixturesDir, "workspaces", name);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-fixture-"));
  const workspace = path.join(root, name);

  try {
    fs.cpSync(source, workspace, {
      recursive: true,
      errorOnExist: true,
    });
    makeWritable(workspace);
    return await operation(workspace);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function runProbe(name, options = {}) {
  if (!PROBE_NAMES.includes(name)) {
    throw new Error(`unknown fixture probe: ${name}`);
  }

  const argv = options.argv ?? [];
  const environment = options.environment ?? {};
  if (!Array.isArray(argv) || !argv.every((argument) => typeof argument === "string")) {
    throw new TypeError("probe argv must contain only strings");
  }
  if (
    environment === null ||
    Array.isArray(environment) ||
    typeof environment !== "object" ||
    !Object.values(environment).every((value) => typeof value === "string")
  ) {
    throw new TypeError("probe environment values must be strings");
  }

  const capturedNames = Object.keys(environment).sort();
  const probe = path.join(fixturesDir, "probes", `${name}.mjs`);
  const result = childProcess.spawnSync(process.execPath, [probe, ...argv], {
    cwd: testsDir,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME ?? os.tmpdir(),
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "",
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      ...environment,
      PI_AGENT_PROBE_ENV_NAMES: capturedNames.join(","),
    },
    input: `${JSON.stringify(options.request ?? null)}\n`,
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} probe exited ${result.status}: ${result.stderr.trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${name} probe emitted invalid JSON: ${error.message}`);
  }
}

export function createValidationReport(generation, gates) {
  if (typeof generation !== "string" || generation.length === 0) {
    throw new Error("validation generation must be a non-empty string");
  }
  if (!Array.isArray(gates)) {
    throw new TypeError("validation gates must be an array");
  }

  const names = new Set();
  const normalizedGates = gates.map((gate) => {
    if (gate === null || typeof gate !== "object" || Array.isArray(gate)) {
      throw new TypeError("validation gate must be an object");
    }
    if (typeof gate.name !== "string" || gate.name.length === 0) {
      throw new Error("validation gate name must be a non-empty string");
    }
    if (names.has(gate.name)) {
      throw new Error(`duplicate validation gate: ${gate.name}`);
    }
    names.add(gate.name);

    if (!gateStatuses.has(gate.status)) {
      throw new Error(`invalid gate status: ${gate.status}`);
    }
    if (
      !Array.isArray(gate.evidence) ||
      gate.evidence.length === 0 ||
      !gate.evidence.every((entry) => typeof entry === "string" && entry.length > 0)
    ) {
      throw new Error(`gate evidence must be non-empty strings: ${gate.name}`);
    }

    return {
      name: gate.name,
      status: gate.status,
      evidence: [...gate.evidence],
    };
  });

  return {
    generation,
    gates: normalizedGates,
  };
}

export function assertNoFailedGates(report) {
  const failed = report.gates.filter((gate) => gate.status === "fail").map((gate) => gate.name);

  if (failed.length > 0) {
    throw new Error(`failed gates: ${failed.join(", ")}`);
  }
}

function fixtureExpression(fixturePath, fixture, sourceName, projection = null) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = ${JSON.stringify(sourceName)};
        filter = sourcePath: type: builtins.baseNameOf sourcePath != ".git";
      };
      fixtureValue = import (repoSource + "/${fixturePath}") {
        repoRoot = repoSource;
        fixture = ${JSON.stringify(fixture)};
      };
    in ${projection === null ? "fixtureValue" : `fixtureValue.${JSON.stringify(projection)}`}
  `;
}

function evaluateFixture(fixturePath, fixture, sourceName) {
  const result = childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixturePath, fixture, sourceName)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`fixture ${fixture} failed: ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`fixture ${fixture} emitted invalid JSON: ${error.message}`);
  }
}

function buildFixtureOutput(fixturePath, fixture, sourceName, outputName) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression(fixturePath, fixture, sourceName, outputName),
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`fixture ${fixture} build failed: ${result.stderr.trim()}`);
  return result.stdout.trim();
}

function evaluateExpectedFailure(fixturePath, fixture, sourceName, diagnostic) {
  const result = childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixturePath, fixture, sourceName)],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );
  if (result.error) {
    throw result.error;
  }
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated`);
  assert.match(`${result.stderr}\n${result.stdout}`, diagnostic);
}

function instructionHashes(host) {
  return Object.fromEntries(
    host.instructionResources
      .map((resource) => {
        realizeStorePath(resource);
        return [path.basename(resource), crypto.createHash("sha256").update(fs.readFileSync(resource)).digest("hex")];
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function assertHostRender(host, mode) {
  assert.equal(host.enable, true);
  assert.equal(host.packageVersion, "0.83.0");
  assert.match(host.package, /^\/nix\/store\//);
  assert.deepEqual(Object.keys(host.profilePaths).sort(), ["pi-audit", "pi-managed", "pi-review"]);
  assert.deepEqual(Object.keys(host.extensionRefs).sort(), [...expectedExtensionOrder].sort());
  assert.deepEqual(host.commands, ["pi", "pi-agent-status", "pi-agent-validate", "pi-agent-reconcile"]);
  assert.ok(Object.values(host.commandPackages).every((value) => /^\/nix\/store\//.test(value)));
  assert.match(host.guidancePackage, /^\/nix\/store\//);
  assert.ok(host.instructionResources.every((value) => /^\/nix\/store\//.test(value)));
  assert.equal(host.provider.mode, mode);
}

function commandPackageName(value) {
  return path.basename(value).replace(/^[^-]+-/, "").replace(/-(?:personal|shopify-gateway)$/, "");
}

function isWithinPath(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveAllowedSymlink(root, boundaryRoot) {
  const resolved = fs.realpathSync(root);
  if (!resolved.startsWith("/nix/store/") && !isWithinPath(resolved, boundaryRoot)) {
    throw new Error(`unsafe symlink in publishable closure: ${path.basename(root)}`);
  }
  return resolved;
}

function walkIdentityFiles(root, files = [], seen = new Set(), boundaryRoot = null) {
  const stat = fs.lstatSync(root);
  const resolvedRoot = stat.isSymbolicLink() ? resolveAllowedSymlink(root, boundaryRoot ?? path.dirname(root)) : root;
  const effectiveBoundary = boundaryRoot ?? fs.realpathSync(stat.isDirectory() ? root : path.dirname(root));
  if (stat.isSymbolicLink()) {
    return walkIdentityFiles(resolvedRoot, files, seen, effectiveBoundary);
  }
  const identity = fs.realpathSync(resolvedRoot);
  if (seen.has(identity)) return files;
  seen.add(identity);

  if (stat.isFile()) {
    files.push(root);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of fs.readdirSync(root).sort()) {
    walkIdentityFiles(path.join(root, entry), files, seen, effectiveBoundary);
  }
  return files;
}

function canonicalizeJson(value) {
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeJson(child)]),
    );
  }
  return value;
}

function normalizeProviderDeltaContent(content, relativePath) {
  let normalized = content
    .replace(/\/nix\/store\/[a-z0-9]{32}-(?=[^/\s"']+)/g, "/nix/store/<store>-")
    .replace(/\/tmp\/pi-agent-(?:personal|shopify)-host/g, "/tmp/pi-agent-host");

  if (relativePath === "share/pi-agent/managed-config.json") {
    const managedConfig = JSON.parse(normalized);
    managedConfig.providerSelection = "<provider-selection>";
    managedConfig.instructionResources = managedConfig.instructionResources
      .filter((resource) => !resource.endsWith("/shopify.md"))
      .map((resource) => resource.replace(/\/nix\/store\/[^/]+\/share\/pi-agent\/(instructions|guide)\.md$/, "/nix/store/<host-instructions>/share/pi-agent/$1.md"));
    normalized = JSON.stringify(canonicalizeJson(managedConfig));
  }

  return normalized
    .replace(/const PROVIDER_HANDOFF_MODULE = .*;/, 'const PROVIDER_HANDOFF_MODULE = "<provider-handoff>";')
    .replace(/const MANAGED_CONFIG_DIGEST = ".*";/, 'const MANAGED_CONFIG_DIGEST = "<managed-config-digest>";')
    .replace(/const EXPECTED_PROVIDER_MODE = ".*";/, 'const EXPECTED_PROVIDER_MODE = "<provider-mode>";');
}

function commandPackageIdentity(value, commandName) {
  realizeStorePath(value);
  const hash = crypto.createHash("sha256");
  for (const file of walkIdentityFiles(value)) {
    const stat = fs.lstatSync(file);
    const relativePath = path.relative(value, file);
    const rawContent = fs.readFileSync(file);
    const content = declaredProviderDeltaCommands.has(commandName)
      ? normalizeProviderDeltaContent(rawContent.toString("utf8"), relativePath)
      : rawContent;
    hash.update(relativePath);
    hash.update(String(stat.mode));
    hash.update(content);
  }
  return {
    name: commandPackageName(value),
    content: hash.digest("hex"),
  };
}

export function assertCommandPackageIdentity(personalPackages, shopifyPackages) {
  assert.deepEqual(Object.keys(personalPackages).sort(), Object.keys(shopifyPackages).sort());

  for (const name of Object.keys(personalPackages).sort()) {
    const personalIdentity = commandPackageIdentity(personalPackages[name], name);
    const shopifyIdentity = commandPackageIdentity(shopifyPackages[name], name);
    assert.equal(personalIdentity.name, shopifyIdentity.name, `command package name differs: ${name}`);
    assert.equal(personalIdentity.content, shopifyIdentity.content, `command package identity differs: ${name}`);
  }
}

function assertProviderDeltas(personal, shopify) {
  assert.deepEqual(personal.provider, {
    mode: "personal",
    enabledRoles: [],
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(shopify.provider, {
    mode: "shopify-gateway",
    enabledRoles: expectedShopifyRoles,
    defaultModel: { provider: "openai", modelId: "gpt-5.6-sol" },
  });
  assert.deepEqual(personal.resolverPlans, [{ kind: "pi-auth" }]);
  assert.deepEqual(
    shopify.resolverPlans.map(({ kind }) => kind),
    ["shopify-gateway-token", "shopify-gateway-base"],
  );
  assert.equal(personal.providerHandoff, null);
  assert.match(shopify.providerHandoff, /^\/nix\/store\//);
  const personalInstructions = instructionHashes(personal);
  const shopifyInstructions = instructionHashes(shopify);
  assert.deepEqual(Object.keys(personalInstructions).sort(), ["guide.md", "instructions.md"]);
  assert.deepEqual(Object.keys(shopifyInstructions).sort(), ["guide.md", "instructions.md", "shopify.md"]);
  for (const name of ["guide.md", "instructions.md"]) {
    assert.equal(personalInstructions[name], shopifyInstructions[name], `${name} version differs by host`);
  }
}

function collectPublishableRoots(publishableRoots, requiredRoots = []) {
  const roots = new Set();
  for (const publishableRoot of publishableRoots) {
    assert.equal(fs.existsSync(publishableRoot), true, "publishable root was not realized");
    const manifestRoot = path.join(publishableRoot, "roots");
    assert.equal(fs.existsSync(manifestRoot), true, "publishable root manifest is missing");
    const entries = fs.readdirSync(manifestRoot).sort();
    assert.ok(entries.length > 0, "publishable root manifest is empty");
    for (const entry of entries) {
      const declaredRoot = path.join(manifestRoot, entry);
      assert.equal(
        fs.lstatSync(declaredRoot).isSymbolicLink(),
        true,
        `publishable root entry is not a link: ${entry}`,
      );
      const realizedRoot = fs.realpathSync(declaredRoot);
      realizeStorePath(realizedRoot);
      assert.equal(fs.existsSync(realizedRoot), true, `publishable root entry was not realized: ${entry}`);
      roots.add(realizedRoot);
    }
  }

  for (const requiredRoot of requiredRoots.flat()) {
    realizeStorePath(requiredRoot);
    const realizedRoot = fs.realpathSync(requiredRoot);
    assert.equal(
      roots.has(realizedRoot),
      true,
      `publishable artifact is missing from the manifest: ${path.basename(requiredRoot)}`,
    );
  }

  return [...roots].sort();
}

function realizeStorePath(storePath) {
  if (fs.existsSync(storePath)) return storePath;
  const result = childProcess.spawnSync(
    "nix",
    ["build", "--no-link", "--print-out-paths", "--impure", storePath],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`could not realize publishable path: ${result.stderr.trim()}`);
  return storePath;
}

function walkTextFiles(root, files = [], seen = new Set(), boundaryRoot = null) {
  const stat = fs.lstatSync(root);
  const resolvedRoot = stat.isSymbolicLink() ? resolveAllowedSymlink(root, boundaryRoot ?? path.dirname(root)) : root;
  const effectiveBoundary = boundaryRoot ?? fs.realpathSync(stat.isDirectory() ? root : path.dirname(root));
  if (stat.isSymbolicLink()) {
    return walkTextFiles(resolvedRoot, files, seen, effectiveBoundary);
  }
  const identity = fs.realpathSync(resolvedRoot);
  if (seen.has(identity)) return files;
  seen.add(identity);

  if (stat.isFile()) {
    files.push(root);
    return files;
  }
  if (!stat.isDirectory()) return files;
  for (const entry of fs.readdirSync(root).sort()) {
    walkTextFiles(path.join(root, entry), files, seen, effectiveBoundary);
  }
  return files;
}

function closureText(closure) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return closure.flatMap((root) =>
    walkTextFiles(root).flatMap((file) => {
      const bytes = fs.readFileSync(file);
      const executable = (fs.lstatSync(file).mode & 0o111) !== 0;
      if (!executable) {
        try {
          return [{ file, text: decoder.decode(bytes) }];
        } catch {
          return [];
        }
      }
      return [{ file, text: bytes.toString("utf8") }];
    }),
  );
}

function assertNoPatternMatches(files, patterns, label) {
  for (const { file, text } of files) {
    for (const pattern of patterns) {
      assert.equal(pattern.test(text), false, `${label} found in publishable closure: ${file}`);
    }
  }
}

function assertNoCredentialSentinels(files) {
  for (const { text } of files) {
    for (const sentinel of credentialSentinels) {
      assert.equal(text.includes(sentinel), false, "credential sentinel found in publishable closure");
    }
  }
}

function assertNoMutableLockSources(files) {
  for (const { file, text } of files) {
    if (!path.basename(file).endsWith("package-lock.json")) continue;
    const upstreamInstallLock = file.includes("/install-lock/");
    const lock = JSON.parse(text);
    for (const [packagePath, metadata] of Object.entries(lock.packages ?? {})) {
      if (packagePath === "" || metadata.inBundle === true || metadata.resolved === undefined) continue;
      if (/^(?:file:|link:|packages\/|node_modules\/)/.test(metadata.resolved)) continue;
      assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\/.+\.tgz$/, `${path.basename(file)}:${packagePath}`);
      if (!upstreamInstallLock) {
        assert.match(metadata.integrity ?? "", /^sha512-/, `${path.basename(file)}:${packagePath}`);
      }
    }
  }
}

function assertPublishedLicenses(host, closure) {
  const manifest = JSON.parse(fs.readFileSync(host.extensionManifest, "utf8"));
  const extensionRoot = path.dirname(path.dirname(path.dirname(host.extensionManifest)));
  for (const [name, extension] of Object.entries(manifest.extensions)) {
    assert.equal(typeof extension.license, "string");
    assert.ok(extension.license.length > 0, `${name} has no license metadata`);
    assert.equal(
      fs.existsSync(path.join(extensionRoot, "share", "licenses", "pi-agent-extensions", name, "LICENSE")),
      true,
      `${name} license notice is missing from the publishable closure`,
    );
  }
  assert.ok(closure.some((root) => root === extensionRoot || root.startsWith(`${extensionRoot}/`)));
}

export function assertPublishableClosureSafety(publishableRoots, requiredRoots = []) {
  const closure = collectPublishableRoots(publishableRoots, requiredRoots);
  const files = closureText(closure);
  assertNoPatternMatches(files, privateSourcePatterns, "private Shopify source");
  assertNoPatternMatches(files, mutableSourcePatterns, "mutable source URL");
  assertNoMutableLockSources(files);
  assertNoCredentialSentinels(files);
  assertNoPatternMatches(
    files.filter(({ file }) => !knownPublicFixturePaths.some((pattern) => pattern.test(file))),
    literalSecretPatterns,
    "literal secret",
  );
  return { closure, files };
}

export function runCombinedHostGates() {
  const personal = evaluateFixture(hostFixturePaths.personal, "personal", "pi-agent-combined-personal-source");
  const shopify = evaluateFixture(hostFixturePaths.shopify, "shopify", "pi-agent-combined-shopify-source");
  const publishableRoots = [
    buildFixtureOutput(
      hostFixturePaths.personal,
      "personal-publishable",
      "pi-agent-combined-personal-source",
      null,
    ),
    buildFixtureOutput(
      hostFixturePaths.shopify,
      "shopify-publishable",
      "pi-agent-combined-shopify-source",
      null,
    ),
  ];
  assert.ok(publishableRoots.every((root) => fs.existsSync(root)), "publishable host roots were not realized");

  assertHostRender(personal, "personal");
  assertHostRender(shopify, "shopify-gateway");

  assert.equal(personal.package, shopify.package);
  assert.equal(personal.packageVersion, shopify.packageVersion);
  assert.deepEqual(personal.profilePaths, shopify.profilePaths);
  assert.deepEqual(personal.extensionRefs, shopify.extensionRefs);
  assertCommandPackageIdentity(personal.commandPackages, shopify.commandPackages);
  assert.deepEqual(personal.commands, shopify.commands);
  assert.equal(personal.guidancePackage, shopify.guidancePackage);
  assertProviderDeltas(personal, shopify);

  const { closure } = assertPublishableClosureSafety(publishableRoots, [
    personal.publishableArtifacts,
    shopify.publishableArtifacts,
  ]);
  assertPublishedLicenses(personal, closure);
  assertPublishedLicenses(shopify, closure);

  evaluateExpectedFailure(
    "tests/pi-agent/fixtures/managed-config.nix",
    "unsupported-system",
    "pi-agent-combined-unsupported-source",
    /programs\.pi-agent supports only aarch64-darwin; disable programs\.pi-agent\.enable on x86_64-darwin/,
  );

  const report = createValidationReport("pi-agent-acceptance-v1", [
    { name: "host-render-personal", status: "pass", evidence: ["aarch64-darwin", "personal-provider"] },
    { name: "host-render-shopify", status: "pass", evidence: ["aarch64-darwin", "shopify-provider"] },
    {
      name: "host-common-surface",
      status: "pass",
      evidence: ["pi-0.83.0", "profiles:3", `extensions:${expectedExtensionOrder.length}`],
    },
    { name: "host-provider-deltas", status: "pass", evidence: ["personal-openai-auth", "shopify-five-roles", "shopify-addendum"] },
    { name: "static-private-shopify-source", status: "pass", evidence: [`closure-roots:${closure.length}`] },
    { name: "static-mutable-source-urls", status: "pass", evidence: ["pinned-package-locks"] },
    { name: "static-credential-sentinels", status: "pass", evidence: ["secret-free-closures"] },
    { name: "static-literal-secrets", status: "pass", evidence: ["secret-pattern-scan"] },
    { name: "static-licenses", status: "pass", evidence: ["manifest-and-notices"] },
    { name: "unsupported-system", status: "pass", evidence: ["x86_64-darwin", "actionable-error"] },
  ]);
  assertNoFailedGates(report);
  return report;
}

export async function runSmokeFixture() {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixturesDir, "smoke.json"), "utf8"));
  const sourceSeed = path.join(fixturesDir, "workspaces", fixture.workspace, "seed.txt");
  const originalSeed = fs.readFileSync(sourceSeed, "utf8");
  let workspacePath;

  await withFixtureWorkspace(fixture.workspace, async (workspace) => {
    workspacePath = workspace;
    const copiedSeed = path.join(workspace, "seed.txt");

    fs.writeFileSync(copiedSeed, fixture.writableValue);
    if (fs.readFileSync(copiedSeed, "utf8") !== fixture.writableValue) {
      throw new Error("fixture copy is not writable");
    }

    for (const name of PROBE_NAMES) {
      const result = runProbe(name, {
        argv: ["--smoke"],
        request: {
          operation: "smoke",
          payload: name,
        },
      });

      if (result.probe !== name || result.schemaVersion !== 1 || result.response === null) {
        throw new Error(`invalid smoke response from ${name} probe`);
      }
    }
  });

  if (fs.existsSync(workspacePath) || fs.readFileSync(sourceSeed, "utf8") !== originalSeed) {
    throw new Error("fixture workspace was not isolated");
  }

  const report = createValidationReport(fixture.generation, [
    {
      name: "fixture-workspace",
      status: "pass",
      evidence: ["copy-isolated", "copy-writable"],
    },
    {
      name: "fixture-probes",
      status: "pass",
      evidence: PROBE_NAMES,
    },
    fixture.manualGate,
  ]);
  assertNoFailedGates(report);
  return report;
}
