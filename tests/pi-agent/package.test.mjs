import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedRevision = "1d37b58675b763ae6c9dc05d62321109066a4126";
const expectedVersion = "0.83.0";
const expectedNpmDepsHash = "sha256-q7yPSmOAWfl3bwHr7U/YEjvIOOyIZbmr0rDnqlsnFTA=";
const undiciPatchCommit = "221a842c136ab3af23aef9e70034af86061d27c1";
const undiciAdvisory = "GHSA-4cwx-7wf7-3272";
const patchedLockPath = path.join(repoRoot, "overlays/pi-agent/pi-package-lock.json");
const undiciPatchPath = path.join(repoRoot, "overlays/pi-agent/pi-undici-8.9.0.patch");
const hosts = ["Brandons-MacBook-Pro", "ShopifyLaptop"];
const nixHosts = `[ ${hosts.map((host) => JSON.stringify(host)).join(" ")} ]`;
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const affectedUndiciRanges = [
  { lower: "7.0.0", upper: "7.29.0" },
  { lower: "8.0.0", upper: "8.9.0" },
];

let packageMetadata;

function nixEvalJson(expression) {
  return JSON.parse(
    childProcess.execFileSync(
      "nix",
      ["eval", "--json", "--impure", "--expr", expression],
      commandOptions,
    ),
  );
}

function nixBuild(expression) {
  const outputs = childProcess
    .execFileSync(
      "nix",
      ["build", "--no-link", "--print-out-paths", "--impure", "--expr", expression],
      commandOptions,
    )
    .trim()
    .split("\n");

  assert.equal(outputs.length, 1);
  return outputs[0];
}

function flakeExpression(body) {
  return `
    let
      flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    in
      ${body}
  `;
}

function readPackageMetadata() {
  packageMetadata ??= nixEvalJson(
    flakeExpression(`
      let
        package = flake.darwinConfigurations.ShopifyLaptop.pkgs.pi-agent;
        upstream = flake.inputs.pi-nix.packages.aarch64-darwin.coding-agent;
      in
      {
        version = package.version;
        sourceMatches = package.src == upstream.src;
        upstreamPostPatch = upstream.postPatch;
        npmDepsHash = package.npmDepsHash;
        npmDepsOutputHash = package.npmDeps.outputHash;
        npmDepsRebuilt = package.npmDeps.drvPath != upstream.npmDeps.drvPath;
        patches = map (patch: builtins.unsafeDiscardStringContext (toString patch)) package.patches;
        postPatch = package.postPatch;
      }
    `),
  );

  return packageMetadata;
}

function jsonDiff(before, after, pointer = "") {
  if (isDeepStrictEqual(before, after)) {
    return [];
  }
  if (
    before === null ||
    after === null ||
    typeof before !== "object" ||
    typeof after !== "object" ||
    Array.isArray(before) ||
    Array.isArray(after)
  ) {
    return [pointer];
  }

  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  return keys.flatMap((key) => {
    const escaped = key.replaceAll("~", "~0").replaceAll("/", "~1");
    return jsonDiff(before[key], after[key], `${pointer}/${escaped}`);
  });
}

function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  assert.ok(match, `invalid semantic version: ${version}`);
  return match.slice(1).map(Number);
}

function compareSemver(left, right) {
  const leftParts = parseSemver(left);
  const rightParts = parseSemver(right);

  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return Math.sign(leftParts[index] - rightParts[index]);
    }
  }
  return 0;
}

function affectedAdvisories(version) {
  const affected = affectedUndiciRanges.some(
    ({ lower, upper }) => compareSemver(version, lower) >= 0 && compareSemver(version, upper) < 0,
  );
  return affected ? [undiciAdvisory] : [];
}

