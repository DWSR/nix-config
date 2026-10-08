'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const repoRoot = path.resolve(__dirname, '../..');
const ACTIVE_PROMPT_FILES = Object.freeze([
  'home-manager/common/agents.md',
  'home-manager/common/agents-agentmemory.md',
  'home-manager/common/agents-cc-sdd.md',
]);
const ACTIVE_PROMPT_DIRS = Object.freeze([
  'home-manager/common/agents',
  'home-manager/common/commands',
  'home-manager/common/opencode',
  'home-manager/common/pi-agent',
  'home-manager/common/subagent-context-budget',
]);
const ACTIVE_SKILL_DIRS = Object.freeze([
  'home-manager/common/skills',
]);
const ACTIVE_SKILL_FILES = Object.freeze([
  'home-manager/common/skills/github-native-stacks/SKILL.md',
]);
const COMMON_MEMORY_PRODUCERS = Object.freeze(['nix-pkg', 'nvim-tailor', 'security-auditor']);
const REPO_OWNED_RENDERED_SKILLS = Object.freeze({
  personal: Object.freeze([
    'opencode/skills/github-native-stacks',
  ]),
});
// These skills are dependency-owned: cc-sdd is supplied by the pinned
// package, while process-flow-diagram and architecture-diagram are fetched.
// Check their rendered names without reading their imported content.
const IMPORTED_RENDERED_SKILLS = Object.freeze({
  personal: Object.freeze([
    'opencode/skills/architecture-diagram',
    'opencode/skills/process-flow-diagram',
  ]),
});
const IMPORTED_SKILL_PREFIXES = Object.freeze(['opencode/skills/kiro-']);
const RETIRED_ACTIVE_SURFACE =
  /\bobsidian\b|\bvault\b|\bMOCs?\b|memories\/|(?:vault|memory|obsidian)[-_ ]path\b|write-note|read-note|list-notes|search-by-tags|search-vault/i;
const RETIRED_PIPELINE_SURFACE = /\b(?:memory-sync|vault-curator|vault-synthesizer)\b/i;
// Historical specifications/steering and test fixtures are not active prompt
// inputs and are deliberately excluded from this source inventory.
const NON_ACTIVE_ROOTS = Object.freeze(['.kiro/', 'tests/']);

let renderedArtifacts;

function collectFiles(relativeRoot) {
  const absoluteRoot = path.join(repoRoot, relativeRoot);
  const entries = fs.readdirSync(absoluteRoot, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeRoot, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(relativePath));
    else if (entry.isFile()) files.push(relativePath);
  }

  return files;
}

function readActivePromptArtifacts() {
  const relativePaths = [
    ...ACTIVE_PROMPT_FILES,
    ...ACTIVE_PROMPT_DIRS.flatMap((relativeRoot) => collectFiles(relativeRoot)),
    ...ACTIVE_SKILL_DIRS.flatMap((relativeRoot) => collectFiles(relativeRoot)),
    ...ACTIVE_SKILL_FILES,
  ];
  const uniquePaths = [...new Set(relativePaths)].sort();

  for (const relativePath of uniquePaths) {
    assert.equal(
      NON_ACTIVE_ROOTS.some((root) => relativePath.startsWith(root)),
      false,
      `active prompt inventory must not include ${relativePath}`,
    );
  }

  return new Map(uniquePaths.map((relativePath) => [
    relativePath,
    fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  ]));
}

