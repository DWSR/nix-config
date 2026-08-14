import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const patchPath = path.join(
  repoRoot,
  "overlays/cavemem-pi-full-privacy-v1.patch",
);
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
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 900_000,
};
const redacted = "[REDACTED]";

let runtimeRoot;

function filteredFlakeExpression(body) {
  return `
    let
      source = builtins.path {
        path = ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-cavemem-privacy-test";
        filter = path: type:
          let base = builtins.baseNameOf path;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      integrationPatchNames = [
        "cavemem-pi-full-privacy-v1.patch"
        "cavemem-pi-full-storage-policy-v1.patch"
        "cavemem-pi-full-storage-limit-v1.patch"
      ];
      cavememWithPrivacy = pkgs.cavemem.overrideAttrs (old: {
        patches =
          builtins.filter
            (patch: !(builtins.elem (builtins.baseNameOf (toString patch)) integrationPatchNames))
            (old.patches or [ ])
          ++ [ (source + "/overlays/cavemem-pi-full-privacy-v1.patch") ];
      });
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
        filteredFlakeExpression(`
          pkgs.buildEnv {
            name = "pi-agent-cavemem-privacy-test-runtime";
            paths = [ cavememWithPrivacy pkgs.sqlite ];
          }
        `),
      ],
      commandOptions,
    )
    .trim();
  assert.match(runtimeRoot, /^\/nix\/store\//);
  assert.equal(runtimeRoot.includes("\n"), false);
  return runtimeRoot;
}

function withDataDir(operation) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-cavemem-privacy-"),
  );
  try {
    return operation(dataDir);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

async function withAsyncDataDir(operation) {
  const dataDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-agent-cavemem-privacy-"),
  );
  try {
    return await operation(dataDir);
  } finally {
    fs.rmSync(dataDir, { force: true, recursive: true });
  }
}

function runHook(dataDir, payload, options = {}) {
  const root = getRuntimeRoot();
  return childProcess.spawnSync(
    path.join(root, "bin/cavemem"),
    [
      "hook",
      "run",
      options.event ?? "post-tool-use",
      "--ide",
      "pi",
      "--capture-mode",
      "pi-full-v1",
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CAVEMEM_DATA_DIR: dataDir,
        CAVEMEM_NO_AUTOSTART: "1",
        NO_COLOR: "1",
      },
      input: options.raw ?? JSON.stringify(payload),
      maxBuffer: 64 * 1024 * 1024,
      timeout: options.timeout ?? 15_000,
    },
  );
}

function runLegacyHook(dataDir, payload) {
  const root = getRuntimeRoot();
  return childProcess.spawnSync(
    path.join(root, "bin/cavemem"),
    ["hook", "run", "post-tool-use", "--ide", "pi"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CAVEMEM_DATA_DIR: dataDir,
        CAVEMEM_NO_AUTOSTART: "1",
        NO_COLOR: "1",
      },
      input: JSON.stringify(payload),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
}

function initializeDatabase(dataDir) {
  const root = getRuntimeRoot();
  const result = childProcess.spawnSync(
    path.join(root, "bin/cavemem"),
    ["hook", "run", "session-start", "--ide", "pi"],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        CAVEMEM_DATA_DIR: dataDir,
        CAVEMEM_NO_AUTOSTART: "1",
        NO_COLOR: "1",
      },
      input: JSON.stringify({ session_id: "privacy-wal-reader" }),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.equal(result.error, undefined, "WAL fixture failed to start");
  assert.equal(result.status, 0, "WAL fixture initialization failed");
}

function openWalReader(dataDir) {
  const root = getRuntimeRoot();
  const reader = childProcess.spawn(
    path.join(root, "bin/sqlite3"),
    [path.join(dataDir, "data.db")],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  reader.stdout.setEncoding("utf8");
  reader.stderr.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      reader.kill();
      reject(new Error("WAL reader did not establish its snapshot"));
    }, 5_000);

    const fail = (error) => {
      clearTimeout(timeout);
      reject(error);
    };
    reader.on("error", fail);
    reader.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    reader.on("exit", (status) => {
      if (!stdout.includes("WAL_READER_READY")) {
        fail(new Error(`WAL reader exited ${status}: ${stderr.trim()}`));
      }
    });
    reader.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!stdout.includes("WAL_READER_READY")) return;
      clearTimeout(timeout);
      resolve({
        close: () =>
          new Promise((closeResolve, closeReject) => {
            if (reader.exitCode !== null) {
              closeResolve();
              return;
            }
            reader.once("error", closeReject);
            reader.once("exit", (status) => {
              if (status === 0) closeResolve();
              else closeReject(new Error(`WAL reader close exited ${status}`));
            });
            reader.stdin.end("ROLLBACK;\n.quit\n");
          }),
      });
    });
    reader.stdin.write(
      ".bail on\nBEGIN;\nSELECT count(*) FROM observations;\n.print WAL_READER_READY\n",
    );
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
  assert.equal(result.status, 0, "privacy corpus row query failed");
  return result.stdout.trim() === "" ? [] : JSON.parse(result.stdout);
}

function readSessionIds(dataDir) {
  const database = path.join(dataDir, "data.db");
  if (!fs.existsSync(database)) {
    return [];
  }
  const root = getRuntimeRoot();
  const result = childProcess.spawnSync(
    path.join(root, "bin/sqlite3"),
    ["-json", database, "SELECT id FROM sessions ORDER BY id"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, "privacy corpus session query failed");
  return result.stdout.trim() === ""
    ? []
    : JSON.parse(result.stdout).map(({ id }) => id);
}

function storageEvidence(dataDir) {
  const evidence = [];
  for (const name of ["data.db", "data.db-wal", "data.db-shm"]) {
    const file = path.join(dataDir, name);
    if (fs.existsSync(file)) {
      evidence.push({ name, bytes: fs.readFileSync(file) });
    }
  }
  return evidence;
}

function parseTelemetry(stderr) {
  const lines = stderr.trim().split("\n").filter(Boolean);
  const telemetry = JSON.parse(lines.at(-1));
  assert.equal(Number.isInteger(telemetry.ms), true);
  return telemetry;
}

function normalizeTelemetry(stderr) {
  const telemetry = parseTelemetry(stderr);
  return { hook: telemetry.hook, ok: telemetry.ok };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fullPayload(sessionId, input, content = null, details = null) {
  return {
    session_id: sessionId,
    schemaVersion: 1,
    toolCallId: `call-${sessionId}`,
    toolName: "PrivacyProbe",
    input,
    output: {
      content,
      details,
      isError: false,
    },
  };
}

function expectedStoredEnvelope(payload) {
  return {
    schemaVersion: payload.schemaVersion,
    toolCallId: payload.toolCallId,
    toolName: payload.toolName,
    input: payload.input,
    output: payload.output,
  };
}

function nestedValue(depth, leaf, kind) {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) {
    if (kind === "array" || (kind === "mixed" && index % 2 === 0)) {
      value = [value];
    } else {
      value = { next: value };
    }
  }
  return value;
}

function assertSuccessfulHook(result) {
  assert.equal(result.error, undefined, "privacy hook process failed to start");
  assert.equal(result.status, 0, "privacy hook returned a failure status");
  assert.equal(result.stdout, "", "privacy hook wrote protocol output");
  assert.deepEqual(normalizeTelemetry(result.stderr), {
    hook: "post-tool-use",
    ok: true,
  });
}

function assertNoSourceValues(values, result, files, row) {
  const textEvidence = [result.stdout, result.stderr, row.content, row.metadata];
  for (const value of values) {
    for (const evidence of textEvidence) {
      assert.equal(
        evidence.includes(value),
        false,
        "privacy evidence contains a source value",
      );
    }
    const needle = Buffer.from(value);
    for (const file of files) {
      assert.equal(
        file.bytes.includes(needle),
        false,
        `${file.name} contains a source value`,
      );
    }
  }
}

const normalizedSensitiveEntries = [
  ["Access Key", "structured-access-key-sentinel"],
  ["ACCESS_KEY_ID", "structured-access-key-id-sentinel"],
  ["access-token", "structured-access-token-sentinel"],
  ["api.key", "structured-api-key-sentinel"],
  ["Auth Token", "structured-auth-token-sentinel"],
  ["Author_ization", "structured-authorization-sentinel"],
  ["CLIENT SECRET", "structured-client-secret-sentinel"],
  ["credential", "structured-credential-sentinel"],
  ["CREDENTIALS", "structured-credentials-sentinel"],
  ["id.token", "structured-id-token-sentinel"],
  ["pass-phrase", "structured-passphrase-sentinel"],
  ["pass_wd", "structured-passwd-sentinel"],
  ["Pass Word", "structured-password-sentinel"],
  ["private.key", "structured-private-key-sentinel"],
  ["Proxy Authorization", "structured-proxy-authorization-sentinel"],
  ["refresh_token", "structured-refresh-token-sentinel"],
  ["SEC-RET", "structured-secret-sentinel"],
  ["to ken", "structured-token-sentinel"],
];

const providerTokens = [
  `ghp_${"A".repeat(20)}`,
  `gho_${"B".repeat(20)}`,
  `ghu_${"C".repeat(20)}`,
  `ghs_${"D".repeat(20)}`,
  `ghr_${"E".repeat(20)}`,
  `github_pat_${"F".repeat(20)}`,
  `shpat_${"G".repeat(20)}`,
  `xoxb-${"H".repeat(20)}`,
  `xoxa-${"I".repeat(20)}`,
  `xoxp-${"J".repeat(20)}`,
  `xoxr-${"K".repeat(20)}`,
  `xoxs-${"L".repeat(20)}`,
  `glpat-${"M".repeat(20)}`,
  `sk-${"N".repeat(20)}`,
  `sk-proj-${"O".repeat(20)}`,
  `AKIA${"P".repeat(16)}`,
];

const jwt =
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJqd3Qtc2VudGluZWwifQ.c2lnbmF0dXJlLXNlbnRpbmVs";

test("privacy patch remains an independently composed hook-only patch", () => {
  const patch = fs.readFileSync(patchPath, "utf8");
  const addedCode = patch
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .join("\n");
  const changedPaths = [
    ...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm),
  ].map((match) => [match[1], match[2]]);

  assert.deepEqual(changedPaths, [
    [
      "packages/hooks/src/handlers/post-tool-use.ts",
      "packages/hooks/src/handlers/post-tool-use.ts",
    ],
  ]);
  assert.doesNotMatch(
    addedCode,
    /JSON\.parse|yaml|embedding|allEmbeddings|timeline\(|process\.env|CAVEMEM_PI_FULL_PRIVACY/i,
  );
  assert.doesNotMatch(
    addedCode,
    /\.replace(?:All)?\(|new RegExp|exactRedactionValues|runtimeRedaction/i,
  );
  assert.match(addedCode, /cursor \+= 1/);
});

test("pi-full-v1 removes the finite leak corpus from rows and SQLite evidence", async () => {
  const metadataToolName = "Bearer metadata-bearer-sentinel";
  const metadataToolCallId = `ghp_${"R".repeat(20)}`;
  const structured = Object.fromEntries(
    normalizedSensitiveEntries.map(([key, value], index) => [
      key,
      index % 2 === 0 ? { nested: value } : [value],
    ]),
  );
  const sourceValues = [
    ...normalizedSensitiveEntries.map(([, value]) => value),
    ...providerTokens,
    jwt,
    "private-closed-sentinel",
    "private-open-sentinel",
    "private-malformed-sentinel",
    "nested-private-outer-sentinel",
    "nested-private-inner-sentinel",
    "nested-private-tail-sentinel",
    "nested-private-unclosed-sentinel",
    "nested-private-malformed-sentinel",
    "nested-private-malformed-close-sentinel",
    "basic-auth-sentinel",
    "bearer-auth-sentinel",
    "pem-closed-sentinel",
    "pem-algorithm-sentinel",
    "pem-open-sentinel",
    "pem-malformed-sentinel",
    "dns-user:password",
    "ipv4-user;scope:password",
    "ipv6-user:password",
    "first-user@last-user:password",
    "paren-user:password",
    "zone-user:zone-secret",
    "first-zone@scope-user;role:zone-secret",
    "metadata-bearer-sentinel",
    metadataToolCallId,
    "square-dns-user:square-dns-secret",
    "square-ipv4-user:square-ipv4-secret",
    "square-ipv6-user:square-ipv6-secret",
    "square-dns-path-user:square-dns-path-secret",
    "square-ipv6-path-user:square-ipv6-path-secret",
    "pem-trailing-space-sentinel",
    "pem-double-begin-space-sentinel",
    "pem-double-label-space-sentinel",
    "pem-lowercase-label-sentinel",
    "pem-nested-outer-sentinel",
    "pem-nested-inner-sentinel",
    "pem-nested-tail-sentinel",
    "pem-missing-separator-sentinel",
  ];
  const lexical = {
    closedPrivate:
      "before <private>private-closed-sentinel</private> after",
    openPrivate: "before <private>private-open-sentinel",
    malformedPrivate: "before <private\nprivate-malformed-sentinel",
    nestedPrivate:
      "before <private>nested-private-outer-sentinel <private>nested-private-inner-sentinel</private> nested-private-tail-sentinel</private> after",
    nestedUnclosedPrivate:
      "before <private>nested-private-outer-sentinel <private>nested-private-inner-sentinel</private> nested-private-unclosed-sentinel",
    nestedMalformedPrivate:
      "before <private>nested-private-outer-sentinel <private\nnested-private-malformed-sentinel</private> nested-private-tail-sentinel</private> after",
    nestedMalformedCloser:
      "before <private>nested-private-outer-sentinel <private>nested-private-inner-sentinel</private\nnested-private-malformed-close-sentinel</private> after",
    basic: "  Basic basic-auth-sentinel  ",
    bearer: "Bearer bearer-auth-sentinel",
    providerTokens,
    embeddedProvider: `before ${providerTokens[0]} after`,
    jwt,
    closedPem:
      "before\n-----BEGIN PRIVATE KEY-----\npem-closed-sentinel\n-----END PRIVATE KEY-----\nafter",
    algorithmPem:
      "before\n-----BEGIN ED25519 PRIVATE KEY-----\npem-algorithm-sentinel\n-----END ED25519 PRIVATE KEY-----\nafter",
    openPem:
      "before\n-----BEGIN OPENSSH PRIVATE KEY-----\npem-open-sentinel",
    malformedPem:
      "before\n-----BEGIN EC PRIVATE KEY---\npem-malformed-sentinel",
    dnsUrl: "https://dns-user:password@example.com/path",
    ipv4Url: "http://ipv4-user;scope:password@192.0.2.10:8080/path",
    ipv6Url: "ssh://ipv6-user:password@[2001:db8::10]:22/path",
    lastAtUrl: "https://first-user@last-user:password@example.test/path",
    parenthesizedUrl: "(https://paren-user:password@example.test)",
    scopedIpv6Url:
      "https://zone-user:zone-secret@[fe80::1%25en0]:8443/p",
    scopedIpv6LastAtUrl:
      "https://first-zone@scope-user;role:zone-secret@[fe80::2%25en1]/p",
    squareDnsPathless:
      "[https://square-dns-user:square-dns-secret@example.test]",
    squareIpv4Pathless:
      "[http://square-ipv4-user:square-ipv4-secret@192.0.2.44:8443]",
    squareIpv6Pathless:
      "[https://square-ipv6-user:square-ipv6-secret@[2001:db8::44]]",
    squareDnsPath:
      "[https://square-dns-path-user:square-dns-path-secret@example.test/p]",
    squareIpv6Path:
      "[https://square-ipv6-path-user:square-ipv6-path-secret@[2001:db8::45]/p]",
    malformedPemTrailingSpace:
      "before\n-----BEGIN PRIVATE KEY -----\npem-trailing-space-sentinel",
    malformedPemDoubleBeginSpace:
      "before\n-----BEGIN  RSA PRIVATE KEY-----\npem-double-begin-space-sentinel",
    malformedPemDoubleLabelSpace:
      "before\n-----BEGIN RSA  PRIVATE KEY-----\npem-double-label-space-sentinel",
    malformedPemLowercaseLabel:
      "before\n-----BEGIN private key-----\npem-lowercase-label-sentinel",
    nestedSameLabelPem:
      "before\n-----BEGIN RSA PRIVATE KEY-----\n" +
      "pem-nested-outer-sentinel\n" +
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "pem-nested-inner-sentinel\n" +
      "-----END RSA PRIVATE KEY-----\n" +
      "pem-nested-tail-sentinel\n" +
      "-----END RSA PRIVATE KEY-----\nafter",
    malformedPemMissingSeparator:
      "before\n-----BEGINPRIVATE KEY-----\n" +
      "pem-missing-separator-sentinel\nafter",
  };
  const payload = {
    ...fullPayload(
      "privacy-leak-corpus",
      { nested: [{ deeper: { structured } }] },
      lexical,
      { retained: "ordinary detail" },
    ),
    toolCallId: metadataToolCallId,
    toolName: metadataToolName,
  };

  await withAsyncDataDir(async (dataDir) => {
    initializeDatabase(dataDir);
    const walReader = await openWalReader(dataDir);
    try {
      const result = runHook(dataDir, payload);
      assertSuccessfulHook(result);
      const files = storageEvidence(dataDir);
      assert.deepEqual(
        files.map((file) => file.name),
        ["data.db", "data.db-wal", "data.db-shm"],
      );

      const rows = readRows(dataDir);
      assert.equal(rows.length, 1);
      assertNoSourceValues(sourceValues, result, files, rows[0]);

      const stored = JSON.parse(rows[0].content);
      for (const [key] of normalizedSensitiveEntries) {
        assert.equal(stored.input.nested[0].deeper.structured[key], redacted);
      }
      assert.equal(stored.output.content.closedPrivate, "before  after");
      assert.equal(stored.output.content.openPrivate, "before ");
      assert.equal(stored.output.content.malformedPrivate, "before ");
      assert.equal(stored.output.content.nestedPrivate, "before  after");
      assert.equal(stored.output.content.nestedUnclosedPrivate, "before ");
      assert.equal(stored.output.content.nestedMalformedPrivate, "before ");
      assert.equal(stored.output.content.nestedMalformedCloser, "before ");
      assert.equal(stored.output.content.basic, redacted);
      assert.equal(stored.output.content.bearer, redacted);
      assert.deepEqual(
        stored.output.content.providerTokens,
        providerTokens.map(() => redacted),
      );
      assert.equal(
        stored.output.content.embeddedProvider,
        `before ${redacted} after`,
      );
      assert.equal(stored.output.content.jwt, redacted);
      assert.equal(
        stored.output.content.closedPem,
        `before\n${redacted}\nafter`,
      );
      assert.equal(
        stored.output.content.algorithmPem,
        `before\n${redacted}\nafter`,
      );
      assert.equal(stored.output.content.openPem, `before\n${redacted}`);
      assert.equal(stored.output.content.malformedPem, `before\n${redacted}`);
      assert.equal(
        stored.output.content.dnsUrl,
        `https://${redacted}@example.com/path`,
      );
      assert.equal(
        stored.output.content.ipv4Url,
        `http://${redacted}@192.0.2.10:8080/path`,
      );
      assert.equal(
        stored.output.content.ipv6Url,
        `ssh://${redacted}@[2001:db8::10]:22/path`,
      );
      assert.equal(
        stored.output.content.lastAtUrl,
        `https://${redacted}@example.test/path`,
      );
      assert.equal(
        stored.output.content.parenthesizedUrl,
        `(https://${redacted}@example.test)`,
      );
      assert.equal(
        stored.output.content.scopedIpv6Url,
        `https://${redacted}@[fe80::1%25en0]:8443/p`,
      );
      assert.equal(
        stored.output.content.scopedIpv6LastAtUrl,
        `https://${redacted}@[fe80::2%25en1]/p`,
      );
      assert.equal(
        stored.output.content.squareDnsPathless,
        `[https://${redacted}@example.test]`,
      );
      assert.equal(
        stored.output.content.squareIpv4Pathless,
        `[http://${redacted}@192.0.2.44:8443]`,
      );
      assert.equal(
        stored.output.content.squareIpv6Pathless,
        `[https://${redacted}@[2001:db8::44]]`,
      );
      assert.equal(
        stored.output.content.squareDnsPath,
        `[https://${redacted}@example.test/p]`,
      );
      assert.equal(
        stored.output.content.squareIpv6Path,
        `[https://${redacted}@[2001:db8::45]/p]`,
      );
      assert.equal(
        stored.output.content.malformedPemTrailingSpace,
        `before\n${redacted}`,
      );
      assert.equal(
        stored.output.content.malformedPemDoubleBeginSpace,
        `before\n${redacted}`,
      );
      assert.equal(
        stored.output.content.malformedPemDoubleLabelSpace,
        `before\n${redacted}`,
      );
      assert.equal(
        stored.output.content.malformedPemLowercaseLabel,
        `before\n${redacted}`,
      );
      assert.equal(
        stored.output.content.nestedSameLabelPem,
        `before\n${redacted}`,
      );
      assert.equal(
        stored.output.content.malformedPemMissingSeparator,
        `before\n${redacted}`,
      );
      assert.equal(stored.toolName, redacted);
      assert.equal(stored.toolCallId, redacted);
      assert.deepEqual(JSON.parse(rows[0].metadata), {
        tool: redacted,
        captureMode: "pi-full-v1",
        schemaVersion: 1,
        toolCallId: redacted,
      });
      assert.equal(rows[0].metadata.includes("sentinel"), false);
    } finally {
      await walReader.close();
    }
  });
});

