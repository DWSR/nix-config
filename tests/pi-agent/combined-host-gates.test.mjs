import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertCommandPackageIdentity,
  assertPublishableClosureSafety,
  runCombinedHostGates,
} from "./harness.mjs";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const expectedGates = [
  "host-render-personal",
  "host-render-shopify",
  "host-common-surface",
  "host-provider-deltas",
  "static-private-shopify-source",
  "static-mutable-source-urls",
  "static-credential-sentinels",
  "static-literal-secrets",
  "static-licenses",
  "unsupported-system",
];

test("combined host and static gates pass as one deterministic report", () => {
  const first = runCombinedHostGates();
  const second = runCombinedHostGates();

  assert.deepEqual(first, second);
  assert.equal(first.generation, "pi-agent-acceptance-v1");
  assert.deepEqual(first.gates.map(({ name }) => name), expectedGates);
  assert.ok(first.gates.every(({ status }) => status === "pass"));
  assert.ok(first.gates.every(({ evidence }) => evidence.length > 0));
});

test("the combined report is available through the existing runner without flake registration", () => {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(testsDir, "run.js"), "--combined"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    },
  );

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const report = JSON.parse(result.stdout);
  assert.equal(report.generation, "pi-agent-acceptance-v1");
  assert.deepEqual(report.gates.map(({ name }) => name), expectedGates);
});

function makePublishableRoot(entries) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-publishable-"));
  const roots = path.join(root, "roots");
  fs.mkdirSync(roots);

  for (const [index, entry] of entries.entries()) {
    const output = path.join(root, entry.name);
    fs.mkdirSync(output);
    for (const [relativePath, content] of Object.entries(entry.files)) {
      const file = path.join(output, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      if (entry.executable === relativePath) fs.chmodSync(file, 0o700);
    }
    fs.symlinkSync(output, path.join(roots, String(index)));
  }

  return root;
}

test("closure gates scan every manifest-listed publishable output, not only host summaries", () => {
  const root = makePublishableRoot([
    { name: "summary-output", files: { "README.md": "safe\n" } },
    {
      name: "omitted-summary-output",
      files: { "private.js": "https://github.shopify.com/private-source\n" },
    },
  ]);

  try {
    assert.throws(() => assertPublishableClosureSafety([root]), /private Shopify source/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closure gates require every declared publishable artifact in the manifest", () => {
  const root = makePublishableRoot([{ name: "declared-output", files: { "README.md": "safe\n" } }]);
  const omitted = path.join(root, "omitted-output");
  fs.mkdirSync(omitted);
  fs.writeFileSync(path.join(omitted, "artifact.js"), "const source = \"safe\";\n");

  try {
    assert.throws(
      () => assertPublishableClosureSafety([root], [omitted]),
      /publishable artifact is missing from the manifest/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("common command gates reject a changed output with the same logical package name", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-command-"));
  const personal = path.join(root, "aaa-pi-agent-reconcile");
  const shopify = path.join(root, "bbb-pi-agent-reconcile");

  try {
    fs.writeFileSync(personal, "#!/bin/sh\nversion=1\n");
    fs.writeFileSync(shopify, "#!/bin/sh\nversion=1\n");
    assert.doesNotThrow(() =>
      assertCommandPackageIdentity({ reconciler: personal }, { reconciler: shopify }),
    );

    fs.writeFileSync(shopify, "#!/bin/sh\nversion=2\n");
    assert.throws(
      () => assertCommandPackageIdentity({ reconciler: personal }, { reconciler: shopify }),
      /command package identity differs: reconciler/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("command gates hash provider-sensitive command outputs instead of skipping them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-command-provider-"));
  const personal = path.join(root, "aaa-pi-agent-launcher-personal");
  const shopify = path.join(root, "bbb-pi-agent-launcher-shopify-gateway");

  try {
    fs.writeFileSync(personal, "#!/bin/sh\nprovider=personal\n");
    fs.writeFileSync(shopify, "#!/bin/sh\nprovider=personal\n");
    assert.doesNotThrow(() =>
      assertCommandPackageIdentity({ launcher: personal }, { launcher: shopify }),
    );

    fs.writeFileSync(shopify, "#!/bin/sh\nprovider=shopify\n");
    assert.throws(
      () => assertCommandPackageIdentity({ launcher: personal }, { launcher: shopify }),
      /command package identity differs: launcher/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("mutable-source gates scan JavaScript, MJS, TypeScript, and executable files", () => {
  const cases = ["source.js", "source.mjs", "source.ts", "bin/probe"];

  for (const relativePath of cases) {
    const root = makePublishableRoot([
      {
        name: "mutable-source-output",
        files: { [relativePath]: `const source = "https://example.test/main/file";\n` },
        executable: relativePath === "bin/probe" ? relativePath : undefined,
      },
    ]);

    try {
      assert.throws(() => assertPublishableClosureSafety([root]), /mutable source URL/, relativePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("closure gates reject symlinked files rather than skipping their contents", () => {
  const root = makePublishableRoot([
    {
      name: "symlink-output",
      files: { "safe.txt": "safe\n" },
    },
  ]);

  try {
    const output = fs.realpathSync(path.join(root, "roots", "0"));
    fs.writeFileSync(path.join(root, "secret.txt"), `Bearer ${"s".repeat(24)}\n`);
    fs.symlinkSync("../secret.txt", path.join(output, "linked.txt"));
    assert.throws(() => assertPublishableClosureSafety([root]), /symlink/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closure gates accept regular hardlinks as files", () => {
  const root = makePublishableRoot([
    {
      name: "hardlink-output",
      files: { "source.txt": "safe\n" },
    },
  ]);

  try {
    const output = fs.realpathSync(path.join(root, "roots", "0"));
    fs.linkSync(path.join(output, "source.txt"), path.join(output, "hardlink.txt"));
    assert.doesNotThrow(() => assertPublishableClosureSafety([root]));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("literal-secret gates scan JavaScript, TypeScript, and executable publishable files", () => {
  const cases = [
    ["source.js", `const token = "Bearer ${"a".repeat(24)}";\n`],
    [
      "source.ts",
      `const key = "-----BEGIN PRIVATE KEY-----\\n${"A".repeat(32)}\\n-----END PRIVATE KEY-----";\n`,
    ],
    ["bin/probe", `#!/bin/sh\nprintf 'Bearer ${"b".repeat(24)}\\n'\n`],
  ];

  for (const [relativePath, content] of cases) {
    const root = makePublishableRoot([
      {
        name: "secret-output",
        files: { [relativePath]: content },
        executable: relativePath === "bin/probe" ? relativePath : undefined,
      },
    ]);

    try {
      assert.throws(() => assertPublishableClosureSafety([root]), /literal secret/, relativePath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});
