import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createValidationReport } from "./harness.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const profileNames = ["pi-audit", "pi-managed", "pi-review"];
const profileTopLevelKeys = [
  "environment",
  "extends",
  "filesystem",
  "groups",
  "meta",
  "network",
  "security",
  "workdir",
];
const runtimeGroups = [
  "node_runtime",
  "rust_runtime",
  "python_runtime",
  "user_caches_macos",
  "nix_runtime",
  "unlink_protection",
];
const statePaths = [
  "$HOME/.pi/agent",
  "$TMPDIR/pi-agent",
];
const requiredEnvironmentNames = [
  "AGENTMEMORY_SECRET",
  "AGENTMEMORY_URL",
  "COLORTERM",
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NIX_SSL_CERT_FILE",
  "NO_COLOR",
  "PATH",
  "PI_AGENT_BASH_TIMEOUT_MS",
  "PI_AGENT_LAUNCH_ID",
  "PI_CODING_AGENT_DIR",
  "SHELL",
  "SHOPIFY_PI_TOKEN",
  "SSL_CERT_FILE",
  "TERM",
  "TERM_PROGRAM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
];
const sensitiveDirectories = [
  "$HOME/.1password",
  "$HOME/.aws",
  "$HOME/.azure",
  "$HOME/.config/gcloud",
  "$HOME/.config/gh",
  "$HOME/.config/git",
  "$HOME/.config/op",
  "$HOME/.docker",
  "$HOME/.gnupg",
  "$HOME/.kube",
  "$HOME/.ssh",
  "$HOME/Library/Application Support/1Password",
  "$HOME/Library/Keychains",
];
const licenseMetadata = {
  declaredBy: "pi/package.json",
  identifier: "Apache-2.0",
  licensePath: "share/pi-agent/nono/LICENSE-Apache-2.0.txt",
  noticePath: "share/pi-agent/nono/NOTICE",
  textHash: "sha256-z8d0m5b2O9McPEK1xHG/dWgUBT6EfBDz6wA0F7xSPTA=",
  textSource: "https://www.apache.org/licenses/LICENSE-2.0.txt",
};

function fixtureExpression(fixture) {
  return `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-profile-test-source";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoSource));
    in
    import (repoSource + "/tests/pi-agent/fixtures/profile-catalog.nix") {
      inherit flake repoSource;
      fixture = ${JSON.stringify(fixture)};
    }
  `;
}

function evaluateFixture(fixture) {
  return childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", fixtureExpression(fixture)],
    commandOptions,
  );
}

function validFixture(fixture) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function packagePath() {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      "--impure",
      "--expr",
      fixtureExpression("package"),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").at(-1);
}

function makeNonoEnvironment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-profile-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "private-tmp");
  const environment = {
    ...process.env,
    HOME: home,
    NONO_NO_UPDATE_CHECK: "1",
    TMPDIR: tmp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(home, ".local/state"),
  };

  for (const directory of [
    path.join(home, ".pi/agent"),
    path.join(environment.XDG_CONFIG_HOME, "nono/profiles"),
    path.join(tmp, "pi-agent"),
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return { environment, root };
}

function makeRuntimeProbeEnvironment(requiredNames) {
  const base = path.join(os.homedir(), ".local/state/opencode");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "pi-agent-nono-runtime-"));
  const home = path.join(root, "home");
  const tmp = path.join(root, "private-tmp");
  const environment = {
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    LC_CTYPE: "C",
    NONO_NO_SAVE_PROMPT: "1",
    NONO_NO_UPDATE_CHECK: "1",
    PATH: "/usr/bin:/bin",
    SHELL: "/bin/sh",
    TMPDIR: tmp,
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local/share"),
    XDG_STATE_HOME: path.join(root, "nono-state"),
  };

  for (const name of requiredNames) {
    environment[name] ??= `pi-agent-required-${name}`;
  }
  Object.assign(environment, {
    PI_AGENT_BASH_TIMEOUT_MS: "543210",
    NODE_PATH: "pi-agent-dangerous-node-path",
    OPENAI_API_KEY: "pi-agent-denied-openai",
    AWS_SECRET_ACCESS_KEY: "pi-agent-denied-aws",
    SSH_AUTH_SOCK: path.join(root, "denied-ssh-agent.sock"),
    PI_AGENT_UNLISTED_CREDENTIAL: "pi-agent-unlisted-credential",
    PI_CODING_AGENT_DIR: path.join(home, ".pi/agent"),
  });

  for (const directory of [
    environment.PI_CODING_AGENT_DIR,
    path.join(environment.XDG_CONFIG_HOME, "nono/profiles"),
    path.join(tmp, "pi-agent"),
    environment.XDG_STATE_HOME,
  ]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  return { environment, root };
}