function renderActiveCutoverArtifacts() {
  if (renderedArtifacts) return renderedArtifacts;
  if (process.env.AGENTMEMORY_MATRIX_HOSTS) {
    const rows = JSON.parse(fs.readFileSync(process.env.AGENTMEMORY_MATRIX_HOSTS, 'utf8'));
    renderedArtifacts = { personal: rows.personal.cutover };
    return renderedArtifacts;
  }

  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  discard = value: builtins.unsafeDiscardStringContext value;
  text = value:
    if builtins.typeOf value == "path" then discard (builtins.readFile value) else discard value;
  skillText = value: discard (builtins.readFile (value.source + "/SKILL.md"));
  summarize = host:
    let
      hm = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
      mcpConfig = builtins.fromJSON (discard hm.xdg.configFile."mcpproxy/mcp_config.json".text);
      skillFiles = flake.inputs.nixpkgs.lib.filterAttrs (
         name: _: builtins.match "opencode/skills/(binks-pr-review|create-yb-fix-pr|github-native-stacks|validate-yb-issue)" name != null
      ) hm.xdg.configFile;
      skillNames = builtins.filter (
        name: builtins.match "opencode/skills/.+" name != null
      ) (builtins.attrNames hm.xdg.configFile);
      agents = builtins.mapAttrs (_: value: text value) hm.programs.opencode.agents;
      skills = builtins.mapAttrs (_: value: skillText value) skillFiles;
      packageNames = map (package: package.name or "") hm.home.packages;
    in {
      context = discard hm.programs.opencode.context;
      agents = agents;
      skills = skills;
      wrapper = builtins.concatStringsSep "\\n" (map text hm.home.opencode.wrapperCommands);
      agentNames = builtins.attrNames hm.programs.opencode.agents;
      commandNames = builtins.attrNames (hm.programs.opencode.commands or { });
      packageNames = packageNames;
      serverNames = map (server: server.name) mcpConfig.mcpServers;
      skillNames = skillNames;
      pi = {
        enable = hm.programs.pi.coding-agent.enable;
        agentMemoryUrl = hm.programs.pi.coding-agent.environment.AGENTMEMORY_URL.value;
        extensions = map (extension: discard (toString extension)) hm.programs.pi.coding-agent.extensions;
        instructionResources = [
          {
            path = discard (toString hm.programs.pi.coding-agent.rules);
            content = discard (builtins.readFile hm.programs.pi.coding-agent.rules);
          }
        ];
        mcpPort = hm.home.mcp.listenPort;
      };
    };
in builtins.toJSON {
  personal = summarize "Brandons-MacBook-Pro";
})`;

  renderedArtifacts = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--impure', '--raw', '--expr', expression],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 24 * 1024 * 1024,
      timeout: 600_000,
    },
  ));
  return renderedArtifacts;
}

function assertNoRetiredMemoryWorkflow(name, content) {
  assert.doesNotMatch(content, RETIRED_ACTIVE_SURFACE, `${name} exposes an Obsidian workflow`);
  assert.doesNotMatch(content, RETIRED_PIPELINE_SURFACE, `${name} exposes a retired pipeline`);
}

function assertAgentMemoryWorkflow(name, content) {
  assertAgentMemoryOperations(name, content);
  assert.match(content, /exact returned\s+`name`/, name);
  assert.match(content, /`call_with`/, name);
  assert.match(content, /`args`/, name);
}

function assertAgentMemoryOperations(name, content) {
  assert.match(content, /retrieve_tools\(query: "agentmemory core recall"\)/, name);
  assert.match(content, /call_tool_read/, name);
  assert.match(content, /agentmemory:memory_(?:recall|smart_search)/, name);
  assert.match(content, /call_tool_write/, name);
  assert.match(content, /agentmemory:memory_(?:save|lesson_save)/, name);
}

function assertAgentMemoryRecall(name, content) {
  assert.match(content, /retrieve_tools\(query: "agentmemory core recall"\)/, name);
  assert.match(content, /call_tool_read/, name);
  assert.match(content, /agentmemory:memory_(?:recall|smart_search)/, name);
}

function assertMemoryProducer(name, content) {
  assert.match(content, /MEMORY_ID:\s*<id>/, `${name} emits MEMORY_ID`);
  assert.match(
    content,
    /MEMORY_QUERY:\s*<distinctive\s+title\s+and\s+concepts>/,
    `${name} emits MEMORY_QUERY`,
  );
}

function assertMemoryConsumer(name, content) {
  assert.match(
    content,
    /\b(?:recall|search)\s+(?:by|with|using)\s+`?MEMORY_QUERY`?/i,
    `${name} recalls by the literal MEMORY_QUERY handoff`,
  );
  assert.match(
    content,
    /\bverif(?:y|ies)\b[\s\S]{0,100}\breturned\s+(?:record\s+)?ID\s+(?:equals|matches|is\s+equal\s+to)\s+`?MEMORY_ID`?/i,
    `${name} verifies the returned record ID equals MEMORY_ID`,
  );
  assert.match(content, /(?:do not|never|does not)\s+fetch by ID/i, name);
}

test('memory consumer assertions require the literal MEMORY_QUERY handoff', () => {
  assert.throws(
    () => assertMemoryConsumer(
      'consumer with generic query wording',
      [
        'Recall by query.',
        'Verify the returned record ID equals `MEMORY_ID`.',
        'Never fetch by ID.',
      ].join('\n'),
    ),
    assert.AssertionError,
  );
});

test('memory consumer assertions require returned-ID equality with MEMORY_ID', () => {
  assert.throws(
    () => assertMemoryConsumer(
      'consumer with unbound returned ID wording',
      [
        'Recall by `MEMORY_QUERY`.',
        'Verify the returned record ID.',
        'MEMORY_ID is the producer handoff.',
        'Never fetch by ID.',
      ].join('\n'),
    ),
    assert.AssertionError,
  );
});

function readSource(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function assertRenderedSkillInventory(host, config) {
  const repoOwned = REPO_OWNED_RENDERED_SKILLS[host];
  const imported = IMPORTED_RENDERED_SKILLS[host];

  assert.deepEqual(
    Object.keys(config.skills).sort(),
    [...repoOwned].sort(),
    `${host} renders every repo-owned skill source and no imported content as local source`,
  );
  for (const skillName of imported) {
    assert.equal(
      config.skillNames.includes(skillName),
      true,
      `${host} rendered inventory must account for imported skill ${skillName}`,
    );
  }
  for (const skillName of config.skillNames) {
    assert.equal(
      repoOwned.includes(skillName)
        || imported.includes(skillName)
        || IMPORTED_SKILL_PREFIXES.some((prefix) => skillName.startsWith(prefix)),
      true,
      `${host} rendered skill ${skillName} is neither repo-owned nor explicitly classified as imported`,
    );
  }
}

test('active prompt inventory excludes retired workflow and preserves AgentMemory mirrors', async () => {
  const artifacts = readActivePromptArtifacts();
  const plugin = await import(pathToFileURL(
    path.join(repoRoot, 'home-manager/common/subagent-context-budget/plugin.ts'),
  ).href);
  const memoryFragment = artifacts.get(
    'home-manager/common/subagent-context-budget/instructions/memory-mcpproxy.md',
  );
  const pluginMemoryFragment = plugin.SubagentContextBudgetPlugin.instructionFragments['memory-mcpproxy'].text;

  assert.ok(artifacts.size > ACTIVE_PROMPT_FILES.length);
  for (const [relativePath, content] of artifacts) {
    assertNoRetiredMemoryWorkflow(relativePath, content);
  }

  assertAgentMemoryWorkflow('global AgentMemory instructions', artifacts.get('home-manager/common/agents-agentmemory.md'));
  assert.match(artifacts.get('home-manager/common/pi-agent/instructions.md'), /AgentMemory/);
  assert.match(artifacts.get('home-manager/common/pi-agent/instructions.md'), /memory_(?:recall|smart_search)/);
  assert.match(artifacts.get('home-manager/common/pi-agent/instructions.md'), /memory_(?:save|lesson_save)/);
  assertAgentMemoryOperations('context-budget source memory fragment', memoryFragment);
  assert.equal(pluginMemoryFragment, memoryFragment.trim(), 'plugin mirror must match the canonical fragment');
  assertAgentMemoryOperations('context-budget plugin memory fragment', pluginMemoryFragment);

  const smokeCatalog = JSON.parse(readSource('home-manager/common/subagent-context-budget/smoke-catalog.json'));
  assert.equal(
    smokeCatalog.smokeDefinitions.some(({ agentName }) => RETIRED_PIPELINE_SURFACE.test(agentName)),
    false,
  );
  assert.doesNotMatch(
    readSource('home-manager/common/subagent-context-budget/budgets.nix'),
    RETIRED_PIPELINE_SURFACE,
  );

  for (const name of COMMON_MEMORY_PRODUCERS) {
    const content = artifacts.get(`home-manager/common/agents/${name}.md`);
    assertAgentMemoryWorkflow(`common/${name}`, content);
    assertMemoryProducer(`common/${name}`, content);
  }
});

test('OpenCode and Pi rendered startup contracts keep the shortened preflight and AgentMemory gate', () => {
  const rendered = renderActiveCutoverArtifacts();
  const piStatusSource = readSource('scripts/pi-agent-status.nix');

  assert.match(piStatusSource, /mandatoryUpstreams:\s*\["agentmemory"\]/);
  assert.doesNotMatch(piStatusSource, /obsidian/i);

  for (const [host, config] of Object.entries(rendered)) {
    const promptSurface = [config.context, ...Object.values(config.agents), ...Object.values(config.skills)].join('\n');
    const piPromptSurface = config.pi.instructionResources.map(({ content }) => content).join('\n');
    assertNoRetiredMemoryWorkflow(`${host} rendered prompts`, promptSurface);
    assertRenderedSkillInventory(host, config);
    assertNoRetiredMemoryWorkflow(`${host} rendered Pi instructions`, piPromptSurface);
    assert.match(config.context, /AgentMemory/);
    assert.match(config.context, /memory_(?:recall|smart_search)/);
    assert.match(config.context, /memory_(?:save|lesson_save)/);
    assert.match(piPromptSurface, /AgentMemory/);
    assert.match(piPromptSurface, /memory_(?:recall|smart_search)/);
    assert.match(piPromptSurface, /memory_(?:save|lesson_save)/);

    const livenessIndex = config.wrapper.indexOf('http://127.0.0.1:8080/healthz');
    const agentMemoryIndex = config.wrapper.indexOf('AgentMemory daemon preflight failed');
    assert.ok(livenessIndex >= 0, `${host} keeps mcpproxy liveness`);
    assert.ok(agentMemoryIndex > livenessIndex, `${host} resolves the AgentMemory bearer after mcpproxy`);
    assert.match(config.wrapper, /AgentMemory daemon preflight failed/);
    assert.match(config.wrapper, /Recover AgentMemory with:/);
    assert.doesNotMatch(config.wrapper, /api\/v1\/servers|mcpproxy-api-key|X-API-Key|obsidian/i);

    assert.equal(config.agentNames.includes('vault-curator'), false, `${host} omits the vault curator`);
    assert.equal(config.agentNames.includes('vault-synthesizer'), false, `${host} omits the vault synthesizer`);
    assert.equal(config.commandNames.includes('memory-sync'), false, `${host} omits memory-sync`);
    assert.equal(config.packageNames.includes('memory-sync'), false, `${host} omits memory-sync package`);
    assert.equal(config.serverNames.includes('obsidian'), false, `${host} omits Obsidian MCP`);
    assert.equal(config.serverNames.includes('agentmemory'), true, `${host} retains AgentMemory MCP`);

    assert.equal(config.pi.enable, true, `${host} enables Pi`);
    assert.equal(config.pi.agentMemoryUrl, 'http://127.0.0.1:3111', `${host} wires Pi to AgentMemory`);
    assert.equal(config.pi.extensions.some((extension) => /\/integrations\/pi\/index\.ts$/.test(extension)), true, `${host} keeps Pi AgentMemory extension`);
    assert.equal(config.pi.extensions.some((extension) => /pi-mcpproxy-go[^/]*\/index\.ts$/.test(extension)), true, `${host} keeps Pi mcpproxy extension`);
    assert.equal(config.pi.mcpPort, 8080, `${host} keeps Pi mcpproxy transport`);
    assert.equal(
       config.pi.instructionResources.some(({ path: resourcePath }) => /pi-agent\/instructions\.md$/.test(resourcePath)),
      true,
      `${host} renders managed Pi instructions`,
    );
  }
});

test('common producers and consumers preserve searchable ID handoffs', () => {
  const artifacts = readActivePromptArtifacts();

});