test("pi-full-v1 leaves opaque strings and non-sensitive keys byte-identical", () => {
  const opaque = {
    embeddedJson:
      '{"password":"opaque-json-value","authorization":"Bearer opaque-json-auth"}',
    yaml: "password: opaque-yaml-value\nauthorization: Bearer opaque-yaml-auth",
    environment: "PASSWORD=opaque-env-value\nAPI_KEY=opaque-env-api-key",
    shell:
      'export PASSWORD=opaque-shell-value; API_KEY="opaque-shell-api-key" command',
    source:
      'const password = "opaque-source-value"; const endpoint=https://user:pass@example.test/path;',
    quotedSourceUrl:
      'const endpoint = "https://user:pass@example.test/path";',
    declaration:
      "interface Credentials { password: string; token?: string }",
    prose:
      "A password and secret token are ordinary words, and Bearer tokens are discussed here.",
    query:
      "https://example.test/path?token=opaque-query-token&password=opaque-query-password",
    pathAdjacent:
      "prefix/https://user:pass@example.test/path",
    email: "user:pass@example.test",
    privateLike: "before <privately>ordinary text</privately> after",
    publicPem:
      "-----BEGIN CERTIFICATE-----\nordinary-certificate\n-----END CERTIFICATE-----",
    malformedBracketUrls: [
      "https://user:pass@[fe80::1%en0]:8443/p",
      "https://user:pass@[fe80::1%25]:8443/p",
      "https://user:pass@[fe80::1%25en%ZZ]:8443/p",
      "https://user:pass@[fe80::1%25en0:8443/p",
      '"https://user:pass@[fe80::1%25en0]:8443/p"',
    ],
    squareBracketBoundaryFalsePositives: [
      "prefix/[https://user:pass@example.test]",
      "source=[https://user:pass@example.test]",
      '"[https://user:pass@example.test]"',
      "[user:pass@example.test]",
    ],
    malformedPemBoundaryFalsePositives: [
      "ordinary -----BEGIN  PRIVATE KEY----- prose",
      'const pem = "-----BEGIN PRIVATE KEY -----";',
      "-----BEGIN PRIVATE KEY MATERIAL-----\nordinary prose",
      "  -----BEGIN private key-----\nindented source text",
    ],
    nearMissTokens: [
      `ghp_${"A".repeat(19)}`,
      `github_pat_${"B".repeat(19)}`,
      `shpat_${"C".repeat(19)}`,
      `xoxb-${"D".repeat(19)}`,
      `glpat-${"E".repeat(19)}`,
      `sk-${"F".repeat(19)}`,
      `AKIA${"G".repeat(15)}`,
      "eyJhbGciOiJIUzI1NiJ9.only-two-segments",
      "eyJhbGciOiJIUzI1NiJ9.has.four.segments",
    ],
  };
  const payload = fullPayload(
    "privacy-false-positive-corpus",
    {
      opaque,
      nonSensitive: {
        monkey: "banana",
        secretary: "office",
        tokenCount: 4,
        passwordHint: "unchanged",
        "pass\u00a0word": "unicode whitespace is not normalized",
        "api/key": "slash is not normalized",
      },
    },
    [opaque, "ordinary output"],
    { opaque },
  );
  payload.output.usage = { input: 12, output: 34.5 };
  const expected = JSON.stringify(expectedStoredEnvelope(payload));

  withDataDir((dataDir) => {
    const result = runHook(dataDir, payload);
    assertSuccessfulHook(result);
    const rows = readRows(dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].content, expected);
  });
});

