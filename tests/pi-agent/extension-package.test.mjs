import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const extensionRoot = path.join(repoRoot, "overlays/pi-agent/extensions");
const packagePath = path.join(extensionRoot, "package.json");
const lockPath = path.join(extensionRoot, "package-lock.json");
const expectedPiVersion = "0.83.0";
const expectedExtensions = {
  mcp: {
    package: "pi-mcp-adapter",
    version: "2.20.1",
    sourceRef: "1dbdef96",
    entryPath: "lib/node_modules/pi-mcp-adapter/index.ts",
  },
  subagents: {
    package: "pi-subagents",
    version: "0.40.0",
    sourceRef: "d4d2ab70",
    entryPath: "lib/node_modules/pi-subagents/index.ts",
  },
  plan: {
    package: "@narumitw/pi-plan-mode",
    version: "0.49.2",
    sourceRef: "df5f5ce7",
    entryPath: "lib/node_modules/@narumitw/pi-plan-mode/src/index.ts",
  },
  timestamps: {
    package: "@narumitw/pi-stamp",
    version: "0.49.3",
    sourceRef: "4c2c2e8c",
    entryPath: "lib/node_modules/@narumitw/pi-stamp/src/index.ts",
  },
  bashTimeout: {
    package: "@mrclrchtr/supi-bash-timeout",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-bash-timeout/src/extension.ts",
  },
  questions: {
    package: "@mrclrchtr/supi-ask-user",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-ask-user/src/extension.ts",
  },
  codeIntelligence: {
    package: "@mrclrchtr/supi-code-intelligence",
    version: "4.6.0",
    sourceRef: "98b80f6d",
    entryPath: "lib/node_modules/@mrclrchtr/supi-code-intelligence/src/extension.ts",
  },
  backgroundTasks: {
    package: "@99percentpeople/pi-background-tasks",
    version: "2.0.0",
    sourceRef: "0d231ab3",
    entryPath: "lib/node_modules/@99percentpeople/pi-background-tasks/dist/index.ts",
  },
};
const expectedRuntimeDependencies = {
  nodePty: {
    package: "node-pty",
    version: "1.2.0-beta.14",
    entryPath: "lib/node_modules/node-pty/lib/index.js",
  },
};
const expectedPatches = {
  backgroundTasksManagedPipe: {
    file: "pi-background-tasks-managed-pipe.patch",
    package: "@99percentpeople/pi-background-tasks@2.0.0",
    task: "pi-agent-integration 4.10",
  },
  backgroundTasksManagedPty: {
    file: "pi-background-tasks-managed-pty.patch",
    package: "@99percentpeople/pi-background-tasks@2.0.0",
    task: "pi-agent-integration 4.11",
  },
  bashTimeoutManagedDefault: {
    file: "supi-bash-timeout-managed-default.patch",
    package: "@mrclrchtr/supi-bash-timeout@4.6.0",
    task: "pi-agent-integration 4.6",
  },
  planModeCooperativeState: {
    file: "pi-plan-mode-cooperative-state.patch",
    package: "@narumitw/pi-plan-mode@0.49.2",
    task: "pi-agent-integration 4.3",
  },
  structuredQuestions: {
    file: "supi-ask-user-structured-results.patch",
    package: "@mrclrchtr/supi-ask-user@4.6.0",
    task: "pi-agent-integration 4.7",
  },
  codeIntelligenceManagedLsp: {
    file: "supi-code-intelligence-managed-lsp.patch",
    package: "@mrclrchtr/supi-code-intelligence@4.6.0",
    task: "pi-agent-integration 4.8",
  },
};
const expectedBackgroundTypeDiagnostics = [
  "error TS2322: Type '(value: unknown) => void' is not assignable to type '() => void'.",
  "error TS2339: Property 'codePointAt' does not exist on type 'unknown'.",
  "error TS2339: Property 'killWindowsProcessTree' does not exist on type '{}'.",
  "error TS2339: Property 'loadConfig' does not exist on type '{}'.",
  "error TS2339: Property 'ptySpawnProcess' does not exist on type '{}'.",
  "error TS2339: Property 'retainForNextAgentTurn' does not exist on type 'unknown'.",
  "error TS2339: Property 'saveConfig' does not exist on type '{}'.",
  "error TS2339: Property 'spawnProcess' does not exist on type '{}'.",
  "error TS2339: Property 'terminalInput' does not exist on type '{}'.",
  "error TS2339: Property 'terminalOutput' does not exist on type '{}'.",
  ...Array(3).fill("error TS2554: Expected 2 arguments, but got 1."),
  ...Array(3).fill("error TS2554: Expected 3 arguments, but got 2."),
  ...Array(3).fill("error TS2554: Expected 5 arguments, but got 3."),
  "error TS2554: Expected 5 arguments, but got 4.",
  ...Array(3).fill("error TS2794: Expected 1 arguments, but got 0. Did you forget to include 'void' in your type argument to 'Promise'?"),
].sort();
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let builtExtensionPath;
let builtPiPath;

