'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nixEvalJson,
  repoRoot,
} = require('./helpers');

const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
});

function gitCloneIsolationHostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      packageNames = packages: map (pkg: pkg.name or pkg.pname or "") packages;
      hasWrapper = config: builtins.elem "git-cache-clone" (packageNames config.home.packages);
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
      packageInHomePackages = builtins.elem "git-cache-clone" packageNames;
    }
  `;
}

test('personal Home Manager render enables git-clone-isolation with wrapper package and default paths', () => {
  const rendered = nixEvalJson(gitCloneIsolationHostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.enabled, true, `${hostKey} enables programs.git-clone-isolation`);
    assert.equal(host.packageInHomePackages, true, `${hostKey} installs git-cache-clone wrapper`);
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