test("pi-full-v1 unknown-field diagnostics are constant within each scope", async () => {
  const envelopeFields = [
    `ghp_${"S".repeat(20)}`,
    `github_pat_${"T".repeat(20)}`,
  ];
  const outputFields = [
    `shpat_${"U".repeat(20)}`,
    `glpat-${"V".repeat(20)}`,
  ];
  const discardedValues = [
    "unknown-field-value-sentinel-one",
    "unknown-field-value-sentinel-two",
  ];

  await withAsyncDataDir(async (dataDir) => {
    initializeDatabase(dataDir);
    const walReader = await openWalReader(dataDir);
    try {
      const seed = runHook(
        dataDir,
        fullPayload("privacy-unknown-field-seed", { retained: true }),
      );
      assertSuccessfulHook(seed);

      const valid = fullPayload("privacy-unknown-field", { retained: true });
      const fixtures = [
        {
          fields: envelopeFields.slice(0, 1),
          payload: {
            ...valid,
            [envelopeFields[0]]: discardedValues[0],
          },
          scope: "envelope",
        },
        {
          fields: envelopeFields,
          payload: {
            ...valid,
            [envelopeFields[0]]: discardedValues[0],
            [envelopeFields[1]]: discardedValues[1],
          },
          scope: "envelope",
        },
        {
          fields: outputFields.slice(0, 1),
          payload: {
            ...valid,
            output: {
              ...valid.output,
              [outputFields[0]]: discardedValues[0],
            },
          },
          scope: "output",
        },
        {
          fields: outputFields,
          payload: {
            ...valid,
            output: {
              ...valid.output,
              [outputFields[0]]: discardedValues[0],
              [outputFields[1]]: discardedValues[1],
            },
          },
          scope: "output",
        },
      ];
      const results = fixtures.map((fixture) => ({
        ...fixture,
        result: runHook(dataDir, fixture.payload),
      }));
      const files = storageEvidence(dataDir);
      assert.deepEqual(
        files.map((file) => file.name),
        ["data.db", "data.db-wal", "data.db-shm"],
      );
      assert.ok(files.every((file) => file.bytes.length > 0));
      const rows = readRows(dataDir);
      assert.equal(rows.length, 1);

      for (const fixture of results) {
        assert.equal(fixture.result.error, undefined);
        assert.equal(fixture.result.status, 1);
        assert.equal(fixture.result.stdout, "");
        const diagnostic = parseTelemetry(fixture.result.stderr).error;
        assert.equal(
          diagnostic,
          `pi-full-v1 unknown-field rule failed at ${fixture.scope}`,
        );
        assertNoSourceValues(
          [...fixture.fields, ...discardedValues],
          fixture.result,
          files,
          rows[0],
        );
      }
      assert.equal(
        parseTelemetry(results[0].result.stderr).error,
        parseTelemetry(results[1].result.stderr).error,
      );
      assert.equal(
        parseTelemetry(results[2].result.stderr).error,
        parseTelemetry(results[3].result.stderr).error,
      );
    } finally {
      await walReader.close();
    }
  });
});

