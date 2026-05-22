'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');

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
