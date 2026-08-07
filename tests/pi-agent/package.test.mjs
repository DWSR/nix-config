import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const expectedRevision = "1d37b58675b763ae6c9dc05d62321109066a4126";
const expectedVersion = "0.83.0";
const hosts = ["Brandons-MacBook-Pro", "ShopifyLaptop"];
const nixHosts = `[ ${hosts.map((host) => JSON.stringify(host)).join(" ")} ]`;
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};

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

test("pi.nix is locked to the reviewed source revision", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "flake.lock"), "utf8"));

  assert.equal(lock.nodes.root.inputs["pi-nix"], "pi-nix");
  assert.equal(lock.nodes["pi-nix"].locked.rev, expectedRevision);
  assert.equal(lock.nodes["pi-nix"].original.rev, expectedRevision);
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