test("pi-full-v1 rejects identifiers emptied by redaction without partial state", async () => {
  const fixtures = [
    {
      field: "toolName",
      sentinel: "private-only-tool-name-sentinel",
    },
    {
      field: "toolCallId",
      sentinel: "private-only-tool-call-id-sentinel",
    },
  ];

  for (const fixture of fixtures) {
    await withAsyncDataDir(async (dataDir) => {
      initializeDatabase(dataDir);
      const walReader = await openWalReader(dataDir);
      try {
        const seed = runHook(
          dataDir,
          fullPayload(`privacy-private-identifier-seed-${fixture.field}`, {
            retained: true,
          }),
        );
        assertSuccessfulHook(seed);
        const baselineRows = readRows(dataDir);
        const baselineSessionIds = readSessionIds(dataDir);
        const payload = fullPayload(
          `privacy-private-identifier-${fixture.field}`,
          { retained: true },
        );
        payload[fixture.field] = `<private>${fixture.sentinel}</private>`;

        const result = runHook(dataDir, payload);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(
          parseTelemetry(result.stderr).error,
          `pi-full-v1 privacy canonical rule failed at ${fixture.field}`,
        );

        const files = storageEvidence(dataDir);
        assert.deepEqual(
          files.map((file) => file.name),
          ["data.db", "data.db-wal", "data.db-shm"],
        );
        assert.ok(files.every((file) => file.bytes.length > 0));
        assert.deepEqual(readRows(dataDir), baselineRows);
        assert.deepEqual(readSessionIds(dataDir), baselineSessionIds);
        assertNoSourceValues([fixture.sentinel], result, files, baselineRows[0]);
      } finally {
        await walReader.close();
      }
    });
  }
});

