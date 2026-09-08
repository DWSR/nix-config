import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const guidanceDir = path.join(repoRoot, "home-manager/common/pi-agent");
const instructionsPath = path.join(guidanceDir, "instructions.md");
const guidePath = path.join(guidanceDir, "guide.md");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  maxBuffer: 16 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 600_000,
};
const directToolNames = [
  "retrieve_tools",
  "describe_tool",
  "call_tool_read",
  "call_tool_write",
  "call_tool_destructive",
  "read_cache",
];

function nixExpression(body) {
  return `
    let
      source = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "nix-config-pi-agent-guidance-tests";
        filter = sourcePath: type:
          let base = builtins.baseNameOf sourcePath;
          in base != ".git" && base != "result";
      };
      flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString source));
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      guidance = import (source + "/home-manager/common/pi-agent/guidance.nix") { inherit pkgs; };
      modulePath = source + "/home-manager/common/pi-agent/default.nix";
      piPackage = pkgs.writeShellScriptBin "pi" "exit 0";
      manifestPackage = pkgs.writeTextDir "share/pi-agent/extensions.json" "{}";
      enabledEvaluation = pkgs.lib.evalModules {
        modules = [
          modulePath
          {
            programs.pi-agent = {
              enable = true;
              package = piPackage;
              manifests = [
                {
                  package = manifestPackage;
                  relativePath = "share/pi-agent/extensions.json";
                }
              ];
              provider = {
                mode = "personal";
                defaultModel = {
                  provider = "openai";
                  modelId = "gpt-5.6-sol";
                };
              };
            };
          }
        ];
        specialArgs = {
          inherit pkgs;
          piAgentAdvisoryDate = "2026-08-20";
        };
      };
      disabledEvaluation = pkgs.lib.evalModules {
        modules = [ modulePath ];
        specialArgs = {
          inherit pkgs;
          piAgentAdvisoryDate = "2026-08-20";
        };
      };
    in
      ${body}
  `;
}

