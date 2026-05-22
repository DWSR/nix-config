'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  validateOpenCodeConfigShape,
} = require(path.join(__dirname, '../../../scripts/subagent-context-budget.js'));

const repoRoot = path.resolve(__dirname, '../../..');

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