test("pi-full-v1 rejects sensitive usage keys before redaction can invalidate the schema", async () => {
  const fixtures = [
    { input: 602_413, token: 731_923 },
    { input: 634_991, "Pass Word": 845_117, secret: 916_321 },
  ];

  for (const [index, usage] of fixtures.entries()) {
    await withAsyncDataDir(async (dataDir) => {
      initializeDatabase(dataDir);
      const walReader = await openWalReader(dataDir);
      try {
        const seed = runHook(
          dataDir,
          fullPayload(`privacy-usage-seed-${index}`, { retained: true }),
        );
        assertSuccessfulHook(seed);
        const baselineRows = readRows(dataDir);
        const baselineSessionIds = readSessionIds(dataDir);
        const payload = fullPayload(`privacy-sensitive-usage-${index}`, {
          retained: true,
        });
        payload.output.usage = usage;

        const result = runHook(dataDir, payload);
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.equal(
          parseTelemetry(result.stderr).error,
          "pi-full-v1 privacy usage rule failed at output.usage",
        );

        const files = storageEvidence(dataDir);
        assert.deepEqual(
          files.map((file) => file.name),
          ["data.db", "data.db-wal", "data.db-shm"],
        );
        assert.ok(files.every((file) => file.bytes.length > 0));
        assert.deepEqual(readRows(dataDir), baselineRows);
        assert.deepEqual(readSessionIds(dataDir), baselineSessionIds);
        const sourceValues = Object.values(usage).map(String);
        assertNoSourceValues(sourceValues, result, files, baselineRows[0]);
      } finally {
        await walReader.close();
      }
    });
  }
});

