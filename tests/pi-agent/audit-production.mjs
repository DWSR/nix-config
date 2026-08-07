import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const patchPath = path.join(repoRoot, "overlays/pi-agent/pi-undici-8.9.0.patch");
const lockPath = path.join(repoRoot, "overlays/pi-agent/pi-package-lock.json");
const expectedVersion = "0.83.0";
const expectedNpmVersion = "11.6.2";
const expectedProductionDependencies = 170;
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

function runAudit(npm, workspace, cache) {
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
    "audit did not inspect the full Pi production workspace",
  );
  assert.equal(report.metadata?.vulnerabilities?.high, 0, "npm audit found high advisories");
  assert.equal(report.metadata?.vulnerabilities?.critical, 0, "npm audit found critical advisories");
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
  const workspace = path.join(root, "pi");
  try {
    fs.cpSync(metadata.source, workspace, { recursive: true });
    makeWritable(workspace);
    command("patch", ["--batch", "--forward", "--strip=1", `--input=${patchPath}`], {
      cwd: workspace,
    });
    fs.copyFileSync(lockPath, path.join(workspace, "package-lock.json"));

    const manifest = JSON.parse(
      fs.readFileSync(path.join(workspace, "packages/coding-agent/package.json"), "utf8"),
    );
    assert.equal(manifest.version, expectedVersion);
    assert.equal(manifest.dependencies.undici, "8.9.0");
    assert.ok(fs.existsSync(path.join(workspace, "packages/agent/package.json")));
    assert.ok(fs.existsSync(path.join(workspace, "packages/ai/package.json")));

    const report = runAudit(npm, workspace, path.join(root, "npm-cache"));
    process.stdout.write(
      `${JSON.stringify({
        auditReportVersion: report.auditReportVersion,
        npmVersion,
        piVersion: metadata.version,
        productionDependencies: report.metadata.dependencies.prod,
        vulnerabilities: report.metadata.vulnerabilities,
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
