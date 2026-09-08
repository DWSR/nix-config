import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MANIFEST_SENTINEL = "TASK_4_12_PRIVATE_MANIFEST_SENTINEL";

export const MANIFEST_ALTERATIONS = [
  {
    id: "missing",
    kind: "missing",
    component: "extension backgroundTasks",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.pop();
      delete manifest.extensions.backgroundTasks;
      delete provenance.extensions.backgroundTasks;
    },
  },
  {
    id: "duplicate-logical-identity",
    kind: "duplicate",
    component: "extension manifest",
    alter({ manifest }) {
       manifest.extensionOrder[8] = "agentmemory";
    },
  },
  {
    id: "duplicate-package-identity",
    kind: "duplicate",
    component: "extension manifest",
    alter({ provenance }) {
       provenance.extensions.mcp.package = provenance.extensions.agentmemory.package;
    },
  },
  {
    id: "duplicate-entry-identity",
    kind: "duplicate",
    component: "extension manifest",
    alter({ manifest }) {
       manifest.extensions.mcp.entryPath = manifest.extensions.agentmemory.entryPath;
    },
  },
  {
    id: "unexpected-extension",
    kind: "unexpected",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.push(MANIFEST_SENTINEL);
      manifest.extensions[MANIFEST_SENTINEL] = {
        version: "1.0.0",
        entryPath: "lib/pi-agent/extensions/unexpected.ts",
        license: "MIT",
      };
      provenance.extensions[MANIFEST_SENTINEL] = {
        package: "unexpected-extension",
        version: "1.0.0",
        sourceRef: "repository",
      };
    },
  },
  {
    id: "reordered",
    kind: "reordered",
    component: "extension manifest",
    alter({ manifest }) {
      [manifest.extensionOrder[0], manifest.extensionOrder[1]] = [
        manifest.extensionOrder[1],
        manifest.extensionOrder[0],
      ];
    },
  },
  {
    id: "incompatible-version",
    kind: "incompatible",
    component: "extension plan",
    alter({ manifest }) {
      manifest.extensions.plan.version = "0.49.3";
    },
  },
  {
    id: "incompatible-pi-version",
    kind: "incompatible",
    component: "extension manifest",
    alter({ manifest }) {
      manifest.piVersion = "0.84.0";
    },
  },
  {
    id: "malformed-closed-shape",
    kind: "malformed",
    component: "extension manifest",
    alter({ manifest }) {
      manifest.extensions = [];
    },
  },
  {
    id: "malformed-provenance-shape",
    kind: "malformed",
    component: "extension manifest",
    alter({ provenance }) {
      provenance[MANIFEST_SENTINEL] = true;
    },
  },
  {
    id: "mismatched-provenance-entry",
    kind: "incompatible",
    component: "extension mcp",
    alter({ provenance }) {
      provenance.extensions.mcp.entryPath = "lib/pi-agent/extensions/mcpproxy/package.json";
    },
  },
  {
    id: "incompatible-source-reference",
    kind: "incompatible",
    component: "extension plan",
    alter({ provenance }) {
      provenance.extensions.plan.sourceRef = MANIFEST_SENTINEL;
    },
  },
  {
    id: "incompatible-path",
    kind: "incompatible",
    component: "extension mcp",
    alter({ manifest }) {
      manifest.extensions.mcp.entryPath = "lib/pi-agent/extensions/mcpproxy/package.json";
    },
  },
  {
    id: "incompatible-license",
    kind: "incompatible",
    component: "extension questions",
    alter({ manifest }) {
      manifest.extensions.questions.license = "Apache-2.0";
    },
  },
  {
    id: "path-escape",
    kind: "path",
    component: "extension plan",
    alter({ manifest }) {
      manifest.extensions.plan.entryPath = `../../${MANIFEST_SENTINEL}`;
    },
  },
  {
    id: "non-file-entry",
    kind: "non-file",
    component: "extension subagents",
    alter({ manifest }) {
      manifest.extensions.subagents.entryPath = "lib/node_modules/pi-subagents";
    },
  },
  {
    id: "nested-pi-runtime",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensions.plan.entryPath =
        "lib/node_modules/@earendil-works/pi-coding-agent/index.js";
      provenance.extensions.plan.package = "@earendil-works/pi-coding-agent";
    },
  },
  {
    id: "generic-mcp-proxy",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensions.mcp.entryPath = "lib/node_modules/pi-mcp-adapter/index.ts";
      provenance.extensions.mcp.package = "pi-mcp-adapter";
    },
  },
  {
    id: "code-execution",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.push("codeExecution");
      manifest.extensions.codeExecution = {
        version: "1.0.0",
        entryPath: `lib/node_modules/${MANIFEST_SENTINEL}-code-execution/index.ts`,
        license: "MIT",
      };
      provenance.extensions.codeExecution = {
        package: `${MANIFEST_SENTINEL}-code-execution`,
        version: "1.0.0",
        sourceRef: "registry",
      };
    },
  },
  {
    id: "sieve",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.push("sieve");
      manifest.extensions.sieve = {
        version: "1.0.0",
        entryPath: `lib/node_modules/${MANIFEST_SENTINEL}-sieve/index.ts`,
        license: "MIT",
      };
      provenance.extensions.sieve = {
        package: `${MANIFEST_SENTINEL}-sieve`,
        version: "1.0.0",
        sourceRef: "registry",
      };
    },
  },
  {
    id: "mutable-package-manager",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.push("packageManager");
      manifest.extensions.packageManager = {
        version: "1.0.0",
        entryPath: `lib/node_modules/${MANIFEST_SENTINEL}-package-manager/index.ts`,
        license: "MIT",
      };
      provenance.extensions.packageManager = {
        package: `${MANIFEST_SENTINEL}-package-manager`,
        version: "1.0.0",
        sourceRef: "registry",
      };
    },
  },
  {
    id: "telemetry",
    kind: "forbidden",
    component: "extension manifest",
    alter({ manifest, provenance }) {
      manifest.extensionOrder.push("telemetry");
      manifest.extensions.telemetry = {
        version: "1.0.0",
        entryPath: `lib/node_modules/${MANIFEST_SENTINEL}-telemetry/index.ts`,
        license: "MIT",
      };
      provenance.extensions.telemetry = {
        package: `${MANIFEST_SENTINEL}-telemetry`,
        version: "1.0.0",
        sourceRef: "registry",
      };
    },
  },
  ...["extensions", "skills", "prompts"].map((surface) => ({
    id: `ambient-${surface}`,
    kind: "incompatible",
    component: "extension manifest",
    alter({ manifest }) {
      manifest.loader.discovery[surface] = true;
    },
  })),
];

export function applyManifestAlteration(id, artifacts) {
  const fixture = MANIFEST_ALTERATIONS.find((candidate) => candidate.id === id);
  if (!fixture) throw new Error("unknown extension manifest alteration");
  fixture.alter(artifacts);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [id, packageRoot] = process.argv.slice(2);
  if (!id || !packageRoot) throw new Error("usage: manifest-alterations FIXTURE PACKAGE_ROOT");
  const manifestPath = path.join(packageRoot, "share/pi-agent/extensions.json");
  const provenancePath = path.join(packageRoot, "share/pi-agent/extensions-provenance.json");
  const artifacts = {
    manifest: JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    provenance: JSON.parse(fs.readFileSync(provenancePath, "utf8")),
  };
  applyManifestAlteration(id, artifacts);
  fs.writeFileSync(manifestPath, `${JSON.stringify(artifacts.manifest)}\n`);
  fs.writeFileSync(provenancePath, `${JSON.stringify(artifacts.provenance)}\n`);
}