test(
  "pi-full-v1 iteratively redacts deep canonical arrays and objects",
  { timeout: 60_000 },
  async () => {
    const depth = 4_000;
    const deepSecret = "deep-sensitive-key-sentinel";
    const deepToken = `ghp_${"Q".repeat(20)}`;
    const wideInput = Array.from({ length: 32_768 }, (_, index) =>
      index === 32_767 ? `before ${deepToken} after` : `width-${index}`,
    );
    const wideExpected = [...wideInput];
    wideExpected[32_767] = `before ${redacted} after`;
    const input = {
      arrays: nestedValue(depth, { retained: "deep-array-tail" }, "array"),
      objects: nestedValue(
        depth,
        { "Pass Word": { nested: deepSecret } },
        "object",
      ),
      mixed: nestedValue(depth, `before ${deepToken} after`, "mixed"),
      wide: wideInput,
    };
    const expectedInput = {
      arrays: nestedValue(depth, { retained: "deep-array-tail" }, "array"),
      objects: nestedValue(depth, { "Pass Word": redacted }, "object"),
      mixed: nestedValue(depth, `before ${redacted} after`, "mixed"),
      wide: wideExpected,
    };
    const payload = fullPayload("privacy-deep-canonical", input);
    const expected = JSON.stringify(
      expectedStoredEnvelope(fullPayload("privacy-deep-canonical", expectedInput)),
    );

    await withAsyncDataDir(async (dataDir) => {
      initializeDatabase(dataDir);
      const walReader = await openWalReader(dataDir);
      try {
        const result = runHook(dataDir, payload, { timeout: 30_000 });
        assert.equal(
          result.stderr.includes("Maximum call stack size exceeded"),
          false,
          "privacy traversal exposed a raw stack-overflow diagnostic",
        );
        assert.equal(result.status, 0, result.stderr);
        assertSuccessfulHook(result);
        const files = storageEvidence(dataDir);
        assert.deepEqual(
          files.map((file) => file.name),
          ["data.db", "data.db-wal", "data.db-shm"],
        );
        assert.ok(files.every((file) => file.bytes.length > 0));
        const rows = readRows(dataDir);
        assert.equal(rows.length, 1);
        assertNoSourceValues([deepSecret, deepToken], result, files, rows[0]);
        assert.equal(rows[0].content, expected);
      } finally {
        await walReader.close();
      }
    });
  },
);

