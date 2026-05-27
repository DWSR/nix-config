'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nixEvalJson,
  repoRoot,
} = require('./helpers');

const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});

function gitCloneIsolationHostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      packageNames = packages: map (pkg: pkg.name or pkg.pname or "") packages;
      hasWrapper = config: builtins.elem "git-clone-isolation" (packageNames config.home.packages);
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          gci = config.programs.git-clone-isolation;
        in
        {
          enabled = gci.enable;
          packageInHomePackages = hasWrapper config;
          cacheRoot = gci.cacheRoot;
          expectedCacheRoot = "\${config.xdg.stateHome}/git-clone-isolation";
          cloneRoot = gci.cloneRoot;
          expectedCloneRoot = "\${config.home.homeDirectory}/scratch";
          defaultBranch = gci.defaultBranch;
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function disabledModuleRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${repoRoot}/home-manager/common/git-clone-isolation.nix
          ({ ... }: {
            home.username = "git-clone-isolation-test";
            home.homeDirectory = "/Users/git-clone-isolation-test";
            home.stateVersion = "25.11";
            programs.git-clone-isolation.enable = false;
          })
        ];
      };
      config = hm.config;
      packageNames = map (pkg: pkg.name or pkg.pname or "") config.home.packages;
    in
    {
      enabled = config.programs.git-clone-isolation.enable;
      packageInHomePackages = builtins.elem "git-clone-isolation" packageNames;
    }
  `;
}

function shopifyRefreshAgentExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      config = flake.darwinConfigurations."${HOSTS.shopify}".config.home-manager.users.brandonmcnama;
      agent = config.launchd.agents.git-clone-isolation-globaldb-yugabyte-refresh;
    in
    {
      enabled = agent.enable;
      label = agent.config.Label;
      programArguments = agent.config.ProgramArguments;
      runAtLoad = agent.config.RunAtLoad;
      startInterval = agent.config.StartInterval;
      expectedCacheRoot = config.programs.git-clone-isolation.cacheRoot;
    }
  `;
}

test('Home Manager host render enables git-clone-isolation with wrapper package and default paths', () => {
  const rendered = nixEvalJson(gitCloneIsolationHostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.enabled, true, `${hostKey} enables programs.git-clone-isolation`);
    assert.equal(host.packageInHomePackages, true, `${hostKey} installs git-clone-isolation wrapper`);
    assert.equal(host.cacheRoot, host.expectedCacheRoot, `${hostKey} cacheRoot derives from xdg.stateHome`);
    assert.equal(host.cloneRoot, host.expectedCloneRoot, `${hostKey} cloneRoot derives from home.homeDirectory`);
    assert.equal(host.defaultBranch, 'main', `${hostKey} default branch is main`);
  }
});

test('disabled Home Manager module omits git-clone-isolation wrapper package', () => {
  const rendered = nixEvalJson(disabledModuleRenderExpr());

  assert.equal(rendered.enabled, false);
  assert.equal(rendered.packageInHomePackages, false);
});

test('Shopify host renders globaldb-yugabyte main-branch cache refresh agent', () => {
  const rendered = nixEvalJson(shopifyRefreshAgentExpr());

  assert.equal(rendered.enabled, true);
  assert.equal(rendered.label, 'dev.dwsr.git-clone-isolation.globaldb-yugabyte-refresh');
  assert.equal(rendered.runAtLoad, true);
  assert.equal(rendered.startInterval, 600);
  assert.deepEqual(rendered.programArguments.slice(1), [
    'refresh',
    '--repo',
    'https://github.com/Shopify/globaldb-yugabyte',
    '--branch',
    'main',
    '--cache-root',
    rendered.expectedCacheRoot,
  ]);
  assert.match(rendered.programArguments[0], /git-clone-isolation\/bin\/git-clone-isolation$/);
});
