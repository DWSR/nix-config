import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const goldenPath = path.join(
  testsDir,
  "fixtures/cavemem/legacy-post-tool-use.golden.json",
);
const limitFixture = JSON.parse(
  fs.readFileSync(
    path.join(testsDir, "fixtures/cavemem/storage-limit.json"),
    "utf8",
  ),
);
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 900_000,
};

let limitRuntimeRoot;
let productionRuntimeRoot;
const bundledCore = new Map();

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-cavemem-integration-test";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      cavememSmoke = pkgs.callPackage (source + "/scripts/cavemem-smoke-test.nix") { };
      cavememLimitFixture = pkgs.cavemem.overrideAttrs (old: {
        buildPhase = ''
          export CFLAGS="-DSQLITE_MAX_LENGTH=${limitFixture.sqliteMaxLength}"
          export CFLAGS="$CFLAGS -DSQLITE_MAX_SQL_LENGTH=${limitFixture.sqliteMaxLength}"
          export CXXFLAGS="$CFLAGS"
        '' + old.buildPhase;
      });
    in
      ${body}
  `;
}

function buildRuntime(name, paths) {
  return childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        filteredFlakeExpression(`
          pkgs.buildEnv {
            name = ${JSON.stringify(name)};
            paths = [ ${paths.join(" ")} ];
          }
        `),
      ],
      commandOptions,
    )
    .trim();
}

function getProductionRuntimeRoot() {
  productionRuntimeRoot ??= buildRuntime(
    "pi-agent-cavemem-integration-runtime",
    ["pkgs.cavemem", "pkgs.sqlite", "pkgs.nodejs", "cavememSmoke"],
  );
  assert.match(productionRuntimeRoot, /^\/nix\/store\//);
  assert.equal(productionRuntimeRoot.includes("\n"), false);
  return productionRuntimeRoot;
}

function getLimitRuntimeRoot() {
  limitRuntimeRoot ??= buildRuntime("pi-agent-cavemem-limit-runtime", [
    "cavememLimitFixture",
    "pkgs.sqlite",
    "pkgs.nodejs",
  ]);
  assert.match(limitRuntimeRoot, /^\/nix\/store\//);
  assert.equal(limitRuntimeRoot.includes("\n"), false);
  return limitRuntimeRoot;
}

async function withDataDir(prefix, operation) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return await operation(dataDir);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

function dataEnvironment(dataDir) {
  const environment = { ...process.env };
  delete environment.FORCE_COLOR;
  return {
    ...environment,
    CAVEMEM_DATA_DIR: dataDir,
    CAVEMEM_NO_AUTOSTART: "1",
    NO_COLOR: "1",
  };
}

function runHook(root, dataDir, payload, captureMode) {
  const args = ["hook", "run", "post-tool-use", "--ide", "pi"];
  if (captureMode !== undefined) args.push("--capture-mode", captureMode);
  return childProcess.spawnSync(path.join(root, "bin/cavemem"), args, {
    encoding: "utf8",
    env: dataEnvironment(dataDir),
    input: JSON.stringify(payload),
    maxBuffer: 64 * 1024 * 1024,
  });
}

function queryRows(root, dataDir, sql) {
  const result = childProcess.spawnSync(
    path.join(root, "bin/sqlite3"),
    ["-json", path.join(dataDir, "data.db"), sql],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

function observationRows(root, dataDir) {
  return queryRows(
    root,
    dataDir,
    "SELECT id, session_id, kind, content, compressed, intensity, metadata " +
      "FROM observations ORDER BY id",
  );
}

function parseTelemetry(stderr) {
  const lines = stderr.trim().split("\n").filter(Boolean);
  return JSON.parse(lines.at(-1));
}

function assertHookSucceeded(result) {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  const telemetry = parseTelemetry(result.stderr);
  assert.equal(telemetry.hook, "post-tool-use");
  assert.equal(telemetry.ok, true);
}

async function loadBundledCore(root) {
  if (bundledCore.has(root)) return bundledCore.get(root);
  const dist = path.join(root, "lib/node_modules/cavemem/dist");
  const files = fs
    .readdirSync(dist)
    .filter((name) => /^(?:chunk|server)-.+\.js$/.test(name));
  const modules = await Promise.all(
    files.map((name) => import(pathToFileURL(path.join(dist, name)).href)),
  );
  const core = modules.find(
    (module) =>
      typeof module.MemoryStore === "function" &&
      typeof module.defaultSettings === "object",
  );
  assert.ok(core, "bundled core module was not found");
  bundledCore.set(root, core);
  return core;
}

function makeFullPayload(fillerLength = 0) {
  return {
    session_id: limitFixture.sessionId,
    schemaVersion: 1,
    toolCallId: limitFixture.toolCallId,
    toolName: limitFixture.toolName,
    input: {
      marker: limitFixture.searchTerm,
      filler: "x".repeat(fillerLength),
    },
    output: {
      content: { result: "complete" },
      details: { exitCode: 0 },
      isError: false,
    },
  };
}

function expectedFullContent(payload) {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    input: payload.input,
    output: payload.output,
  });
}

function activeSqliteMaximum(root) {
  const modulePath = path.join(
    root,
    "lib/node_modules/cavemem/node_modules/better-sqlite3",
  );
  const script = `
    const Database = require(${JSON.stringify(modulePath)});
    const db = new Database(':memory:');
    const option = db.pragma('compile_options')
      .map((row) => row.compile_options)
      .find((value) => /^MAX_LENGTH=/.test(value));
    db.close();
    process.stdout.write(String(option ?? ''));
  `;
  const result = childProcess.spawnSync(path.join(root, "bin/node"), ["-e", script], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const match = /^MAX_LENGTH=(\d+)$/.exec(result.stdout);
  assert.ok(match, `missing SQLite MAX_LENGTH compile option: ${result.stdout}`);
  return Number(match[1]);
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function legacyManifest(result, row) {
  const telemetry = parseTelemetry(result.stderr);
  return {
    exitStatus: result.status,
    stdout: result.stdout,
    telemetry: { hook: telemetry.hook, ok: telemetry.ok },
    row: {
      session_id: row.session_id,
      kind: row.kind,
      contentBytes: Buffer.byteLength(row.content),
      contentSha256: sha256(row.content),
      compressed: row.compressed,
      intensity: row.intensity,
      metadata: row.metadata,
      metadataBytes: Buffer.byteLength(row.metadata),
      metadataSha256: sha256(row.metadata),
    },
  };
}

test("production Cavemem declares the reviewed full-mode patch order", () => {
  const overlay = fs.readFileSync(
    path.join(repoRoot, "overlays/mcp-servers.nix"),
    "utf8",
  );
  const names = [
    "cavemem-pi-full-payload-v1.patch",
    "cavemem-pi-full-privacy-v1.patch",
    "cavemem-pi-full-storage-policy-v1.patch",
    "cavemem-pi-full-storage-limit-v1.patch",
  ];
  const positions = names.map((name) => overlay.indexOf(name));
  assert.equal(positions.every((position) => position >= 0), true);
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  for (const name of names) {
    assert.equal(overlay.split(name).length - 1, 1, `${name} is not unique`);
  }

  const limitPatch = fs.readFileSync(
    path.join(repoRoot, "overlays/cavemem-pi-full-storage-limit-v1.patch"),
    "utf8",
  );
  const changedPaths = [
    ...limitPatch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
  ].map((match) => [match[1], match[2]]);
  assert.deepEqual(changedPaths, [
    ["packages/storage/src/storage.ts", "packages/storage/src/storage.ts"],
  ]);
  const addedCode = limitPatch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  assert.doesNotMatch(addedCode, /SCHEMA_SQL|CREATE TABLE|ALTER TABLE|CREATE INDEX/i);
});

test(
  "production Cavemem composes privacy, raw retrieval, embedding exclusion, and BM25",
  { timeout: 900_000 },
  async () => {
    const root = getProductionRuntimeRoot();
    await withDataDir("pi-agent-cavemem-integration-", async (dataDir) => {
      const secret = "combined-sensitive-value";
      const payload = {
        session_id: "combined-production-session",
        schemaVersion: 1,
        toolCallId: "call-combined-production",
        toolName: "IntegrationProbe",
        input: {
          nested: { "api.key": secret },
          marker: "combinedbm25marker",
        },
        output: {
          content: "complete combined output",
          details: { exitCode: 0 },
          isError: false,
        },
      };
      const expectedPayload = structuredClone(payload);
      expectedPayload.input.nested["api.key"] = "[REDACTED]";
      const expectedContent = expectedFullContent(expectedPayload);

      const result = runHook(root, dataDir, payload, "pi-full-v1");
      assertHookSucceeded(result);
      assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);

      const rows = observationRows(root, dataDir);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].compressed, 0);
      assert.equal(rows[0].intensity, null);
      assert.equal(rows[0].content, expectedContent);
      assert.equal(rows[0].content.includes(secret), false);

      const core = await loadBundledCore(root);
      const settings = structuredClone(core.defaultSettings);
      settings.dataDir = dataDir;
      settings.compression.expandForModel = true;
      settings.embedding.provider = "none";
      const store = new core.MemoryStore({
        dbPath: path.join(dataDir, "data.db"),
        settings,
      });
      try {
        for (const options of [{}, { expand: true }, { expand: false }]) {
          const retrieved = store.getObservations([rows[0].id], options)[0];
          assert.ok(retrieved);
          assert.equal(retrieved.content, expectedContent);
          assert.equal(retrieved.compressed, false);
        }
        store.storage.putEmbedding(
          rows[0].id,
          "integration-probe",
          new Float32Array([1, 0.5, 0.25]),
        );
        assert.deepEqual(
          queryRows(
            root,
            dataDir,
            "SELECT observation_id FROM embeddings ORDER BY observation_id",
          ),
          [],
        );
        const search = await store.search("combinedbm25marker", 20);
        assert.equal(search.some((entry) => entry.id === rows[0].id), true);
      } finally {
        store.close();
      }

      assert.deepEqual(
        queryRows(root, dataDir, "SELECT version FROM schema_version ORDER BY version"),
        [{ version: 2 }],
      );
    });
  },
);

test(
  "production composition preserves the Task 3.1 default golden and invalid-mode failure",
  { timeout: 900_000 },
  async () => {
    const root = getProductionRuntimeRoot();
    const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
    const payload = {
      session_id: "legacy-golden-session",
      tool_name: "Read",
      tool_input: {
        command: "please basically just inspect /tmp/legacy",
        marker: `${"I".repeat(600)}INPUTTAIL`,
      },
      tool_response: {
        message: "I think perhaps the output is ready",
        marker: `${"O".repeat(600)}OUTPUTTAIL`,
      },
    };

    await withDataDir("pi-agent-cavemem-default-", async (dataDir) => {
      const result = runHook(root, dataDir, payload);
      assertHookSucceeded(result);
      const rows = observationRows(root, dataDir);
      assert.equal(rows.length, 1);
      assert.deepEqual(legacyManifest(result, rows[0]), golden);

      const invalid = runHook(root, dataDir, makeFullPayload(), "pi-full-v2");
      assert.equal(invalid.error, undefined);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, "");
      assert.equal(
        parseTelemetry(invalid.stderr).error,
        "unknown capture mode pi-full-v2",
      );
      assert.deepEqual(observationRows(root, dataDir), rows);
    });
  },
);

test(
  "active SQLite limit accepts its maximum complete full row and rejects maximum-plus-one",
  { timeout: 900_000 },
  async () => {
    const root = getLimitRuntimeRoot();
    assert.equal(activeSqliteMaximum(root), limitFixture.sqliteMaxLength);

    const succeeds = async (fillerLength) =>
      withDataDir("pi-agent-cavemem-limit-probe-", async (dataDir) => {
        const result = runHook(
          root,
          dataDir,
          makeFullPayload(fillerLength),
          "pi-full-v1",
        );
        return result.status === 0;
      });

    assert.equal(await succeeds(0), true);
    assert.equal(await succeeds(limitFixture.sqliteMaxLength), false);
    let accepted = 0;
    let rejected = limitFixture.sqliteMaxLength;
    while (accepted + 1 < rejected) {
      const candidate = Math.floor((accepted + rejected) / 2);
      if (await succeeds(candidate)) accepted = candidate;
      else rejected = candidate;
    }
    assert.equal(rejected, accepted + 1);

    await withDataDir("pi-agent-cavemem-limit-final-", async (dataDir) => {
      const maximumPayload = makeFullPayload(accepted);
      const maximumContent = expectedFullContent(maximumPayload);
      const maximum = runHook(
        root,
        dataDir,
        maximumPayload,
        "pi-full-v1",
      );
      assertHookSucceeded(maximum);
      const baseline = observationRows(root, dataDir);
      assert.equal(baseline.length, 1);
      assert.equal(baseline[0].content, maximumContent);
      assert.equal(baseline[0].compressed, 0);
      assert.equal(baseline[0].intensity, null);
      const baselineFts = queryRows(
        root,
        dataDir,
        "SELECT COUNT(*) AS count FROM observations_fts",
      );
      assert.deepEqual(baselineFts, [{ count: 1 }]);
      assert.ok(
        Buffer.byteLength(maximumContent) > limitFixture.sqliteMaxLength - 2_048,
      );

      const overflowPayload = makeFullPayload(rejected);
      const overflowContent = expectedFullContent(overflowPayload);
      assert.equal(
        Buffer.byteLength(overflowContent),
        Buffer.byteLength(maximumContent) + 1,
      );
      const overflow = runHook(
        root,
        dataDir,
        overflowPayload,
        "pi-full-v1",
      );
      assert.equal(overflow.error, undefined);
      assert.equal(overflow.status, 1);
      assert.equal(overflow.stdout, "");
      assert.equal(
        parseTelemetry(overflow.stderr).error,
        `pi-full-v1 storage limit exceeded at active SQLite boundary SQLITE_MAX_LENGTH=${limitFixture.sqliteMaxLength}`,
      );
      for (const sourceValue of [
        overflowPayload.session_id,
        overflowPayload.toolCallId,
        overflowPayload.toolName,
        overflowPayload.input.marker,
        overflowPayload.input.filler,
      ]) {
        assert.equal(overflow.stderr.includes(sourceValue), false);
      }
      assert.deepEqual(observationRows(root, dataDir), baseline);
      assert.deepEqual(
        queryRows(
          root,
          dataDir,
          "SELECT COUNT(*) AS count FROM observations_fts",
        ),
        baselineFts,
      );

      const core = await loadBundledCore(root);
      const settings = structuredClone(core.defaultSettings);
      settings.dataDir = dataDir;
      settings.embedding.provider = "none";
      const store = new core.MemoryStore({
        dbPath: path.join(dataDir, "data.db"),
        settings,
      });
      try {
        const retrieved = store.getObservations([baseline[0].id], {
          expand: true,
        })[0];
        assert.ok(retrieved);
        assert.equal(retrieved.content, maximumContent);
        assert.equal(retrieved.compressed, false);
        store.storage.putEmbedding(
          baseline[0].id,
          "limit-probe",
          new Float32Array([1, 0.5, 0.25]),
        );
        assert.deepEqual(
          queryRows(root, dataDir, "SELECT observation_id FROM embeddings"),
          [],
        );
        const search = await store.search(limitFixture.searchTerm, 20);
        assert.equal(search.some((entry) => entry.id === baseline[0].id), true);
      } finally {
        store.close();
      }
      assert.deepEqual(
        queryRows(root, dataDir, "SELECT version FROM schema_version ORDER BY version"),
        [{ version: 2 }],
      );
    });
  },
);

test(
  "production package smoke covers default and invalid capture modes",
  { timeout: 900_000 },
  () => {
    const root = getProductionRuntimeRoot();
    const result = childProcess.spawnSync(
      path.join(root, "bin/cavemem-smoke-test"),
      [],
      {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^OK: pi-default-mode$/m);
    assert.match(result.stdout, /^OK: pi-invalid-mode$/m);
    assert.equal(result.stderr, "");
  },
);
