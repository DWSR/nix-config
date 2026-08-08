import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const patchPath = path.join(repoRoot, "overlays/pi-agent/pi-undici-8.9.0.patch");
const lockPath = path.join(repoRoot, "overlays/pi-agent/pi-package-lock.json");
const extensionRoot = path.join(repoRoot, "overlays/pi-agent/extensions");
const expectedVersion = "0.83.0";
const expectedNpmVersion = "11.6.2";
const expectedPiProductionDependencies = 170;
const expectedExtensionProductionDependencies = 77;
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  env: process.env,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

function command(command, args, options = {}) {
  try {
    return childProcess.execFileSync(command, args, { ...commandOptions, ...options }).trim();
  } catch (error) {
    const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
    throw new Error(`${command} failed: ${detail}`);
  }
}

function makeWritable(target) {
  const metadata = fs.lstatSync(target);

  if (metadata.isSymbolicLink()) {
    return;
  }
  fs.chmodSync(target, metadata.mode | (metadata.isDirectory() ? 0o700 : 0o600));
  if (metadata.isDirectory()) {
    for (const entry of fs.readdirSync(target)) {
      makeWritable(path.join(target, entry));
    }
  }
}

function piMetadata() {
  return JSON.parse(
    command("nix", [
      "eval",
      "--json",
      "--impure",
      "--expr",
      `
        let
          flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
          package = flake.inputs.pi-nix.packages.aarch64-darwin.coding-agent;
          piNixLock = builtins.fromJSON (builtins.readFile (flake.inputs.pi-nix.outPath + "/flake.lock"));
        in
        {
          source = builtins.unsafeDiscardStringContext (toString package.src);
          nixpkgsRevision = piNixLock.nodes.nixpkgs.locked.rev;
          inherit (package) version;
        }
      `,
    ]),
  );
}

function runAudit(npm, workspace, cache, expectedProductionDependencies, label) {
  const result = childProcess.spawnSync(
    npm,
    ["audit", "--omit=dev", "--package-lock-only", "--audit-level=high", "--json"],
    {
      ...commandOptions,
      cwd: workspace,
      env: {
        ...process.env,
        npm_config_cache: cache,
      },
    },
  );

  if (result.error) {
    throw result.error;
  }

  let report;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm audit emitted invalid JSON: ${error.message}; stderr: ${result.stderr.trim()}`);
  }
  if (report.error) {
    throw new Error(`npm audit error: ${JSON.stringify(report.error)}`);
  }

  assert.equal(report.auditReportVersion, 2, "unexpected npm audit report version");
  assert.equal(
    report.metadata?.dependencies?.prod,
    expectedProductionDependencies,
    `audit did not inspect the full ${label} production workspace`,
  );
  assert.equal(report.metadata?.vulnerabilities?.high, 0, `${label} audit found high advisories`);
  assert.equal(report.metadata?.vulnerabilities?.critical, 0, `${label} audit found critical advisories`);
  if (result.status !== 0) {
    throw new Error(`npm audit exited ${result.status}: ${result.stderr.trim()}`);
  }

  return report;
}

function main() {
  const metadata = piMetadata();
  assert.equal(metadata.version, expectedVersion);

  const nodePackage = command("nix", [
    "build",
    "--no-link",
    "--print-out-paths",
    `github:nixos/nixpkgs/${metadata.nixpkgsRevision}#nodejs_24`,
  ]);
  const npm = path.join(nodePackage, "bin/npm");
  const npmVersion = command(npm, ["--version"]);
  assert.equal(npmVersion, expectedNpmVersion);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-audit-"));
  const piWorkspace = path.join(root, "pi");
  const extensionWorkspace = path.join(root, "extensions");
  try {
    fs.cpSync(metadata.source, piWorkspace, { recursive: true });
    makeWritable(piWorkspace);
    command("patch", ["--batch", "--forward", "--strip=1", `--input=${patchPath}`], {
      cwd: piWorkspace,
    });
    fs.copyFileSync(lockPath, path.join(piWorkspace, "package-lock.json"));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(piWorkspace, "packages/coding-agent/package.json"), "utf8"),
    );
    assert.equal(manifest.version, expectedVersion);
    assert.equal(manifest.dependencies.undici, "8.9.0");
    assert.ok(fs.existsSync(path.join(piWorkspace, "packages/agent/package.json")));
    assert.ok(fs.existsSync(path.join(piWorkspace, "packages/ai/package.json")));

    fs.cpSync(extensionRoot, extensionWorkspace, { recursive: true });
    makeWritable(extensionWorkspace);
    const extensionManifest = JSON.parse(
      fs.readFileSync(path.join(extensionWorkspace, "package.json"), "utf8"),
    );
    assert.equal(extensionManifest.private, true);
    assert.equal(extensionManifest.dependencies["node-pty"], "1.2.0-beta.14");

    const piReport = runAudit(
      npm,
      piWorkspace,
      path.join(root, "npm-cache"),
      expectedPiProductionDependencies,
      "Pi",
    );
    const extensionReport = runAudit(
      npm,
      extensionWorkspace,
      path.join(root, "npm-cache"),
      expectedExtensionProductionDependencies,
      "extension",
    );
    process.stdout.write(
      `${JSON.stringify({
        auditReportVersion: piReport.auditReportVersion,
        npmVersion,
        piVersion: metadata.version,
        productionDependencies: piReport.metadata.dependencies.prod,
        vulnerabilities: piReport.metadata.vulnerabilities,
        extensions: {
          productionDependencies: extensionReport.metadata.dependencies.prod,
          vulnerabilities: extensionReport.metadata.vulnerabilities,
        },
      })}\n`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`Pi production audit failed: ${error.message}\n`);
  process.exitCode = 1;
}
