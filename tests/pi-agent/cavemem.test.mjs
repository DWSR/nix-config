import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const goldenPath = path.join(
  testsDir,
  "fixtures/cavemem/legacy-post-tool-use.golden.json",
);
const query =
  "SELECT session_id, kind, content, compressed, intensity, metadata " +
  "FROM observations ORDER BY id";
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 900_000,
};

let runtimeRoot;

function nixExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-cavemem-test";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
    in
      ${body}
  `;
}

function getRuntimeRoot() {
  runtimeRoot ??= childProcess
    .execFileSync(
      "nix",
      [
        "build",
        "--no-link",
        "--print-out-paths",
        "--impure",
        "--expr",
        nixExpression(`
          let pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
          in pkgs.buildEnv {
            name = "pi-agent-cavemem-test-runtime";
            paths = [ pkgs.cavemem pkgs.sqlite ];
          }
        `),
      ],
      commandOptions,
    )
    .trim();
  return runtimeRoot;
}

function withDataDir(operation) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-cavemem-"));
  try {
    return operation(dataDir);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

function runHook(dataDir, { captureMode, event = "post-tool-use", payload, raw }) {
  const root = getRuntimeRoot();
  const args = ["hook", "run", event, "--ide", "pi"];
  if (captureMode !== undefined) {
    args.push("--capture-mode", captureMode);
  }
  return childProcess.spawnSync(path.join(root, "bin/cavemem"), args, {
    encoding: "utf8",
    env: {
      ...process.env,
      CAVEMEM_DATA_DIR: dataDir,
      CAVEMEM_NO_AUTOSTART: "1",
      NO_COLOR: "1",
    },
    input: raw ?? JSON.stringify(payload),
    maxBuffer: 32 * 1024 * 1024,
  });
}

function readRows(dataDir) {
  const database = path.join(dataDir, "data.db");
  if (!fs.existsSync(database)) {
    return [];
  }
  const root = getRuntimeRoot();
  const result = childProcess.spawnSync(
    path.join(root, "bin/sqlite3"),
    ["-json", database, query],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

function normalizeTelemetry(stderr) {
  const lines = stderr.trim().split("\n").filter(Boolean);
  const telemetry = JSON.parse(lines.at(-1));
  assert.equal(Number.isInteger(telemetry.ms), true);
  return { hook: telemetry.hook, ok: telemetry.ok };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function legacyManifest(result, row) {
  return {
    exitStatus: result.status,
    stdout: result.stdout,
    telemetry: normalizeTelemetry(result.stderr),
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

function validEnvelope() {
  return {
    schemaVersion: 1,
    toolCallId: "call-123",
    toolName: "Bash",
    input: { command: "printf full-payload" },
    output: {
      content: "complete output",
      details: { exitCode: 0 },
      isError: false,
      usage: { input: 12, output: 34.5 },
    },
  };
}

test("default hook path matches the legacy golden bytes and 500-character limits", () => {
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

  withDataDir((dataDir) => {
    const result = runHook(dataDir, { payload });
    assert.equal(result.error, undefined);
    const rows = readRows(dataDir);
    assert.equal(rows.length, 1);
    assert.deepEqual(legacyManifest(result, rows[0]), golden);
    assert.equal(rows[0].content.includes("please basically just"), false);
    assert.equal(rows[0].content.includes("INPUTTAIL"), false);
    assert.equal(rows[0].content.includes("OUTPUTTAIL"), false);
    assert.equal([...rows[0].content.matchAll(/\u2026/g)].length, 2);
  });
});

test("default hook path retains the legacy 4000-character body cap", () => {
  withDataDir((dataDir) => {
    const toolName = "T".repeat(4100);
    const result = runHook(dataDir, {
      payload: {
        session_id: "legacy-body-cap-session",
        tool_name: toolName,
        tool_input: "not reached",
        tool_response: "not reached",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(normalizeTelemetry(result.stderr), {
      hook: "post-tool-use",
      ok: true,
    });

    const rows = readRows(dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, "T".repeat(4000));
    assert.equal(rows[0].compressed, 1);
    assert.equal(rows[0].intensity, "full");
    assert.deepEqual(JSON.parse(rows[0].metadata), { tool: toolName });
  });
});

test("default hook path retains permissive malformed-JSON parsing and exit behavior", () => {
  withDataDir((dataDir) => {
    const result = runHook(dataDir, { raw: "not-json" });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(normalizeTelemetry(result.stderr), {
      hook: "post-tool-use",
      ok: true,
    });
    assert.deepEqual(readRows(dataDir), [
      {
        session_id: "unknown",
        kind: "tool_use",
        content: "unknown input= output=",
        compressed: 1,
        intensity: "full",
        metadata: '{"tool":"unknown"}',
      },
    ]);
  });
});

test("pi-full-v1 stores one complete canonical envelope without compression", () => {
  const longInput = `${"please basically retain-input-segment ".repeat(300)}FULL-INPUT-TAIL`;
  const longOutput = `${"I think perhaps retain-output-segment ".repeat(300)}FULL-OUTPUT-TAIL`;
  const envelope = {
    schemaVersion: 1,
    toolCallId: "call-long-001",
    toolName: "Bash",
    input: {
      command: longInput,
      options: { timeout: 120000 },
    },
    output: {
      content: longOutput,
      details: { exitCode: 0, stream: [longOutput] },
      isError: false,
      usage: { input: 123, output: 456.5 },
    },
  };
  const expectedContent = JSON.stringify(envelope);
  assert.ok(expectedContent.length > 4000);

  withDataDir((dataDir) => {
    const result = runHook(dataDir, {
      captureMode: "pi-full-v1",
      payload: { session_id: "pi-full-session", ...envelope },
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(normalizeTelemetry(result.stderr), {
      hook: "post-tool-use",
      ok: true,
    });

    const rows = readRows(dataDir);
    assert.deepEqual(rows, [
      {
        session_id: "pi-full-session",
        kind: "tool_use",
        content: expectedContent,
        compressed: 0,
        intensity: null,
        metadata: JSON.stringify({
          tool: "Bash",
          captureMode: "pi-full-v1",
          schemaVersion: 1,
          toolCallId: "call-long-001",
        }),
      },
    ]);
    assert.equal(rows[0].content.includes("FULL-INPUT-TAIL"), true);
    assert.equal(rows[0].content.includes("FULL-OUTPUT-TAIL"), true);
  });
});

test("pi-full-v1 rejects unknown canonical keys without a row", async (t) => {
  const valid = validEnvelope();
  const cases = [
    {
      name: "unknown envelope key",
      payload: { session_id: "invalid", ...valid, unexpected: "discarded" },
      error: /pi-full-v1 envelope contains unknown field: unexpected/,
    },
    {
      name: "unknown output key",
      payload: {
        session_id: "invalid",
        ...valid,
        output: { ...valid.output, unexpected: "discarded" },
      },
      error: /pi-full-v1 output contains unknown field: unexpected/,
    },
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      withDataDir((dataDir) => {
        const result = runHook(dataDir, {
          captureMode: "pi-full-v1",
          payload: fixture.payload,
        });
        const rows = readRows(dataDir);
        assert.deepEqual(
          { status: result.status, rowCount: rows.length },
          { status: 1, rowCount: 0 },
          fixture.name,
        );
        assert.equal(result.stdout, "", fixture.name);
        assert.match(result.stderr, fixture.error, fixture.name);
        assert.equal(result.stderr.includes("discarded"), false, fixture.name);
      });
    });
  }
});

test("pi-full-v1 rejects unsupported events, modes, and malformed envelopes without a row", () => {
  const valid = validEnvelope();
  const without = (key) => {
    const value = structuredClone(valid);
    delete value[key];
    return value;
  };
  const withoutOutput = (key) => {
    const value = structuredClone(valid);
    delete value.output[key];
    return value;
  };
  const cases = [
    {
      name: "unknown capture mode",
      captureMode: "pi-full-v2",
      payload: { session_id: "invalid", ...valid },
      error: /unknown capture mode pi-full-v2/,
    },
    {
      name: "wrong hook event",
      event: "stop",
      payload: { session_id: "invalid", ...valid },
      error: /capture mode pi-full-v1 requires post-tool-use/,
    },
    {
      name: "malformed JSON",
      raw: '{"session_id":',
      error: /pi-full-v1 requires a valid JSON object/,
    },
    {
      name: "array root",
      payload: [],
      error: /pi-full-v1 requires a valid JSON object/,
    },
    {
      name: "missing session id",
      payload: valid,
      error: /session_id must be a non-empty string/,
    },
    {
      name: "wrong session id",
      payload: { session_id: 7, ...valid },
      error: /session_id must be a non-empty string/,
    },
    {
      name: "missing schema version",
      payload: { session_id: "invalid", ...without("schemaVersion") },
      error: /schemaVersion must equal 1/,
    },
    {
      name: "wrong schema version",
      payload: { session_id: "invalid", ...valid, schemaVersion: 2 },
      error: /schemaVersion must equal 1/,
    },
    {
      name: "missing tool call id",
      payload: { session_id: "invalid", ...without("toolCallId") },
      error: /toolCallId must be a non-empty string/,
    },
    {
      name: "wrong tool name",
      payload: { session_id: "invalid", ...valid, toolName: false },
      error: /toolName must be a non-empty string/,
    },
    {
      name: "missing input",
      payload: { session_id: "invalid", ...without("input") },
      error: /input is required/,
    },
    {
      name: "unserializable input",
      raw:
        '{"session_id":"invalid","schemaVersion":1,"toolCallId":"call","toolName":"Read","input":1e999,"output":{"content":null,"details":null,"isError":false}}',
      error: /input must be JSON-serializable/,
    },
    {
      name: "wrong output",
      payload: { session_id: "invalid", ...valid, output: [] },
      error: /output must be an object/,
    },
    {
      name: "missing output content",
      payload: { session_id: "invalid", ...valid, output: withoutOutput("content").output },
      error: /output.content is required/,
    },
    {
      name: "missing output details",
      payload: { session_id: "invalid", ...valid, output: withoutOutput("details").output },
      error: /output.details is required/,
    },
    {
      name: "wrong error flag",
      payload: {
        session_id: "invalid",
        ...valid,
        output: { ...valid.output, isError: "false" },
      },
      error: /output.isError must be a boolean/,
    },
    {
      name: "wrong usage record",
      payload: {
        session_id: "invalid",
        ...valid,
        output: { ...valid.output, usage: { tokens: "12" } },
      },
      error: /output.usage must contain only finite numbers/,
    },
  ];

  for (const fixture of cases) {
    withDataDir((dataDir) => {
      const result = runHook(dataDir, {
        captureMode: fixture.captureMode ?? "pi-full-v1",
        event: fixture.event,
        payload: fixture.payload,
        raw: fixture.raw,
      });
      assert.equal(result.error, undefined, fixture.name);
      assert.equal(result.status, 1, fixture.name);
      assert.equal(result.stdout, "", fixture.name);
      assert.match(result.stderr, fixture.error, fixture.name);
      assert.deepEqual(readRows(dataDir), [], fixture.name);
    });
  }
});