function nixEvalJson(expression) {
  return JSON.parse(
    childProcess.execFileSync(
      "nix",
      ["eval", "--json", "--impure", "--expr", expression],
      commandOptions,
    ),
  );
}

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-extension-tests";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
    in
      ${body}
  `;
}

function buildExtensions() {
  builtExtensionPath ??= childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression("flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent-extensions"),
      ],
      commandOptions,
    )
    .trim();

  assert.match(builtExtensionPath, /^\/nix\/store\//);
  assert.equal(builtExtensionPath.includes("\n"), false);
  return builtExtensionPath;
}

function buildPi() {
  builtPiPath ??= childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression("flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent"),
      ],
      commandOptions,
    )
    .trim();
  assert.match(builtPiPath, /^\/nix\/store\//);
  return builtPiPath;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function packageDirectory(root, packageName) {
  return path.join(root, "lib/node_modules", ...packageName.split("/"));
}

function assertMitText(file, packageName) {
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /Permission is hereby granted, free of charge/,
    `${packageName} license is not the reviewed MIT grant`);
  assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/,
    `${packageName} license is incomplete`);
}

test("extension root pins the reviewed peerless inventory", () => {
  const packageJson = readJson(packagePath);
  const npmConfig = fs.readFileSync(path.join(extensionRoot, ".npmrc"), "utf8");
  const expectedDependencies = Object.fromEntries(
    [...Object.values(expectedExtensions), ...Object.values(expectedRuntimeDependencies)]
      .map(({ package: packageName, version }) => [packageName, version])
      .sort(([left], [right]) => left.localeCompare(right)),
  );

  assert.equal(packageJson.private, true);
  assert.deepEqual(packageJson.dependencies, expectedDependencies);
  assert.equal(packageJson.devDependencies, undefined);
  assert.match(npmConfig, /^legacy-peer-deps=true$/m);
  assert.match(npmConfig, /^audit=false$/m);
  assert.match(npmConfig, /^fund=false$/m);
});

test("extension lock resolves exact immutable registry artifacts without Pi", () => {
  const packageJson = readJson(packagePath);
  const lock = readJson(lockPath);

  assert.equal(lock.lockfileVersion, 3);
  assert.deepEqual(lock.packages[""].dependencies, packageJson.dependencies);

  const piRuntimePaths = [];
  for (const [packageLockPath, metadata] of Object.entries(lock.packages)) {
    if (packageLockPath === "") {
      continue;
    }
    if (/node_modules\/@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(packageLockPath)) {
      piRuntimePaths.push(packageLockPath);
    }
    assert.match(metadata.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,
      `${packageLockPath} has a non-exact version`);
    if (metadata.inBundle === true) {
      continue;
    }
    assert.match(metadata.resolved, /^https:\/\/registry\.npmjs\.org\/.+\.tgz$/,
      `${packageLockPath} uses a mutable or non-registry source`);
    assert.match(metadata.integrity, /^sha512-/,
      `${packageLockPath} lacks registry integrity`);
  }
  assert.deepEqual(piRuntimePaths, []);

  for (const { package: packageName, version } of [
    ...Object.values(expectedExtensions),
    ...Object.values(expectedRuntimeDependencies),
  ]) {
    assert.equal(lock.packages[`node_modules/${packageName}`].version, version);
  }
});

test("Nix publishes deterministic extension entry and provenance metadata", () => {
  const metadata = nixEvalJson(
    filteredFlakeExpression(`
      let
        package = flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent-extensions;
      in
      {
        manifest = builtins.fromJSON (builtins.readFile package.manifest);
        provenance = builtins.fromJSON (builtins.readFile package.provenance);
        typecheckConfig = builtins.fromJSON (
          builtins.unsafeDiscardStringContext (builtins.readFile package.typecheckConfig)
        );
        backgroundTypecheckConfig = builtins.fromJSON (
          builtins.unsafeDiscardStringContext (builtins.readFile package.backgroundTypecheckConfig)
        );
        installPhase = package.installPhase;
        npmDepsHash = package.npmDepsHash;
      }
    `),
  );
  const expectedManifestExtensions = Object.fromEntries(
    Object.entries(expectedExtensions).map(([logicalName, extension]) => [
      logicalName,
      {
        entryPath: extension.entryPath,
        license: "MIT",
        version: extension.version,
      },
    ]),
  );

  assert.deepEqual(metadata.manifest, {
    schemaVersion: 1,
    piVersion: expectedPiVersion,
    extensions: expectedManifestExtensions,
  });
  assert.deepEqual(
    metadata.provenance.extensions,
    Object.fromEntries(
      Object.entries(expectedExtensions).map(([logicalName, extension]) => [
        logicalName,
        {
          package: extension.package,
          sourceRef: extension.sourceRef,
          version: extension.version,
        },
      ]),
    ),
  );
  assert.deepEqual(metadata.provenance.runtimeDependencies, expectedRuntimeDependencies);
  assert.deepEqual(metadata.provenance.patches, expectedPatches);
  assert.equal(metadata.typecheckConfig.compilerOptions.noEmit, true);
  assert.equal(metadata.typecheckConfig.compilerOptions.strict, true);
  assert.deepEqual(metadata.typecheckConfig.files, [
    "ask-user/src/extension.ts",
    "background-tasks/dist/managed-environment.ts",
    "bash-timeout/src/extension.ts",
    "code-intelligence/src/extension.ts",
    "plan-mode/src/index.ts",
  ]);
  assert.equal(metadata.backgroundTypecheckConfig.compilerOptions.noEmit, true);
  assert.equal(metadata.backgroundTypecheckConfig.compilerOptions.strict, false);
  assert.deepEqual(metadata.backgroundTypecheckConfig.files, [
    "background-tasks/dist/index.ts",
    "background-tasks/dist/managed-environment.ts",
  ]);
  assert.match(metadata.installPhase, /typescript\/bin\/tsc/);
  assert.match(metadata.installPhase, /background-typecheck\.json/);
  assert.match(metadata.installPhase, /--project "\$typecheckDir\/tsconfig\.json"/);
  assert.match(
    metadata.installPhase,
    /patch --fuzz=0 --no-backup-if-mismatch -d node_modules\/@mrclrchtr\/supi-code-intelligence/,
  );
  assert.equal(metadata.provenance.schemaVersion, 1);
  assert.match(metadata.npmDepsHash, /^sha256-[A-Za-z0-9+/]{43}=$/);
});

test("built extension closure contains exact entries, licenses, and no commands or Pi runtime", () => {
  const output = buildExtensions();
  const manifest = readJson(path.join(output, "share/pi-agent/extensions.json"));
  const provenance = readJson(path.join(output, "share/pi-agent/extensions-provenance.json"));

  assert.equal(fs.existsSync(path.join(output, "bin")), false);
  assert.equal(fs.existsSync(path.join(output, "lib/node_modules/.bin")), false);
  assert.deepEqual(provenance.extensions, Object.fromEntries(
    Object.entries(expectedExtensions).map(([logicalName, extension]) => [
      logicalName,
      {
        package: extension.package,
        sourceRef: extension.sourceRef,
        version: extension.version,
      },
    ]),
  ));
  assert.deepEqual(provenance.patches, expectedPatches);

  for (const [logicalName, expected] of Object.entries(expectedExtensions)) {
    const packageRoot = packageDirectory(output, expected.package);
    const packageJson = readJson(path.join(packageRoot, "package.json"));
    const entry = manifest.extensions[logicalName];
    const licensePath = path.join(output, "share/licenses/pi-agent-extensions", logicalName, "LICENSE");

    assert.equal(packageJson.name, expected.package);
    assert.equal(packageJson.version, expected.version);
    assert.equal(packageJson.license, "MIT");
    assert.deepEqual(entry, {
      version: expected.version,
      entryPath: expected.entryPath,
      license: "MIT",
    });
    assert.equal(fs.existsSync(path.join(output, entry.entryPath)), true,
      `${logicalName} entry path is missing`);
    assertMitText(licensePath, expected.package);
  }

  const installedPackageJsons = [];
  const pending = [path.join(output, "lib/node_modules")];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const child = path.join(directory, entry.name);
      pending.push(child);
      const childManifest = path.join(child, "package.json");
      if (fs.existsSync(childManifest)) {
        installedPackageJsons.push(readJson(childManifest));
      }
    }
  }
  assert.deepEqual(
    installedPackageJsons
      .filter(({ name }) => /^@earendil-works\/pi-(?:agent-core|ai|coding-agent|tui)$/.test(name))
      .map(({ name, version }) => `${name}@${version}`),
    [],
  );

  const nodePtyRoot = packageDirectory(output, "node-pty");
  const backgroundTasksRoot = packageDirectory(
    output,
    "@99percentpeople/pi-background-tasks",
  );
  const bashTimeoutSourceRoot = path.join(
    packageDirectory(output, "@mrclrchtr/supi-bash-timeout"),
    "src",
  );
  const questionSourceRoot = path.join(
    packageDirectory(output, "@mrclrchtr/supi-ask-user"),
    "src",
  );
  const codeIntelligenceRoot = packageDirectory(
    output,
    "@mrclrchtr/supi-code-intelligence",
  );
  const codeIntelligenceSourceRoot = path.join(codeIntelligenceRoot, "src");
  const planSourceRoot = path.join(packageDirectory(output, "@narumitw/pi-plan-mode"), "src");
  for (const sourceRoot of [
    path.join(backgroundTasksRoot, "dist"),
    bashTimeoutSourceRoot,
    codeIntelligenceSourceRoot,
    planSourceRoot,
    questionSourceRoot,
  ]) {
    assert.deepEqual(
      fs.readdirSync(sourceRoot).filter((entry) => /\.(?:orig|rej)$/.test(entry)),
      [],
    );
  }
  const bashTimeoutSource = fs.readFileSync(path.join(bashTimeoutSourceRoot, "bash-timeout.ts"), "utf8");
  const managedTimeoutSource = fs.readFileSync(
    path.join(bashTimeoutSourceRoot, "managed-timeout.ts"),
    "utf8",
  );
  assert.match(bashTimeoutSource, /TIMEOUT_BINDING/);
  assert.match(bashTimeoutSource, /pi\.on\("message_end"/);
  assert.match(bashTimeoutSource, /item\.arguments\.timeout !== null/);
  assert.doesNotMatch(bashTimeoutSource, /loadBashTimeoutConfig|registerBashTimeoutSettings/);
  assert.match(managedTimeoutSource, /PI_AGENT_BASH_TIMEOUT_MS/);
  assert.match(managedTimeoutSource, /2_147_483_647/);
  assert.match(managedTimeoutSource, /Math\.trunc\(seconds \* 1000\)/);
  assert.match(managedTimeoutSource, /export function parseManagedTimeoutSeconds/);
  const askUserSource = fs.readFileSync(path.join(questionSourceRoot, "ask-user.ts"), "utf8");
  const questionControllerSource = fs.readFileSync(
    path.join(questionSourceRoot, "session/controller.ts"),
    "utf8",
  );
  const questionFormSource = fs.readFileSync(
    path.join(questionSourceRoot, "ui/form-component.ts"),
    "utf8",
  );
  assert.match(askUserSource, /prepareArguments: prepareAskUserArguments/);
  assert.match(askUserSource, /Value\.Check\(AskUserParamsSchema, args\)/);
  assert.doesNotMatch(askUserSource, /resolveToolPromptSurface|notifyToolPromptSurfaceDiagnostics/);
  assert.match(askUserSource, /description: ASK_USER_PROMPT_SURFACE_DEFAULTS\.description/);
  assert.match(askUserSource, /event\.toolName !== ASK_USER_TOOL_NAME \|\| event\.isError/);
  assert.match(askUserSource, /if \(signal\?\.aborted\) cancelInteraction\(ctx\)/);
  assert.match(questionControllerSource, /state\.value = value;/);
  assert.match(questionControllerSource, /state\.value\.trim\(\)\.length > 0/);
  assert.match(questionFormSource, /pendingTextSubmission/);
  assert.match(questionFormSource, /this\.args\.done[\s\S]+removeEventListener\("abort"/);
  const managedLspSource = fs.readFileSync(
    path.join(
      codeIntelligenceRoot,
      "node_modules/@mrclrchtr/supi-lsp/src/config/managed-executables.ts",
    ),
    "utf8",
  );
  assert.match(managedLspSource, /PI_AGENT_LSP_EXECUTABLES/);
  assert.match(managedLspSource, /realpathSync\.native/);
  assert.match(managedLspSource, /Object\.create\(null\)/);
  assert.match(
    managedLspSource,
    /SAFE_SERVER_ID\.test\(name\) && Object\.hasOwn\(catalog, name\)/,
  );
  assert.match(managedLspSource, /package-to-ID provenance is trusted/i);
  assert.doesNotMatch(managedLspSource, /MANAGED_CODE_INTELLIGENCE_ENABLED/);
  const refactorApplySource = fs.readFileSync(
    path.join(codeIntelligenceSourceRoot, "analysis/refactor/managed-apply.ts"),
    "utf8",
  );
  const refactorPlanSource = fs.readFileSync(
    path.join(codeIntelligenceSourceRoot, "session/refactor-plans.ts"),
    "utf8",
  );
  assert.match(refactorApplySource, /realpathSync\.native/);
  assert.match(refactorApplySource, /openSync/);
  assert.match(refactorApplySource, /fchownSync/);
  assert.match(refactorApplySource, /fchmodSync/);
  assert.match(refactorApplySource, /fsyncSync/);
  assert.match(refactorApplySource, /closeSync/);
  assert.match(refactorApplySource, /renameSync/);
  assert.match(refactorPlanSource, /randomUUID/);
  assert.match(refactorPlanSource, /claimPlan/);
  assert.doesNotMatch(refactorPlanSource, /Date\.now\(\).*plan|slice\(0, 12\)/s);
  const backgroundTasksSource = fs.readFileSync(
    path.join(backgroundTasksRoot, "dist/index.ts"),
    "utf8",
  );
  const managedBackgroundEnvironmentSource = fs.readFileSync(
    path.join(backgroundTasksRoot, "dist/managed-environment.ts"),
    "utf8",
  );
  assert.match(backgroundTasksSource, /scrubManagedEnvironment\(shell\.env\)/);
  assert.match(backgroundTasksSource, /const ptyEnvironment = scrubManagedEnvironment\(shell\.env\)/);
  assert.match(backgroundTasksSource, /env: ptyEnvironment/);
  assert.match(backgroundTasksSource, /const processGroupId = process\.platform !== "win32"[\s\S]+taskProcess\.kind === "pty"/);
  assert.match(backgroundTasksSource, /function resolveLocalProcessGroupOperations/);
  assert.match(backgroundTasksSource, /Object\.freeze\(\{ probe, signal \}\)/);
  assert.match(backgroundTasksSource, /processGroupOperations: processGroupId === null \? null : localProcessGroupOperations/);
  assert.match(backgroundTasksSource, /process\.kill\(-processGroupId, 0\)/);
  assert.match(backgroundTasksSource, /process\.kill\(-processGroupId, processSignal\)/);
  assert.match(backgroundTasksSource, /async function waitForLocalProcessGroupEnd/);
  assert.match(backgroundTasksSource, /function startLocalProcessGroupCleanup/);
  assert.match(backgroundTasksSource, /async function terminateLocalProcessGroup/);
  assert.match(backgroundTasksSource, /async function settleReleasedLocalTask/);
  assert.match(backgroundTasksSource, /groupAlreadyReleased: true, signalDelivered: false/);
  assert.match(
    backgroundTasksSource,
    /const finalState = await settleReleasedLocalTask[\s\S]+return \{[\s\S]+\.\.\.cleanup,[\s\S]+\.\.\.finalState,/,
  );
  assert.match(backgroundTasksSource, /assertLocalProcessGroupReleased\(task, "restore over"\)/);
  assert.match(backgroundTasksSource, /assertLocalProcessGroupReleased\(task, "discard"\)/);
  assert.match(backgroundTasksSource, /await startLocalProcessGroupCleanup\(task/);
  assert.match(
    backgroundTasksSource,
    /async function sendProcessSignal[\s\S]+await settleReleasedLocalTask\(task, 3000\)/,
  );
  assert.match(backgroundTasksSource, /Timed out waiting for task/);
  assert.match(backgroundTasksSource, /Status: \$\{task\.status\}/);
  assert.doesNotMatch(backgroundTasksSource, /PI_AGENT_TASK_4_11_MANAGED_PTY/);
  assert.match(backgroundTasksSource, /output truncated; retained latest/);
  assert.match(backgroundTasksSource, /stdoutTruncated/);
  assert.match(managedBackgroundEnvironmentSource, /const ALLOW_NAMES/);
  assert.match(managedBackgroundEnvironmentSource, /PI_AGENT_BASH_TIMEOUT_MS/);
  assert.match(managedBackgroundEnvironmentSource, /SHOPIFY_PI_TOKEN/);
  assert.equal(readJson(path.join(nodePtyRoot, "package.json")).version, "1.2.0-beta.14");
  const ptyNode = path.join(nodePtyRoot, "prebuilds/darwin-arm64/pty.node");
  const spawnHelper = path.join(nodePtyRoot, "prebuilds/darwin-arm64/spawn-helper");
  assert.equal(
    path.relative(output, ptyNode),
    "lib/node_modules/node-pty/prebuilds/darwin-arm64/pty.node",
  );
  assert.equal(
    path.relative(output, spawnHelper),
    "lib/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper",
  );
  assert.equal(fs.statSync(ptyNode).isFile(), true);
  assert.equal(fs.statSync(spawnHelper).isFile(), true);
  assert.equal(fs.statSync(ptyNode).mode & 0o777, 0o444);
  assert.equal(fs.statSync(spawnHelper).mode & 0o777, 0o555);
  assertMitText(
    path.join(output, "share/licenses/pi-agent-extensions/nodePty/LICENSE"),
    "node-pty",
  );
});

test("patched extensions typecheck against the exact Pi dependency declarations", () => {
  const output = buildExtensions();
  const pi = buildPi();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plan-mode-typecheck-"));
  const configPath = path.join(root, "tsconfig.json");
  const config = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      baseUrl: root,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      module: "Node16",
      moduleResolution: "Node16",
      noEmit: true,
      paths: {
        "@earendil-works/pi-ai": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-ai/dist/index.d.ts"),
        ],
        "@earendil-works/pi-ai/compat": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"),
        ],
        "@earendil-works/pi-coding-agent": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-coding-agent/index.d.ts"),
        ],
        "@earendil-works/pi-tui": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-tui/index.d.ts"),
        ],
        "@narumitw/pi-tui-kit": [
          path.join(output, "lib/node_modules/@narumitw/pi-tui-kit/dist/index.d.ts"),
        ],
        typebox: [path.join(output, "lib/node_modules/typebox/build/index.d.mts")],
        "typebox/*": [path.join(output, "lib/node_modules/typebox/build/*/index.d.mts")],
      },
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: "ES2022",
      typeRoots: [path.join(pi, "lib/node_modules/@types")],
      types: ["node"],
    },
    files: [
      path.join(output, expectedExtensions.questions.entryPath),
      path.join(
        output,
        "lib/node_modules/@99percentpeople/pi-background-tasks/dist/managed-environment.ts",
      ),
      path.join(output, expectedExtensions.bashTimeout.entryPath),
      path.join(output, expectedExtensions.codeIntelligence.entryPath),
      path.join(output, expectedExtensions.plan.entryPath),
    ],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(pi, "lib/node_modules/typescript/bin/tsc"), "--project", configPath],
      commandOptions,
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("patched background source adds no diagnostics beyond the reviewed bundled baseline", () => {
  const output = buildExtensions();
  const pi = buildPi();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-background-typecheck-"));
  const configPath = path.join(root, "tsconfig.json");
  const config = {
    compilerOptions: {
      allowImportingTsExtensions: true,
      baseUrl: path.join(output, "lib/node_modules"),
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      lib: ["ES2023"],
      module: "Node16",
      moduleResolution: "Node16",
      noEmit: true,
      paths: {
        "@earendil-works/pi-ai": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-ai/dist/index.d.ts"),
        ],
        "@earendil-works/pi-ai/compat": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-ai/dist/compat.d.ts"),
        ],
        "@earendil-works/pi-coding-agent": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-coding-agent/index.d.ts"),
        ],
        "@earendil-works/pi-tui": [
          path.join(pi, "lib/node_modules/@earendil-works/pi-tui/index.d.ts"),
        ],
        "@narumitw/pi-tui-kit": [
          path.join(output, "lib/node_modules/@narumitw/pi-tui-kit/dist/index.d.ts"),
        ],
        "@99percentpeople/pi-shared-settings": [
          path.join(output, "lib/node_modules/@99percentpeople/pi-shared-settings/dist/index.d.ts"),
        ],
        "node-pty": [path.join(output, "lib/node_modules/node-pty/typings/node-pty.d.ts")],
        typebox: [path.join(output, "lib/node_modules/typebox/build/index.d.mts")],
        "typebox/*": [path.join(output, "lib/node_modules/typebox/build/*/index.d.mts")],
      },
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: false,
      target: "ES2023",
      typeRoots: [path.join(pi, "lib/node_modules/@types")],
      types: ["node"],
    },
    files: [
      path.join(output, expectedExtensions.backgroundTasks.entryPath),
      path.join(
        output,
        "lib/node_modules/@99percentpeople/pi-background-tasks/dist/managed-environment.ts",
      ),
    ],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, "utf8");
  try {
    const result = childProcess.spawnSync(
      process.execPath,
      [path.join(pi, "lib/node_modules/typescript/bin/tsc"), "--pretty", "false", "--project", configPath],
      commandOptions,
    );
    const diagnostics = result.stdout
      .split("\n")
      .map((line) => line.match(/error TS\d+: .*/)?.[0])
      .filter(Boolean)
      .sort();
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.deepEqual(diagnostics, expectedBackgroundTypeDiagnostics);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("built closure supports one pipe spawn and one real Darwin PTY spawn", async () => {
  const output = buildExtensions();
  const pipe = childProcess.spawnSync("/bin/sh", ["-c", "printf pi-extension-pipe-ok"], {
    cwd: output,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(pipe.status, 0, pipe.stderr);
  assert.equal(pipe.stdout, "pi-extension-pipe-ok");

  const requireFromClosure = createRequire(path.join(output, "lib/node_modules/closure-loader.cjs"));
  const pty = requireFromClosure("node-pty");
  const ptyOutput = await new Promise((resolve, reject) => {
    const terminal = pty.spawn("/bin/sh", ["-c", "printf pi-extension-pty-ok"], {
      cols: 80,
      cwd: output,
      env: { PATH: "/usr/bin:/bin" },
      name: "xterm-color",
      rows: 24,
    });
    let outputText = "";
    const timeout = setTimeout(() => {
      terminal.kill();
      reject(new Error("node-pty spawn timed out"));
    }, 10_000);
    terminal.onData((chunk) => {
      outputText += chunk;
    });
    terminal.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode !== 0) {
        reject(new Error(`node-pty exited ${exitCode}: ${outputText}`));
        return;
      }
      resolve(outputText);
    });
  });
  assert.match(ptyOutput, /pi-extension-pty-ok/);
});