function runNono(nono, args, environment, cwd = repoRoot) {
  return childProcess.spawnSync(nono, args, {
    cwd,
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
}

function isNestedSandboxRestriction(result) {
  return (
    result.status === 126 &&
    /failed to apply sandbox in supervised child: Sandbox initialization failed: Operation not permitted/.test(
      `${result.stderr}\n${result.stdout}`,
    )
  );
}

function reportManualEnvironmentProbe(testContext, reason) {
  testContext.diagnostic(
    JSON.stringify(
      createValidationReport("pi-agent-profile-catalog-v1", [
        {
          name: "real-nono-child-environment-probe",
          status: "manual-required",
          evidence: [
            "missing-prerequisite:unsandboxed macOS host process outside the enclosing OpenCode/Nix Seatbelt",
            `missing-evidence:${reason}`,
            "probe-categories:environment",
            "recovery:rerun on an unsandboxed macOS host process",
          ],
        },
      ]),
    ),
  );
}

function hasGrant(manifest, expectedPath, access) {
  return manifest.filesystem.grants.some(
    (grant) => grant.path === expectedPath && grant.access === access,
  );
}

function parseEnvironment(text) {
  return Object.fromEntries(
    text
      .split("\n")
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
}

let catalogSummary;
let builtPackage;

test("the catalog pins the reviewed Pi policy and selected nono", () => {
  catalogSummary ??= validFixture("catalog");

  assert.equal(catalogSummary.nonoVersion, "0.69.0");
  assert.equal(catalogSummary.packageIsDerivation, true);
  assert.equal(catalogSummary.packageHasOutputContext, true);
  assert.equal(catalogSummary.packageOutputName, "out");
  assert.deepEqual(catalogSummary.source, {
    hash: "sha256-3gMOrcBcFkqSNyttSFGnQcdiHwMQeSJ198GU0sjWFjo=",
    packagePath: "pi",
    packageVersion: "0.2.0",
    policyPath: "pi/policy.json",
    policyVersion: "1.0.0",
    repository: "https://github.com/nolabs-ai/nono-packs",
    revision: "b61adcb636a2bdbffd1aea29586993cc8f3aa552",
  });
  assert.deepEqual(Object.keys(catalogSummary.profiles).sort(), profileNames);
  assert.equal(catalogSummary.catalog.schemaVersion, 1);
  assert.equal(catalogSummary.catalog.nonoVersion, "0.69.0");
  assert.deepEqual(catalogSummary.catalog.source, catalogSummary.source);
  assert.deepEqual(catalogSummary.catalog.license, licenseMetadata);
});

test("all profiles are standalone and omit upstream runtime and credential wiring", () => {
  catalogSummary ??= validFixture("catalog");

  for (const name of profileNames) {
    const profile = catalogSummary.profiles[name];
    const serialized = JSON.stringify(profile);

    assert.deepEqual(Object.keys(profile).sort(), profileTopLevelKeys, name);
    assert.deepEqual(profile.extends, ["default"], name);
    assert.equal(profile.meta.name, name);
    assert.equal(profile.meta.version, "1.0.0-pi-agent.1");
    assert.match(profile.meta.description, new RegExp(name));
    assert.deepEqual(profile.groups.include, runtimeGroups);
    assert.equal(profile.groups.include.includes("git_config"), false);
    assert.deepEqual(profile.filesystem.allow, statePaths);
    assert.deepEqual(profile.filesystem.read, []);
    assert.deepEqual(profile.filesystem.deny, sensitiveDirectories);
    assert.deepEqual(profile.environment.allow_vars, requiredEnvironmentNames);

    for (const forbidden of [
      "$NONO_CONFIG",
      "$NONO_PACKAGES",
      "profile-drafts",
      "credential_routes",
      "custom_credentials",
      "env_credentials",
      "allow_launch_services",
      "open_urls",
      '"packs"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${name} contains ${forbidden}`);
    }
  }
});

test("managed, audit, and review expose the exact posture deltas", () => {
  catalogSummary ??= validFixture("catalog");
  const managed = catalogSummary.profiles["pi-managed"];
  const audit = catalogSummary.profiles["pi-audit"];
  const review = catalogSummary.profiles["pi-review"];

  assert.deepEqual(managed.security, {
    capability_elevation: false,
    ipc_mode: "shared_memory_only",
    process_info_mode: "allow_same_sandbox",
    signal_mode: "allow_same_sandbox",
  });
  assert.deepEqual(audit.security, managed.security);
  assert.deepEqual(review.security, {
    capability_elevation: false,
    ipc_mode: "shared_memory_only",
    process_info_mode: "isolated",
    signal_mode: "isolated",
  });

  assert.deepEqual(managed.network, {
    allow_domain: [],
    block: true,
    listen_port: [],
     open_port: [8080, 3111],
  });
  assert.deepEqual(review.network, managed.network);
  assert.deepEqual(audit.network, {
    allow_domain: [],
    block: false,
    listen_port: [],
     open_port: [8080, 3111],
  });
  assert.equal(managed.workdir.access, "readwrite");
  assert.equal(audit.workdir.access, "readwrite");
  assert.equal(review.workdir.access, "read");

  assert.equal(catalogSummary.catalog.profiles["pi-managed"].networkPolicy, "runtime-provider-host-required");
  assert.equal(catalogSummary.catalog.profiles["pi-audit"].networkPolicy, "unrestricted-audit");
  assert.equal(catalogSummary.catalog.profiles["pi-review"].networkPolicy, "runtime-provider-host-required");
  assert.equal(catalogSummary.contracts["pi-managed"].providerHost, null);
  assert.equal(catalogSummary.contracts["pi-managed"].processMode, "allow_same_sandbox");
  assert.equal(catalogSummary.contracts["pi-review"].workspaceAccess, "read");
  assert.deepEqual(
    catalogSummary.contracts["pi-review"].requiredEnvironmentNames,
    requiredEnvironmentNames,
  );
});

test("the catalog closure carries the declared Apache-2.0 license and source notice", () => {
  catalogSummary ??= validFixture("catalog");
  builtPackage ??= packagePath();
  const licensePath = path.join(builtPackage, licenseMetadata.licensePath);
  const noticePath = path.join(builtPackage, licenseMetadata.noticePath);

  assert.equal(fs.existsSync(licensePath), true, licensePath);
  assert.equal(fs.existsSync(noticePath), true, noticePath);
  const license = fs.readFileSync(licensePath, "utf8");
  const hash = `sha256-${crypto.createHash("sha256").update(license).digest("base64")}`;
  assert.equal(hash, licenseMetadata.textHash);
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
  assert.match(license, /END OF TERMS AND CONDITIONS/);

  const notice = fs.readFileSync(noticePath, "utf8");
  assert.match(notice, /nolabs-ai\/nono-packs/);
  assert.match(notice, new RegExp(catalogSummary.source.revision));
  assert.match(notice, /pi 0\.2\.0/);
  assert.match(notice, /pi\/policy\.json/);
  assert.match(notice, /Apache-2\.0/);
  assert.match(notice, /adapted standalone profiles/);
});

test("the selected nono strictly validates and resolves every profile", () => {
  catalogSummary ??= validFixture("catalog");
  builtPackage ??= packagePath();
  const { environment, root } = makeNonoEnvironment();

  try {
    const version = runNono(catalogSummary.nono, ["--version"], environment);
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout.trim(), "nono 0.69.0");

    for (const name of profileNames) {
      const source = path.join(builtPackage, "share/pi-agent/nono/profiles", `${name}.json`);
      const resolvedPath = path.join(
        builtPackage,
        "share/pi-agent/nono/resolved",
        `${name}.json`,
      );
      assert.equal(fs.existsSync(source), true, source);
      assert.equal(fs.existsSync(resolvedPath), true, resolvedPath);

      const validation = runNono(
        catalogSummary.nono,
        ["profile", "validate", "--strict", source],
        environment,
      );
      assert.equal(validation.status, 0, `${name}: ${validation.stderr}`);

      const resolution = runNono(
        catalogSummary.nono,
        ["profile", "show", source, "--json", "--silent"],
        environment,
      );
      assert.equal(resolution.status, 0, `${name}: ${resolution.stderr}`);
      const resolved = JSON.parse(resolution.stdout);
      assert.deepEqual(resolved, JSON.parse(fs.readFileSync(resolvedPath, "utf8")));
      assert.equal(resolved.name, name);
      assert.equal(resolved.network.open_port.includes(8080), true);
      assert.equal(resolved.groups.include.includes("git_config"), false);

      const manifestResult = runNono(
        catalogSummary.nono,
        ["profile", "show", source, "--format", "manifest", "--silent"],
        environment,
      );
      assert.equal(manifestResult.status, 0, `${name}: ${manifestResult.stderr}`);
      const manifest = JSON.parse(manifestResult.stdout);
      const expectedWorkspaceAccess = name === "pi-review" ? "read" : "readwrite";
      const expectedProcessMode = name === "pi-review" ? "isolated" : "allow_same_sandbox";
      assert.equal(hasGrant(manifest, path.join(environment.HOME, ".pi/agent"), "readwrite"), true);
       assert.equal(hasGrant(manifest, path.join(environment.TMPDIR, "pi-agent"), "readwrite"), true);
      assert.equal(hasGrant(manifest, repoRoot, expectedWorkspaceAccess), true);
      assert.equal(hasGrant(manifest, "/nix/store", "read"), true);
      assert.equal(manifest.network.mode, name === "pi-audit" ? "unrestricted" : "blocked");
       assert.deepEqual(manifest.network.ports.localhost, [8080, 3111]);
      assert.equal(manifest.process.signal_mode, expectedProcessMode);
      assert.equal(manifest.process.process_info_mode, expectedProcessMode);
      assert.equal(manifest.process.ipc_mode, "shared_memory_only");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test(
  "the selected nono passes the declared environment and strips denied values in a real child",
  (t) => {
    if (process.env.NIX_BUILD_TOP) {
      reportManualEnvironmentProbe(t, "Nix build sandbox cannot create the host state root");
      return;
    }
    catalogSummary ??= validFixture("catalog");
    builtPackage ??= packagePath();
    const runtimeWorkdir = process.env.PI_AGENT_RUNTIME_WORKDIR ?? repoRoot;

    for (const name of profileNames) {
      const source = path.join(builtPackage, "share/pi-agent/nono/profiles", `${name}.json`);
      const requiredNames = catalogSummary.contracts[name].requiredEnvironmentNames;
      const { environment, root } = makeRuntimeProbeEnvironment(requiredNames);

      try {
        const result = runNono(
          catalogSummary.nono,
          [
            "run",
            "--silent",
            "--no-audit",
            "--no-rollback",
            "--profile",
            source,
            "--allow-cwd",
            "--",
            "/usr/bin/env",
          ],
          environment,
          runtimeWorkdir,
        );
        if (isNestedSandboxRestriction(result)) {
          reportManualEnvironmentProbe(t, "nested Seatbelt prevents nono from applying a supervised child profile");
          return;
        }
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        const childEnvironment = parseEnvironment(result.stdout);

        for (const requiredName of requiredNames) {
          assert.equal(
            childEnvironment[requiredName],
            environment[requiredName],
            `${name} stripped declared required environment ${requiredName}`,
          );
        }
        for (const deniedName of [
          "NODE_PATH",
          "OPENAI_API_KEY",
          "AWS_SECRET_ACCESS_KEY",
          "SSH_AUTH_SOCK",
          "PI_AGENT_UNLISTED_CREDENTIAL",
        ]) {
          assert.equal(
            Object.hasOwn(childEnvironment, deniedName),
            false,
            `${name} leaked ${deniedName}`,
          );
        }
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  },
);

test("deliberately incomplete profile fixtures fail catalog validation", async (t) => {
  const fixtures = {
    "missing-environment": /pi-managed.*environment/,
    "missing-mcp-port": /pi-managed.*network\.open_port/,
    "missing-signal-policy": /pi-audit.*security\.signal_mode/,
    "review-writable": /pi-review.*workdir\.access.*read/,
    "missing-pi-state": /pi-managed.*filesystem\.allow.*\$HOME\/\.pi\/agent.*readwrite/,
    "missing-private-temp": /pi-managed.*filesystem\.allow.*\$TMPDIR\/pi-agent.*readwrite/,
  };

  for (const [fixture, diagnostic] of Object.entries(fixtures)) {
    await t.test(fixture, () => {
      const result = evaluateFixture(fixture);
      assert.ifError(result.error);
      assert.notEqual(result.status, 0, `${fixture} unexpectedly validated`);
      assert.match(`${result.stderr}\n${result.stdout}`, diagnostic);
    });
  }
});
