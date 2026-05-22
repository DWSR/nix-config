'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateOpenCodeConfigShape,
} = require(path.join(__dirname, '../../../scripts/subagent-context-budget.js'));

const repoRoot = path.resolve(__dirname, '../../..');
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});
const TASK_8_2_REQUIREMENTS = Object.freeze([
  '1.1', '1.2', '1.3', '1.4', '1.5',
  '2.1', '2.2', '2.3', '2.4', '2.5',
  '3.1', '3.2', '3.3', '3.4', '3.5',
  '4.1', '4.2', '4.3', '4.4', '4.5',
  '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7',
  '6.1', '6.2', '6.3', '6.4', '6.5',
  '7.1', '7.2', '7.3', '7.4', '7.5',
  '8.1', '8.2', '8.3', '8.4', '8.5',
]);
const REQUIREMENT_COVERAGE = Object.freeze([
  {
    group: 'budget metadata, permissions, and rendered host surfaces',
    requirements: ['1.1', '1.5', '2.1', '2.2', '2.3', '2.4', '2.5', '6.1', '6.2', '6.3', '7.1', '7.2', '7.5', '8.1', '8.2', '8.3', '8.5'],
    artifacts: [
      'tests/subagent-context-budget/unit/budget-catalog.test.js',
      'tests/subagent-context-budget/integration/hm-render.test.js',
      'tests/subagent-context-budget/unit/smoke-wrapper.test.js',
    ],
  },
  {
    group: 'audit, diagnostic parsing, baseline, and validation comparison',
    requirements: ['1.2', '1.3', '1.4', '4.1', '4.2', '4.3', '4.4', '4.5', '5.1', '5.2', '5.3', '5.4', '5.5', '5.6', '5.7', '7.3', '7.4', '8.4'],
    artifacts: [
      'tests/subagent-context-budget/unit/cost-report-adapter.test.js',
      'tests/subagent-context-budget/unit/audit-report.test.js',
      'tests/subagent-context-budget/unit/validation-comparator.test.js',
      'tests/subagent-context-budget/integration/e2e-fixture.test.js',
    ],
  },
  {
    group: 'instruction profile runtime and plugin self-check',
    requirements: ['3.1', '3.2', '3.3', '3.4', '3.5', '5.6', '8.5'],
    artifacts: [
      'tests/subagent-context-budget/unit/instruction-profile.test.js',
      'tests/subagent-context-budget/unit/instruction-profile-decide.test.js',
      'tests/subagent-context-budget/unit/plugin-self-check-metadata.test.js',
      'tests/subagent-context-budget/integration/plugin-self-check.test.js',
    ],
  },
  {
    group: 'smoke planning, smoke results, runtime wrapper, and operator guidance',
    requirements: ['6.1', '6.2', '6.3', '6.4', '6.5', '7.2', '7.4', '7.5', '8.1', '8.2'],
    artifacts: [
      'tests/subagent-context-budget/unit/smoke-catalog.test.js',
      'tests/subagent-context-budget/unit/smoke-plan.test.js',
      'tests/subagent-context-budget/unit/smoke-result.test.js',
      'tests/subagent-context-budget/unit/smoke-wrapper.test.js',
      'tests/subagent-context-budget/unit/runbook.test.js',
    ],
  },
]);
let hostRuntimePrerequisitesCache;
let smokeWrapperPathCache;

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

function nixEvalFlakeAttrJson(attr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', attr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

function nixBuildExpr(expr) {
  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ).trim();
}

function hostRuntimePrerequisitesExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hmWithEnforcement = host:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = true;
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      summarize = host: config:
        let
          budget = config.programs.subagent-context-budget;
          files = config.xdg.configFile;
          plugin = files."opencode/plugins/subagent-context-budget.ts";
          metadataFile = files.\${budget.metadataPath};
          metadata = builtins.fromJSON metadataFile.text;
          agents = config.programs.opencode.settings.agent or { };
        in
        {
          pluginFilePresent = builtins.hasAttr "opencode/plugins/subagent-context-budget.ts" files;
          pluginSource = toString plugin.source;
          metadataTextPresent = metadataFile ? text;
          metadataJson = metadataFile.text;
          metadata = {
            host = metadata.host;
            version = metadata.version;
            enforcementEnabled = metadata.enforcementEnabled;
          };
          agentNames = builtins.attrNames metadata.agents;
          enforcedAgentOverrides = builtins.attrNames (builtins.intersectAttrs metadata.agents agents);
          cliPackageName = budget.package.name;
          smokeTestPackageName = budget.smokeTestPackage.name;
          packageInHomePackages = builtins.elem budget.package config.home.packages;
          smokeTestPackageInHomePackages = builtins.elem budget.smokeTestPackage config.home.packages;
        };
      personalHost = "${HOSTS.personal}";
      shopifyHost = "${HOSTS.shopify}";
    in
    {
      hosts = {
        personal = summarize personalHost (hmWithEnforcement personalHost);
        shopify = summarize shopifyHost (hmWithEnforcement shopifyHost);
      };
    }
  `;
}

function smokeWrapperPackageExpr(host) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = (flake.darwinConfigurations."${host}".extendModules {
        modules = [
          ({ ... }: {
            home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = true;
          })
        ];
      }).config.home-manager.users.brandonmcnama;
    in
    hm.programs.subagent-context-budget.smokeTestPackage
  `;
}

function evaluateHostRuntimePrerequisites() {
  if (!hostRuntimePrerequisitesCache) {
    hostRuntimePrerequisitesCache = nixEvalJson(hostRuntimePrerequisitesExpr());
    for (const [hostKey, hostName] of Object.entries(HOSTS)) {
      if (process.env.NIX_BUILD_TOP) {
        hostRuntimePrerequisitesCache.hosts[hostKey].toplevelEvalSkipped = true;
      } else {
        hostRuntimePrerequisitesCache.hosts[hostKey].toplevelDrvPath = nixEvalFlakeAttrJson(
          `.#darwinConfigurations.${hostName}.config.system.build.toplevel.drvPath`,
        );
        hostRuntimePrerequisitesCache.hosts[hostKey].toplevelEvalSkipped = false;
      }
    }
  }
  return hostRuntimePrerequisitesCache;
}

function buildSmokeWrapper() {
  if (!smokeWrapperPathCache) {
    smokeWrapperPathCache = nixBuildExpr(smokeWrapperPackageExpr(HOSTS.shopify));
  }
  return smokeWrapperPathCache;
}

