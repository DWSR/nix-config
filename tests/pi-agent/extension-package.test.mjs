import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
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
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

let builtExtensionPath;

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
  assert.equal(readJson(path.join(nodePtyRoot, "package.json")).version, "1.2.0-beta.14");
  assert.equal(fs.existsSync(path.join(nodePtyRoot, "prebuilds/darwin-arm64/pty.node")), true);
  assert.equal(fs.existsSync(path.join(nodePtyRoot, "prebuilds/darwin-arm64/spawn-helper")), true);
  assert.ok((fs.statSync(path.join(nodePtyRoot, "prebuilds/darwin-arm64/spawn-helper")).mode & 0o111) !== 0);
  assertMitText(
    path.join(output, "share/licenses/pi-agent-extensions/nodePty/LICENSE"),
    "node-pty",
  );
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