function assertUndiciVersionsSafe(packages, source) {
  assert.ok(packages.length > 0, `${source} contains no Undici package`);
  for (const entry of packages) {
    const advisories = affectedAdvisories(entry.version);
    assert.deepEqual(
      advisories,
      [],
      `${source} ${entry.path} contains undici@${entry.version}, affected by ${advisories.join(", ")}`,
    );
  }
}

function productionUndiciFromLock(lock) {
  return Object.entries(lock.packages)
    .filter(([packagePath, metadata]) => packagePath.endsWith("/undici") && metadata.dev !== true)
    .map(([packagePath, metadata]) => ({ path: packagePath, version: metadata.version }));
}

function installedUndiciPackages(root) {
  const packages = [];

  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);
      const manifestPath = path.join(entryPath, "package.json");
      if (entry.name === "undici" && fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
        if (manifest.name === "undici") {
          packages.push({ path: path.relative(root, entryPath), version: manifest.version });
        }
      }
      visit(entryPath);
    }
  }

  visit(root);
  return packages.sort((left, right) => left.path.localeCompare(right.path));
}

test("pi.nix is locked to the reviewed source revision", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "flake.lock"), "utf8"));

  assert.equal(lock.nodes.root.inputs["pi-nix"], "pi-nix");
  assert.equal(lock.nodes["pi-nix"].locked.rev, expectedRevision);
  assert.equal(lock.nodes["pi-nix"].original.rev, expectedRevision);
});