test(
  "pi-full-v1 reports native stringify depth failures without values or partial rows",
  { timeout: 60_000 },
  async () => {
    const depth = 20_000;
    const sentinel = "native-stringify-depth-sentinel";
    const nested = `${"[".repeat(depth)}${JSON.stringify(sentinel)}${"]".repeat(depth)}`;
    const raw =
      '{"session_id":"privacy-stringify-depth","schemaVersion":1,' +
      '"toolCallId":"call-stringify-depth","toolName":"PrivacyProbe",' +
      `"input":${nested},` +
      '"output":{"content":null,"details":null,"isError":false}}';

    await withAsyncDataDir(async (dataDir) => {
      initializeDatabase(dataDir);
      const walReader = await openWalReader(dataDir);
      try {
        const seed = runHook(
          dataDir,
          fullPayload("privacy-stringify-depth-seed", { retained: true }),
        );
        assertSuccessfulHook(seed);
        const result = runHook(dataDir, null, { raw, timeout: 30_000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(
          result.stderr,
          /pi-full-v1 privacy stringify rule failed at envelope/,
        );
        assert.equal(result.stderr.includes("Maximum call stack size exceeded"), false);
        const files = storageEvidence(dataDir);
        assert.deepEqual(
          files.map((file) => file.name),
          ["data.db", "data.db-wal", "data.db-shm"],
        );
        assert.ok(files.every((file) => file.bytes.length > 0));
        const rows = readRows(dataDir);
        assert.equal(rows.length, 1);
        assertNoSourceValues([sentinel], result, files, rows[0]);
      } finally {
        await walReader.close();
      }
    });
  },
);

test(
  "malformed private and PEM regions scan scaled inputs within a fixed timeout",
  { timeout: 45_000 },
  () => {
    const durations = [];
    for (const size of [128 * 1024, 512 * 1024, 2 * 1024 * 1024]) {
      const privateSentinel = `private-scale-sentinel-${size}`;
      const nestedSentinel = `nested-private-scale-sentinel-${size}`;
      const pemSentinel = `pem-scale-sentinel-${size}`;
      const payload = fullPayload(
        `privacy-scale-${size}`,
        {
          malformedPrivate: `<private>${"a".repeat(size)}${privateSentinel}`,
          nestedPrivate:
            `${"<private>".repeat(Math.ceil(size / 64))}` +
            `${"b".repeat(size)}${nestedSentinel}`,
          malformedPem:
            "-----BEGIN RSA PRIVATE KEY-----\n" +
            `${"c".repeat(size)}${pemSentinel}`,
        },
      );

      withDataDir((dataDir) => {
        const started = performance.now();
        const result = runHook(dataDir, payload, { timeout: 10_000 });
        durations.push(performance.now() - started);
        assertSuccessfulHook(result);
        const files = storageEvidence(dataDir);
        const rows = readRows(dataDir);
        assert.equal(rows.length, 1);
        assertNoSourceValues(
          [privateSentinel, nestedSentinel, pemSentinel],
          result,
          files,
          rows[0],
        );
      });
    }

    assert.ok(durations.every((duration) => duration < 10_000));
    for (let index = 1; index < durations.length; index += 1) {
      assert.ok(
        durations[index] <= durations[index - 1] * 8 + 1_000,
        "scaled malformed scan exceeded the bounded growth allowance",
      );
    }
  },
);

test("privacy-composed package preserves the Task 3.1 legacy golden", () => {
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
    const result = runLegacyHook(dataDir, payload);
    assert.equal(result.error, undefined);
    const rows = readRows(dataDir);
    assert.equal(rows.length, 1);
    const row = rows[0];
    const manifest = {
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
    assert.deepEqual(manifest, golden);
  });
});
