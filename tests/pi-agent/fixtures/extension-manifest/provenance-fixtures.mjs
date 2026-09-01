import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const PROVENANCE_SENTINEL = "TASK_4_12_PRIVATE_PROVENANCE_SENTINEL";

export const PROVENANCE_FAILURE_FIXTURES = [
  {
    id: "provenance-root-mismatch",
    kind: "path",
    component: "extension package",
  },
  {
    id: "provenance-missing-entry",
    kind: "missing",
    component: "extension mcp",
  },
  {
    id: "provenance-non-file-entry",
    kind: "non-file",
    component: "extension mcp",
  },
  {
    id: "provenance-component-symlink",
    kind: "path",
    component: "extension mcp",
  },
  {
    id: "provenance-leaf-symlink",
    kind: "path",
    component: "extension mcp",
  },
  {
    id: "provenance-symlink-escape",
    kind: "path",
    component: "extension mcp",
  },
  {
    id: "provenance-digest-drift",
    kind: "digest",
    component: "extension mcp",
  },
  {
    id: "provenance-recomputed-tamper",
    kind: "digest",
    component: "extension mcp",
  },
  {
    id: "provenance-loader-digest-drift",
    kind: "digest",
    component: "extension loader",
  },
];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function rebindProvenance(packageRoot, identityRoot) {
  const manifestPath = path.join(packageRoot, "share/pi-agent/extensions.json");
  const provenancePath = path.join(packageRoot, "share/pi-agent/extensions-provenance.json");
  const manifest = readJson(manifestPath);
  const provenance = readJson(provenancePath);
  provenance.schemaVersion = 2;
  provenance.packageRoot = packageRoot;
  provenance.piVersion = manifest.piVersion;
  provenance.loader = {
    entryPath: manifest.loader.entryPath,
    kind: "regular-file",
    sha256: sha256File(path.join(packageRoot, manifest.loader.entryPath)),
  };
  provenance.extensionOrder = [...manifest.extensionOrder];
  for (const logicalName of manifest.extensionOrder) {
    const entryPath = manifest.extensions[logicalName].entryPath;
    provenance.extensions[logicalName] = {
      ...provenance.extensions[logicalName],
      entryPath,
      kind: "regular-file",
      sha256: sha256File(path.join(packageRoot, entryPath)),
    };
  }
  const rendered = `${JSON.stringify(provenance, null, 2)}\n`;
  fs.writeFileSync(provenancePath, rendered);
  if (identityRoot) {
    fs.mkdirSync(identityRoot, { recursive: true });
    fs.writeFileSync(path.join(identityRoot, "extensions-provenance.json"), rendered);
  }
}

export function prepareProvenanceFixture(packageRoot, identityRoot, sourceIdentityPath) {
  if (!identityRoot || !sourceIdentityPath) {
    throw new Error("fixture identity roots are required");
  }
  for (const relativePath of [
    "lib/pi-agent/extensions/managed-loader.ts",
    "lib/pi-agent/extensions/managed-manifest.ts",
  ]) {
    const file = path.join(packageRoot, relativePath);
    const source = fs.readFileSync(file, "utf8");
    if (source.split(sourceIdentityPath).length !== 2) {
      throw new Error("fixture source identity reference is not exact");
    }
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(
      file,
      source.replace(sourceIdentityPath, path.join(identityRoot, "extensions-provenance.json")),
    );
  }
  fs.chmodSync(
    path.join(packageRoot, "share/pi-agent/extensions-provenance.json"),
    0o644,
  );
  rebindProvenance(packageRoot, identityRoot);
}

function mcpEntry(packageRoot) {
  return path.join(packageRoot, "lib/pi-agent/extensions/mcpproxy/index.ts");
}

export function applyProvenanceFixture(id, packageRoot, sourceRoot) {
  const entry = mcpEntry(packageRoot);
  if (id === "provenance-root-mismatch") {
    const provenancePath = path.join(packageRoot, "share/pi-agent/extensions-provenance.json");
    const provenance = readJson(provenancePath);
    provenance.packageRoot = sourceRoot;
    fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
    return;
  }
  if (id === "provenance-missing-entry") {
    fs.rmSync(entry);
    return;
  }
  if (id === "provenance-non-file-entry") {
    fs.rmSync(entry);
    fs.mkdirSync(entry);
    return;
  }
  if (id === "provenance-component-symlink") {
    const directory = path.dirname(entry);
    const target = `${directory}-target`;
    fs.renameSync(directory, target);
    fs.symlinkSync(path.basename(target), directory, "dir");
    return;
  }
  if (id === "provenance-leaf-symlink") {
    const target = `${entry}.target`;
    fs.renameSync(entry, target);
    fs.symlinkSync(path.basename(target), entry, "file");
    return;
  }
  if (id === "provenance-symlink-escape") {
    if (!sourceRoot) throw new Error("source package root is required");
    fs.rmSync(entry);
    fs.symlinkSync(mcpEntry(sourceRoot), entry, "file");
    return;
  }
  if (id === "provenance-digest-drift") {
    fs.appendFileSync(entry, `\n// ${PROVENANCE_SENTINEL}\n`);
    return;
  }
  if (id === "provenance-recomputed-tamper") {
    fs.appendFileSync(entry, `\n// ${PROVENANCE_SENTINEL}\n`);
    rebindProvenance(packageRoot);
    return;
  }
  if (id === "provenance-loader-digest-drift") {
    fs.appendFileSync(
      path.join(packageRoot, "lib/pi-agent/extensions/managed-loader.ts"),
      `\n// ${PROVENANCE_SENTINEL}\n`,
    );
    return;
  }
  if (id === "provenance-hardlink") {
    fs.linkSync(entry, `${entry}.hardlink-target`);
    return;
  }
  throw new Error("unknown extension provenance fixture");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [operation, packageRoot, firstArgument, secondArgument] = process.argv.slice(2);
  if (!operation || !packageRoot) {
    throw new Error("usage: provenance-fixtures OPERATION PACKAGE_ROOT [SOURCE_ROOT]");
  }
  if (operation === "prepare") {
    prepareProvenanceFixture(packageRoot, firstArgument, secondArgument);
  } else if (operation === "rebind-local") {
    rebindProvenance(packageRoot);
  } else {
    applyProvenanceFixture(operation, packageRoot, firstArgument);
  }
}