function runSmokeWrapperAgainstRenderedMetadata(pluginStatus) {
  const rendered = evaluateHostRuntimePrerequisites();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-context-budget-smoke-'));
  const metadataPath = path.join(tmpDir, 'metadata.json');
  const pluginSelfCheckPath = path.join(tmpDir, 'plugin-self-check.json');
  fs.writeFileSync(metadataPath, rendered.hosts.shopify.metadataJson);
  fs.writeFileSync(pluginSelfCheckPath, JSON.stringify({ status: pluginStatus }, null, 2));

  const wrapper = path.join(buildSmokeWrapper(), 'bin/subagent-context-budget-smoke-test');
  const result = childProcess.spawnSync(wrapper, [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      SUBAGENT_CONTEXT_BUDGET_SMOKE_METADATA: metadataPath,
      SUBAGENT_CONTEXT_BUDGET_SMOKE_PLUGIN_SELF_CHECK: pluginSelfCheckPath,
    },
    timeout: 120_000,
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result;
}

function assertRequirementCoverageMap() {
  const covered = new Set(REQUIREMENT_COVERAGE.flatMap((entry) => entry.requirements));
  assert.deepEqual(
    TASK_8_2_REQUIREMENTS.filter((requirement) => !covered.has(requirement)),
    [],
    'all Task 8.2 requirements must map to a validation artifact group',
  );

  for (const entry of REQUIREMENT_COVERAGE) {
    assert.ok(entry.group.length > 0);
    assert.ok(entry.requirements.length > 0, `${entry.group} must cover at least one requirement`);
    assert.ok(entry.artifacts.length > 0, `${entry.group} must name validation artifacts`);
    for (const artifact of entry.artifacts) {
      assert.equal(fs.existsSync(path.join(repoRoot, artifact)), true, `${entry.group} artifact missing: ${artifact}`);
    }
  }
}

function renderedAgentPermissionsExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hmWithEnforcement = host:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = true;
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      personal = hmWithEnforcement "Brandons-MacBook-Pro";
      shopify = hmWithEnforcement "ShopifyLaptop";
    in
    {
      personal = {
        general = personal.programs.opencode.settings.agent.general.permission;
        explore = personal.programs.opencode.settings.agent.explore.permission;
        nixPkg = personal.programs.opencode.settings.agent."nix-pkg".permission;
        hasStackCaptain = builtins.hasAttr "stack-captain" personal.programs.opencode.settings.agent;
      };
      shopify = {
        general = shopify.programs.opencode.settings.agent.general.permission;
        explore = shopify.programs.opencode.settings.agent.explore.permission;
        stackCaptain = shopify.programs.opencode.settings.agent."stack-captain".permission;
        ybSleuth = shopify.programs.opencode.settings.agent."yb-sleuth".permission;
      };
    }
  `;
}

function disabledAgentEscapeHatchExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hmWithDisabledAgent = host: disabledAgent:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget = {
                enforce = true;
                agents.\${disabledAgent}.disableBudget = true;
              };
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      personal = hmWithDisabledAgent "Brandons-MacBook-Pro" "general";
      shopify = hmWithDisabledAgent "ShopifyLaptop" "yb-sleuth";
      personalMetadata = builtins.fromJSON personal.xdg.configFile.\${personal.programs.subagent-context-budget.metadataPath}.text;
      shopifyMetadata = builtins.fromJSON shopify.xdg.configFile.\${shopify.programs.subagent-context-budget.metadataPath}.text;
      personalAgents = personal.programs.opencode.settings.agent or { };
      shopifyAgents = shopify.programs.opencode.settings.agent or { };
    in
    {
      personal = {
        generalState = personalMetadata.agents.general.state;
        exploreState = personalMetadata.agents.explore.state;
        nixPkgState = personalMetadata.agents."nix-pkg".state;
        hasGeneralPermissionOverride =
          builtins.hasAttr "general" personalAgents
          && builtins.hasAttr "permission" personalAgents.general;
        explorePermission = personalAgents.explore.permission;
      };
      shopify = {
        ybSleuthState = shopifyMetadata.agents."yb-sleuth".state;
        stackCaptainState = shopifyMetadata.agents."stack-captain".state;
        hasYbSleuthPermissionOverride =
          builtins.hasAttr "yb-sleuth" shopifyAgents
          && builtins.hasAttr "permission" shopifyAgents."yb-sleuth";
        stackCaptainPermission = shopifyAgents."stack-captain".permission;
      };
    }
  `;
}

function renderedBudgetMetadataExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = host:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = true;
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      metadata = config:
        builtins.fromJSON config.xdg.configFile.\${config.programs.subagent-context-budget.metadataPath}.text;
      personal = metadata (hm "Brandons-MacBook-Pro");
      shopify = metadata (hm "ShopifyLaptop");
    in
    {
      personal = {
        host = personal.host;
        agentNames = builtins.attrNames personal.agents;
        general = personal.agents.general;
        hasStackCaptain = builtins.hasAttr "stack-captain" personal.agents;
        hasYbSleuth = builtins.hasAttr "yb-sleuth" personal.agents;
      };
      shopify = {
        host = shopify.host;
        agentNames = builtins.attrNames shopify.agents;
        general = shopify.agents.general;
        stackCaptain = shopify.agents."stack-captain";
        ybSleuth = shopify.agents."yb-sleuth";
      };
    }
  `;
}

function moduleIntegrationExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = host: enforce:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = enforce;
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      summarize = config:
        let
          budget = config.programs.subagent-context-budget;
          files = config.xdg.configFile;
          plugin = files."opencode/plugins/subagent-context-budget.ts";
          metadata = files.\${budget.metadataPath};
          minimalBaseline = files.\${budget.minimalBaselinePath};
          agents = config.programs.opencode.settings.agent or { };
        in
        {
          pluginSource = toString plugin.source;
          metadataTextPresent = metadata ? text;
          minimalBaselineSource = toString minimalBaseline.source;
          packageInHomePackages = builtins.elem budget.package config.home.packages;
          smokeTestPackageInHomePackages = builtins.elem budget.smokeTestPackage config.home.packages;
          rules = config.programs.opencode.rules;
          agentNames = builtins.attrNames agents;
          generalPermission = agents.general.permission or null;
          nixPkgPermission = agents."nix-pkg".permission or null;
        };
      personalDisabled = summarize (hm "Brandons-MacBook-Pro" false);
      personalEnforced = summarize (hm "Brandons-MacBook-Pro" true);
      shopifyDisabled = summarize (hm "ShopifyLaptop" false);
      shopifyEnforced = summarize (hm "ShopifyLaptop" true);
    in
    {
      personalDisabled = personalDisabled;
      personalEnforced = personalEnforced;
      shopifyDisabled = shopifyDisabled;
      shopifyEnforced = shopifyEnforced;
    }
  `;
}

function openCodeConfigShapeExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = host: enforce:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = [
            ({ ... }: {
              home-manager.users.brandonmcnama.programs.subagent-context-budget.enforce = enforce;
            })
          ];
        }).config.home-manager.users.brandonmcnama;
      summarize = disabled: enforced:
        let
          budget = enforced.programs.subagent-context-budget;
          files = enforced.xdg.configFile;
        in
        {
          disabledRules = disabled.programs.opencode.rules;
          enforced = {
            rules = enforced.programs.opencode.rules;
            settings = enforced.programs.opencode.settings;
            pluginFilePresent = builtins.hasAttr "opencode/plugins/subagent-context-budget.ts" files;
            metadata = builtins.fromJSON files.\${budget.metadataPath}.text;
          };
        };
    in
    {
      personal = summarize (hm "Brandons-MacBook-Pro" false) (hm "Brandons-MacBook-Pro" true);
      shopify = summarize (hm "ShopifyLaptop" false) (hm "ShopifyLaptop" true);
    }
  `;
}

test('rendered OpenCode config applies permissions for built-in and Markdown agents by stable name', () => {
  const rendered = nixEvalJson(renderedAgentPermissionsExpr());

  assert.deepEqual(rendered.personal.general, {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    question: 'allow',
    skill: 'allow',
    webfetch: 'allow',
    lsp: 'allow',
  });
  assert.deepEqual(rendered.personal.explore, {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    question: 'allow',
    skill: 'allow',
    lsp: 'allow',
  });
  assert.deepEqual(rendered.personal.nixPkg.bash, {
    nix: 'allow',
    'nixos-rebuild': 'ask',
  });
  assert.equal(rendered.personal.hasStackCaptain, false);
  assert.equal(rendered.shopify.stackCaptain.mcpproxy_retrieve_tools, 'allow');
  assert.equal(rendered.shopify.stackCaptain.mcpproxy_call_tool_write, 'ask');
  assert.deepEqual(rendered.shopify.ybSleuth.bash, { git: 'allow' });
});

test('per-agent disableBudget marks only that agent unbudgeted and leaves rendered config unchanged', () => {
  const rendered = nixEvalJson(disabledAgentEscapeHatchExpr());

  assert.deepEqual(rendered.personal.generalState, {
    kind: 'unbudgeted',
    reason: 'operator-escape-hatch',
  });
  assert.deepEqual(rendered.personal.exploreState, { kind: 'enforced', reason: 'default' });
  assert.deepEqual(rendered.personal.nixPkgState, { kind: 'enforced', reason: 'default' });
  assert.equal(rendered.personal.hasGeneralPermissionOverride, false);
  assert.deepEqual(rendered.personal.explorePermission, {
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    list: 'allow',
    todowrite: 'allow',
    question: 'allow',
    skill: 'allow',
    lsp: 'allow',
  });

  assert.deepEqual(rendered.shopify.ybSleuthState, {
    kind: 'unbudgeted',
    reason: 'operator-escape-hatch',
  });
  assert.deepEqual(rendered.shopify.stackCaptainState, { kind: 'enforced', reason: 'host-override' });
  assert.equal(rendered.shopify.hasYbSleuthPermissionOverride, false);
  assert.equal(rendered.shopify.stackCaptainPermission.mcpproxy_retrieve_tools, 'allow');
  assert.equal(rendered.shopify.stackCaptainPermission.mcpproxy_call_tool_write, 'ask');
});

test('rendered metadata is host-aware and filters Shopify-only agents from personal host', () => {
  const rendered = nixEvalJson(renderedBudgetMetadataExpr());

  assert.equal(rendered.personal.host, 'personal');
  assert.equal(rendered.personal.agentNames.includes('general'), true);
  assert.equal(rendered.personal.agentNames.includes('explore'), true);
  assert.equal(rendered.personal.hasStackCaptain, false);
  assert.equal(rendered.personal.hasYbSleuth, false);
  assert.equal(rendered.personal.general.hostScope, 'all');
  assert.deepEqual(rendered.personal.general.state, { kind: 'enforced', reason: 'default' });

  assert.equal(rendered.shopify.host, 'shopify');
  assert.equal(rendered.shopify.agentNames.includes('general'), true);
  assert.equal(rendered.shopify.agentNames.includes('stack-captain'), true);
  assert.equal(rendered.shopify.agentNames.includes('yb-sleuth'), true);
  assert.deepEqual(rendered.shopify.stackCaptain.state, { kind: 'enforced', reason: 'host-override' });
  assert.equal(rendered.shopify.stackCaptain.permissionBudget.mcpproxy_retrieve_tools, 'allow');
  assert.equal(rendered.shopify.stackCaptain.permissionBudget.mcpproxy_call_tool_write, 'ask');
  assert.deepEqual(rendered.shopify.ybSleuth.permissionBudget.bash, { git: 'allow' });
});

test('module integration renders plugin metadata and exposes CLI packages', () => {
  const rendered = nixEvalJson(moduleIntegrationExpr());

  for (const host of [rendered.personalDisabled, rendered.personalEnforced, rendered.shopifyDisabled, rendered.shopifyEnforced]) {
    assert.match(host.pluginSource, /home-manager\/common\/subagent-context-budget\/plugin\.ts$/);
    assert.equal(host.metadataTextPresent, true);
    assert.match(host.minimalBaselineSource, /home-manager\/common\/subagent-context-budget\/minimal-readonly-baseline\.json$/);
    assert.equal(host.packageInHomePackages, true);
    assert.equal(host.smokeTestPackageInHomePackages, true);
  }
});

test('enforcement keeps global rules unchanged while plugin and agent overrides coexist', () => {
  const rendered = nixEvalJson(moduleIntegrationExpr());

  assert.equal(rendered.personalEnforced.rules, rendered.personalDisabled.rules);
  assert.equal(rendered.shopifyEnforced.rules, rendered.shopifyDisabled.rules);

  assert.match(rendered.personalEnforced.pluginSource, /home-manager\/common\/subagent-context-budget\/plugin\.ts$/);
  assert.ok(rendered.personalEnforced.agentNames.includes('general'));
  assert.ok(rendered.personalEnforced.agentNames.includes('nix-pkg'));
  assert.equal(rendered.personalEnforced.generalPermission.read, 'allow');
  assert.equal(rendered.personalEnforced.nixPkgPermission.bash.nix, 'allow');

  assert.match(rendered.shopifyEnforced.pluginSource, /home-manager\/common\/subagent-context-budget\/plugin\.ts$/);
  assert.ok(rendered.shopifyEnforced.agentNames.includes('general'));
  assert.ok(rendered.shopifyEnforced.agentNames.includes('stack-captain'));
});

test('rendered OpenCode config matches budgeted config shape for both hosts', () => {
  const rendered = nixEvalJson(openCodeConfigShapeExpr());

  for (const [host, config] of Object.entries(rendered)) {
    const result = validateOpenCodeConfigShape(config);
    assert.equal(result.ok, true, `${host}: ${JSON.stringify(result.errors)}`);
  }
});

test('OpenCode config shape validator rejects invalid rendered config', () => {
  const result = validateOpenCodeConfigShape({
    disabledRules: 'original rules',
    enforced: {
      rules: 'changed rules',
      settings: {
        agent: {
          general: {
            tools: { read: true },
            permission: ['read'],
          },
        },
      },
      pluginFilePresent: false,
      metadata: {
        version: 1,
        host: 'personal',
        agents: {
          general: {
            state: { kind: 'enforced', reason: 'default' },
          },
        },
      },
    },
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors.map((error) => error.field).sort(),
    [
      'enforced.pluginFilePresent',
      'enforced.rules',
      'settings.agent.general.permission',
      'settings.agent.general.tools',
    ],
  );
});

test('flake exposes subagent-context-budget test check', () => {
  const flake = fs.readFileSync(path.join(repoRoot, 'flake.nix'), 'utf8');

  assert.match(flake, /subagent-context-budget-tests/);
  assert.match(flake, /node --test tests\/subagent-context-budget\//);
});

test('both nix-darwin hosts evaluate runtime prerequisites for the Home Manager user', () => {
  const rendered = evaluateHostRuntimePrerequisites();

  for (const [hostName, host] of Object.entries(rendered.hosts)) {
    if (host.toplevelEvalSkipped) {
      assert.ok(process.env.NIX_BUILD_TOP, `${hostName} toplevel eval may only be skipped inside the Nix check builder`);
    } else {
      assert.match(host.toplevelDrvPath, /^\/nix\/store\/.*\.drv$/, `${hostName} toplevel must evaluate to a drv path`);
    }
    assert.equal(host.pluginFilePresent, true, `${hostName} must render plugin file`);
    assert.match(host.pluginSource, /home-manager\/common\/subagent-context-budget\/plugin\.ts$/);
    assert.equal(host.packageInHomePackages, true, `${hostName} must install CLI package`);
    assert.equal(host.smokeTestPackageInHomePackages, true, `${hostName} must install smoke wrapper`);
    assert.equal(host.metadataTextPresent, true, `${hostName} must render metadata text`);
    assert.equal(host.metadata.enforcementEnabled, true, `${hostName} metadata must reflect enforced config`);
    assert.equal(host.agentNames.includes('general'), true, `${hostName} must render general agent metadata`);
    assert.equal(host.agentNames.includes('explore'), true, `${hostName} must render explore agent metadata`);
  }

  assert.equal(rendered.hosts.personal.metadata.host, 'personal');
  assert.equal(rendered.hosts.personal.agentNames.includes('stack-captain'), false);
  assert.equal(rendered.hosts.shopify.metadata.host, 'shopify');
  assert.equal(rendered.hosts.shopify.agentNames.includes('stack-captain'), true);
  assert.equal(rendered.hosts.shopify.agentNames.includes('yb-sleuth'), true);
});

test('runtime smoke wrapper accepts rendered metadata with ready and disabled plugin self-check states', () => {
  for (const status of ['ready', 'disabled']) {
    const result = runSmokeWrapperAgainstRenderedMetadata(status);

    assert.match(result.stderr, /\[smoke-test-ok\]/);
    assert.match(result.stderr, /smokePlan=available/);
    assert.match(result.stderr, new RegExp(`pluginSelfCheck=${status}`));
  }
});

test('requirement coverage is traceable through committed validation artifacts', () => {
  assertRequirementCoverageMap();
});