test("Pi production dependency lock changes only reviewed Undici entries", () => {
  const metadata = readPackageMetadata();
  const baselineLockMatch = /^cp (\/nix\/store\/\S+-package-lock\.json) package-lock\.json$/m.exec(
    metadata.upstreamPostPatch,
  );
  assert.ok(baselineLockMatch, "pi.nix postPatch does not identify its package lock");
  const baselineLock = JSON.parse(
    fs.readFileSync(baselineLockMatch[1], "utf8"),
  );
  const patchedLock = JSON.parse(fs.readFileSync(patchedLockPath, "utf8"));
  const changedPaths = jsonDiff(baselineLock, patchedLock).sort();

  assert.deepEqual(changedPaths, [
    "/packages/node_modules~1@earendil-works~1gondolin~1node_modules~1undici/integrity",
    "/packages/node_modules~1@earendil-works~1gondolin~1node_modules~1undici/resolved",
    "/packages/node_modules~1@earendil-works~1gondolin~1node_modules~1undici/version",
    "/packages/node_modules~1undici/integrity",
    "/packages/node_modules~1undici/resolved",
    "/packages/node_modules~1undici/version",
    "/packages/packages~1coding-agent/dependencies/undici",
  ]);
  assert.equal(baselineLock.packages["node_modules/undici"].version, "8.5.0");
  assert.equal(patchedLock.packages["node_modules/undici"].version, "8.9.0");
  assert.equal(
    baselineLock.packages["node_modules/@earendil-works/gondolin/node_modules/undici"].version,
    "6.27.0",
  );
  assert.equal(
    patchedLock.packages["node_modules/@earendil-works/gondolin/node_modules/undici"].version,
    "6.28.0",
  );
  assert.equal(patchedLock.packages["packages/coding-agent"].dependencies.undici, "8.9.0");
  assertUndiciVersionsSafe(productionUndiciFromLock(patchedLock), "patched production lock");

  const patch = fs.readFileSync(undiciPatchPath, "utf8");
  const patchedFiles = [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(
    ([, before, after]) => ({ before, after }),
  );
  assert.deepEqual(patchedFiles, [
    {
      before: "packages/coding-agent/package.json",
      after: "packages/coding-agent/package.json",
    },
  ]);
  assert.match(patch, new RegExp(`^From ${undiciPatchCommit} `));
  assert.match(patch, new RegExp(`https://github\\.com/advisories/${undiciAdvisory}`));
});

test("Pi package rebuilds npmDeps from the patched source and lock", () => {
  const metadata = readPackageMetadata();

  assert.equal(metadata.version, expectedVersion);
  assert.equal(metadata.sourceMatches, true);
  assert.equal(metadata.npmDepsHash, expectedNpmDepsHash);
  assert.equal(metadata.npmDepsOutputHash, expectedNpmDepsHash);
  assert.equal(metadata.npmDepsRebuilt, true);
  assert.equal(
    metadata.patches.filter((patch) => /\/pi-undici-8\.9\.0\.patch$/.test(patch)).length,
    1,
  );
  assert.match(metadata.postPatch, /-pi-package-lock\.json/);
});

test(`Pi production closure excludes ${undiciAdvisory}`, () => {
  const piOut = nixBuild(
    flakeExpression(`
      let
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      in
        pkgs.pi-agent
    `),
  );
  const undiciPackages = installedUndiciPackages(path.join(piOut, "lib/node_modules"));

  assert.deepEqual(
    [...new Set(undiciPackages.map(({ version }) => version))].sort(),
    ["6.28.0", "8.9.0"],
  );
  assertUndiciVersionsSafe(undiciPackages, "built Pi closure");
});

test("both hosts resolve the same uninstalled Pi package skeleton", () => {
  const rendered = nixEvalJson(
    flakeExpression(`
      let
        summarize = host:
          let
            system = flake.darwinConfigurations.\${host};
            pkgs = system.pkgs;
            home = system.config.home-manager.users.brandonmcnama;
            piPackage = pkgs.pi-agent;
            extensionPackage = pkgs.pi-agent-extensions;
            packagePath = builtins.unsafeDiscardStringContext "\${piPackage}";
            extensionPath = builtins.unsafeDiscardStringContext "\${extensionPackage}";
            installedPaths = map
              (package: builtins.unsafeDiscardStringContext "\${package}")
              home.home.packages;
          in
          {
            inherit (pkgs.stdenv.hostPlatform) system;
            package = {
              path = packagePath;
              inherit (piPackage) version;
              mainProgram = piPackage.meta.mainProgram;
            };
            extensions = {
              path = extensionPath;
              manifest = builtins.fromJSON (builtins.readFile extensionPackage.manifest);
            };
            installed = builtins.elem packagePath installedPaths
              || builtins.elem extensionPath installedPaths;
          };
      in
        builtins.listToAttrs (map (host: {
          name = host;
          value = summarize host;
        }) ${nixHosts})
    `),
  );

  for (const host of hosts) {
    assert.equal(rendered[host].system, "aarch64-darwin");
    assert.equal(rendered[host].package.version, expectedVersion);
    assert.equal(rendered[host].package.mainProgram, "pi");
    assert.deepEqual(rendered[host].extensions.manifest, {
      schemaVersion: 1,
      piVersion: expectedVersion,
      extensions: {},
    });
    assert.equal(rendered[host].installed, false);
  }

  assert.equal(rendered[hosts[0]].package.path, rendered[hosts[1]].package.path);
  assert.equal(rendered[hosts[0]].extensions.path, rendered[hosts[1]].extensions.path);
});

test("the package closure exposes one Pi command and no extension commands", () => {
  const piOut = nixBuild(
    flakeExpression(`
      let
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      in
        pkgs.pi-agent
    `),
  );
  const extensionsOut = nixBuild(
    flakeExpression(`
      let
        pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      in
        pkgs.pi-agent-extensions
    `),
  );

  assert.deepEqual(fs.readdirSync(path.join(piOut, "bin")), ["pi"]);
  assert.equal(fs.existsSync(path.join(extensionsOut, "bin")), false);
  assert.equal(
    fs.existsSync(path.join(extensionsOut, "share/pi-agent/extensions.json")),
    true,
  );

  const version = childProcess.execFileSync(path.join(piOut, "bin/pi"), ["--version"], {
    ...commandOptions,
    cwd: piOut,
  });
  assert.equal(version.trim(), expectedVersion);
});