function evaluateContract() {
  const result = childProcess.spawnSync(
    "nix",
    [
      "eval",
      "--json",
      "--impure",
      "--expr",
      nixExpression(`
        {
          package = toString guidance.package;
          instructionPackage = toString guidance.instructionResource.package;
          instructionRelativePath = guidance.instructionResource.relativePath;
          guidePackage = toString guidance.guideResource.package;
          guideRelativePath = guidance.guideResource.relativePath;
          enabledPackage = toString enabledEvaluation.config.programs.pi-agent.internal.guidancePackage;
          disabled = disabledEvaluation.config.programs.pi-agent.internal.guidancePackage == null;
        }
      `),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function buildGuidance(extraArguments = []) {
  const result = childProcess.spawnSync(
    "nix",
    [
      "build",
      "--no-link",
      "--print-out-paths",
      ...extraArguments,
      "--impure",
      "--expr",
      nixExpression("guidance.package"),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const outputs = result.stdout.trim().split("\n").filter(Boolean);
  assert.equal(outputs.length, 1, result.stdout);
  return outputs[0];
}

function queryStore(output, query) {
  const result = childProcess.spawnSync(
    "nix-store",
    ["--query", query, output],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim().split("\n").filter(Boolean);
}

function rejectGuidanceOverride() {
  const result = childProcess.spawnSync(
    "nix",
    [
      "eval",
      "--json",
      "--impure",
      "--expr",
      nixExpression(`
        let
          evaluation = pkgs.lib.evalModules {
            modules = [
              modulePath
              {
                programs.pi-agent.internal.guidancePackage =
                  pkgs.writeText "host-guidance" "host override";
              }
            ];
            specialArgs = {
              inherit pkgs;
              piAgentAdvisoryDate = "2026-08-20";
            };
          };
        in builtins.deepSeq evaluation.config.programs.pi-agent.internal.guidancePackage true
      `),
    ],
    commandOptions,
  );
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(`${result.stderr}\n${result.stdout}`, /internal\.guidancePackage.*read-only/s);
}

function readSources() {
  return {
    instructions: fs.readFileSync(instructionsPath, "utf8"),
    guide: fs.readFileSync(guidePath, "utf8"),
  };
}

function section(content, heading) {
  const marker = `## ${heading}`;
  const start = content.indexOf(marker);
  assert.notEqual(start, -1, `missing section ${marker}`);
  const end = content.indexOf("\n## ", start + marker.length);
  return content.slice(start, end === -1 ? content.length : end);
}

function bulletCodeNames(content) {
  return [...content.matchAll(/^- `([^`]+)`: /gm)].map((match) => match[1]);
}

function normalizeProse(content) {
  return content.replace(/\s+/g, " ").trim();
}

function enumerateTree(root) {
  const entries = [];

  function visit(absolutePath, relativePath) {
    const stat = fs.lstatSync(absolutePath);
    const type = stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "other";
    entries.push({
      path: relativePath,
      type,
      mode: stat.mode & 0o777,
    });
    if (type === "directory") {
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), relativePath === "." ? name : `${relativePath}/${name}`);
      }
    }
  }

  visit(root, ".");
  return entries;
}

test("Task 6.1 guidance sources and package seam exist", () => {
  for (const file of [instructionsPath, guidePath, path.join(guidanceDir, "guidance.nix")]) {
    assert.equal(fs.existsSync(file), true, `missing ${path.relative(repoRoot, file)}`);
  }
});

test("one immutable package owns both canonical guidance resources", { timeout: 600_000 }, () => {
  const contract = evaluateContract();
  assert.match(contract.package, /^\/nix\/store\//);
  assert.equal(contract.instructionPackage, contract.package);
  assert.equal(contract.guidePackage, contract.package);
  assert.equal(contract.enabledPackage, contract.package);
  assert.equal(contract.instructionRelativePath, "share/pi-agent/instructions.md");
  assert.equal(contract.guideRelativePath, "share/pi-agent/guide.md");
  assert.equal(contract.disabled, true);
  rejectGuidanceOverride();
});

test("built guidance tree, bytes, modes, and empty runtime closure are exact", { timeout: 600_000 }, () => {
  const first = buildGuidance();
  const rebuilt = buildGuidance(["--rebuild"]);
  assert.equal(rebuilt, first);

  const expectedTree = [
    { path: ".", type: "directory", mode: 0o555 },
    { path: "share", type: "directory", mode: 0o555 },
    { path: "share/pi-agent", type: "directory", mode: 0o555 },
    { path: "share/pi-agent/guide.md", type: "file", mode: 0o444 },
    { path: "share/pi-agent/instructions.md", type: "file", mode: 0o444 },
  ];
  assert.deepEqual(enumerateTree(first), expectedTree);

  for (const relativePath of expectedTree.filter(({ type }) => type === "file").map(({ path: file }) => file)) {
    const sourcePath = path.join(guidanceDir, path.basename(relativePath));
    const builtPath = path.join(first, relativePath);
    const source = fs.readFileSync(sourcePath);
    const built = fs.readFileSync(builtPath);
    assert.deepEqual(built, source, `${relativePath} changed during packaging`);
    assert.equal([...built].every((byte) => byte < 0x80), true, `${relativePath} is not ASCII`);
  }

  const combined = expectedTree
    .filter(({ type }) => type === "file")
    .map(({ path: file }) => file)
    .map((relativePath) => fs.readFileSync(path.join(first, relativePath), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    combined,
    /\/nix\/store\/|sk-proj-task-6-1|Bearer\s+[A-Za-z0-9_-]{20,}|token\s*[:=]\s*\S+/i,
  );
  assert.deepEqual(queryStore(first, "--references"), []);
  assert.deepEqual(queryStore(first, "--requisites"), [first]);
});

test("Pi instructions encode memory, MCP, package, Plan, subprocess, and rollback contracts", () => {
  const { instructions } = readSources();
  const memory = section(instructions, "Memory startup");
  const mcpproxy = section(instructions, "mcpproxy");
  const packages = section(instructions, "Packages and extensions");
  const plan = section(instructions, "Plan mode");
  const subprocesses = section(instructions, "Subprocesses");
  const rollback = section(instructions, "Sandbox rollback");
  const packageProse = normalizeProse(packages);
  const planProse = normalizeProse(plan);
  const subprocessProse = normalizeProse(subprocesses);
  const rollbackProse = normalizeProse(rollback);
  const memoryProse = normalizeProse(memory);

  assert.match(memory, /Before any work, verify Obsidian through mcpproxy/i);
  assert.match(memory, /`\{"query":"obsidian list-notes"\}`/);
  assert.match(memoryProse, /returned `name` must begin with `obsidian:`/i);
  assert.match(
    memory,
    /`\{"name":"obsidian:list-notes","args":\{"directory":"memories","limit":1\}\}`/,
  );
  assert.match(memory, /bundled `memory_health` tool/);
  assert.match(memoryProse, /standard authenticated AgentMemory routes/i);
  assert.match(
    memory,
    /`memory_search` to recall prior Pi memory/,
  );
  assert.match(memoryProse, /pass the exact returned name unchanged/i);
  assert.match(memoryProse, /never guess a tool name/i);
  assert.match(
    memoryProse,
    /missing expected prefix or any failed discovery or invocation stops all work/i,
  );

  assert.match(mcpproxy, /sole MCP entrypoint at the managed local `\/mcp` transport/i);
  assert.match(mcpproxy, /discover-then-invoke/i);
  assert.deepEqual(bulletCodeNames(mcpproxy), directToolNames);
  assert.match(mcpproxy, /`call_tool_write` and `call_tool_destructive` require explicit approval/i);
  assert.match(normalizeProse(mcpproxy), /routed reads rely on mcpproxy/i);

  assert.match(packageProse, /immutable and version-pinned/i);
  assert.match(
    packageProse,
    /Do not use `pi install`, `\/pkg`, mutable package installation or update, self-update, or network package mutation\./i,
  );
  assert.match(packageProse, /Nix pins and managed generation together/i);
  assert.match(packageProse, /validation/i);

  assert.match(
    planProse,
    /exactly `read`, `grep`, `find`, `ls`, `plan_mode_question`, and `plan_mode_complete`/i,
  );
  assert.doesNotMatch(plan, /`(?:bash|edit|write|call_tool_read|bg_start|code_refactor_apply)`/i);
  assert.match(planProse, /non-allowlisted.*before effects/i);
  assert.match(planProse, /approval before restoring implementation tools/i);

  assert.match(subprocessProse, /Provider values belong only to root Pi and foreground child Pi/i);
  assert.match(subprocessProse, /credential-scrubbed environment/i);
  assert.match(subprocessProse, /Bash, background tasks, and language servers/i);
  assert.match(subprocessProse, /bounded process-group cleanup/i);

  assert.match(rollbackProse, /`PI_NONO=disabled pi`/);
  assert.match(rollbackProse, /reported unsandboxed fallback/i);
  assert.match(rollbackProse, /not the default/i);
});

test("operator guide covers setup, status, overrides, recovery, updates, and rollback", () => {
  const { guide } = readSources();
  const providers = section(guide, "Provider setup");
  const status = section(guide, "Managed status");
  const sandbox = section(guide, "Sandbox overrides");
  const recovery = section(guide, "Configuration recovery");
  const updates = section(guide, "Extension updates");
  const rollback = section(guide, "Rollback");
  const providerProse = normalizeProse(providers);
  const sandboxProse = normalizeProse(sandbox);
  const recoveryProse = normalizeProse(recovery);
  const updateProse = normalizeProse(updates);
  const rollbackProse = normalizeProse(rollback);
  const statusProse = normalizeProse(status);

  assert.match(providerProse, /personal.*Pi-owned OpenAI authentication/i);
  assert.match(providerProse, /`openai\/gpt-5\.6-sol`.*`xhigh`/i);
  assert.match(providers, /`devx llm-gateway print-token --base`/);
  assert.match(providers, /`devx llm-gateway print-token --key`/);
  assert.match(providerProse, /fixed managed.*base and short-lived token/i);
  assert.match(providerProse, /never persist.*gateway secret/i);

  assert.match(statusProse, /guidance package does not install this command/i);
  assert.match(
    statusProse,
    /final managed launcher.*`pi --managed-status`.*after downstream wiring is complete/i,
  );
  assert.match(statusProse, /redacted/i);
  assert.match(statusProse, /AgentMemory URL, health, and readiness/i);
  assert.doesNotMatch(statusProse, /Cavemem/i);
  for (const field of [
    /generation/i,
    /Pi version/i,
    /provider mode/i,
    /sandbox state/i,
    /active profile/i,
    /MCP endpoint and readiness/i,
    /AgentMemory (?:URL|health|readiness)/i,
    /extension versions/i,
    /LSP state/i,
    /configuration drift/i,
  ]) {
    assert.match(statusProse, field, `missing status field ${field}`);
  }

  assert.match(sandboxProse, /`PI_NONO=disabled\|audit\|enforced`/);
  assert.match(sandboxProse, /`PI_NONO_PROFILE=pi-managed\|pi-audit\|pi-review`/);
  assert.match(sandboxProse, /`PI_NONO_LISTEN_PORTS`/);
  assert.match(sandboxProse, /unique comma-separated decimal ports from 1 through 65535/i);
  assert.match(sandboxProse, /no spaces, leading zeroes, duplicates, or wildcards/i);
  assert.match(sandboxProse, /`PI_NONO=audit PI_NONO_LISTEN_PORTS=3000,8080 pi`/);
  assert.match(sandboxProse, /`PI_NONO=enforced PI_NONO_PROFILE=pi-review pi`/);
  assert.match(sandboxProse, /invalid override.*accepted values/i);

  for (const file of ["settings.json", "models.json", "ownership.json"]) {
    assert.match(recoveryProse, new RegExp(`\\b${file.replace(".", "\\.")}\\b`));
  }
  assert.match(recoveryProse, /stops before Pi/i);
  assert.match(recoveryProse, /repair only the named file or state/i);
  assert.match(recoveryProse, /preserve unrelated.*state/i);
  assert.match(recoveryProse, /run `pi` again.*validation and reconciliation/i);
  assert.match(recoveryProse, /never delete all Pi state/i);

  assert.match(updateProse, /change the Nix pin and managed generation together/i);
  assert.match(updateProse, /build.*validation.*activate/i);
  assert.match(updateProse, /no runtime package update path/i);

  assert.match(rollbackProse, /`PI_NONO=disabled pi`/);
  assert.match(rollbackProse, /reported unsandboxed fallback/i);
  assert.match(rollbackProse, /one[- ]launch/i);
  assert.match(rollbackProse, /not.*default/i);
});

test("advisory help names the module date input and exact expiry semantics", () => {
  const exceptions = section(readSources().guide, "Advisory exceptions");
  const exceptionProse = normalizeProse(exceptions);

  assert.deepEqual(bulletCodeNames(exceptions), ["id", "rationale", "approver", "expiresOn"]);
  assert.match(exceptionProse, /critical or high-severity production advisory/i);
  assert.match(exceptionProse, /IDs must be unique/i);
  assert.match(exceptionProse, /`piAgentAdvisoryDate`/);
  assert.match(exceptionProse, /module-evaluation-owned date input/i);
  assert.match(exceptionProse, /Gregorian `YYYY-MM-DD`/i);
  assert.match(exceptionProse, /mandatory when exceptions exist/i);
  assert.match(exceptionProse, /at or after `expiresOn`/i);
  assert.match(exceptionProse, /evaluation fails/i);
  assert.match(exceptionProse, /not credential or provider exceptions/i);
});

test("guidance excludes stale surfaces, placeholders, and positive mutable-install instructions", () => {
  const { instructions, guide } = readSources();
  const combined = `${instructions}\n${guide}`;
  const forbidden = [
    ["OpenCode", /\bopencode\b/i],
    ["Sieve", /\bsieve\b/i],
    ["direct Tool Gateway", /\btool gateway\b/i],
    ["legacy direct-call endpoint", /\/mcp\/call\b/i],
    ["generic MCP proxy", /\bgeneric MCP (?:proxy|tool)\b/i],
    ["script or code execution", /\b(?:script|code)[-_ ]execution\b/i],
    ["direct Cavemem MCP", /\bdirect Cavemem MCP\b/i],
    ["unfinished marker", /\b(?:TODO|FIXME)\b|<[^>]+>/],
  ];
  for (const [label, pattern] of forbidden) {
    assert.doesNotMatch(combined, pattern, `found ${label}`);
  }

  const sentences = normalizeProse(combined).split(/(?<=\.)\s+/);
  for (const sentence of sentences.filter((candidate) => /pi install|\/pkg|self-update/i.test(candidate))) {
    assert.match(
      sentence,
      /do not|disabled|no runtime/i,
      `positive mutable-install instruction: ${sentence}`,
    );
  }
});
