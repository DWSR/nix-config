'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_COMMAND_TIMEOUT_MS = 600_000;
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ));
}

function nixBuildOutPath(expr) {
  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ).trim();
}

function grepAppPackageExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [
          flake.outputs.overlays.unstable-packages
          flake.outputs.overlays.custom-packages
        ];
      };
      pkg = pkgs.grep-app-mcp;
      parsed = builtins.parseDrvName pkg.name;
    in
    {
      pname = parsed.name;
      version = parsed.version;
      name = pkg.name;
      packagePath = builtins.unsafeDiscardStringContext "${'${pkg}'}";
      meta = {
        description = pkg.meta.description;
        homepage = pkg.meta.homepage;
        license = pkg.meta.license.shortName;
        mainProgram = pkg.meta.mainProgram;
      };
    }
  `;
}

function grepAppPackageBuildExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [
          flake.outputs.overlays.unstable-packages
          flake.outputs.overlays.custom-packages
        ];
      };
    in
      pkgs.grep-app-mcp
  `;
}

function hostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          rendered = builtins.fromJSON (builtins.unsafeDiscardStringContext config.xdg.configFile."mcpproxy/mcp_config.json".text);
          servers = builtins.listToAttrs (map (server: { name = server.name; value = server; }) rendered.mcpServers);
          serverNames = builtins.attrNames servers;
          opencodeMcp = config.programs.opencode.settings.mcp or { };
        in
        {
          routingMode = rendered.routing_mode;
          serverNames = serverNames;
          grepApp = servers.grep-app;
          opencodeMcpNames = builtins.attrNames opencodeMcp;
          opencodeMcpproxy = opencodeMcp.mcpproxy or { };
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function assertIncludesAll(actual, expected, label) {
  for (const entry of expected) {
    assert.equal(actual.includes(entry), true, `${label} includes ${entry}`);
  }
}

function assertGrepAppServer(server, hostKey) {
  assert.equal(server.name, 'grep-app', `${hostKey} grep-app server name`);
  assert.equal(server.protocol, 'stdio', `${hostKey} grep-app uses stdio`);
  assert.equal(server.enabled, true, `${hostKey} grep-app enabled`);
  assert.equal(server.quarantined, false, `${hostKey} grep-app not quarantined`);
  assert.deepEqual(server.args, [], `${hostKey} grep-app has no args`);
  assert.match(server.command, /\/[^/]*grep-app-mcp-[^/]+\/bin\/grep-app-mcp$/, `${hostKey} grep-app command points at package binary`);
}

test('grep-app-mcp package exposes metadata and built executable output', () => {
  const metadata = nixEvalJson(grepAppPackageExpr());

  assert.equal(metadata.pname, 'grep-app-mcp');
  assert.equal(metadata.version, '1.0.0');
  assert.match(metadata.name, /^grep-app-mcp-1\.0\.0/);
  assert.match(metadata.packagePath, /\/[^/]*grep-app-mcp-1\.0\.0$/);
  assert.equal(metadata.meta.description, 'MCP server for code search across public GitHub repositories via grep.app');
  assert.equal(metadata.meta.homepage, 'https://github.com/ai-tools-all/grep_app_mcp');
  assert.equal(metadata.meta.license, 'isc');
  assert.equal(metadata.meta.mainProgram, 'grep-app-mcp');

  const outPath = nixBuildOutPath(grepAppPackageBuildExpr());
  assert.equal(fs.existsSync(path.join(outPath, 'bin', 'grep-app-mcp')), true);
  assert.equal(fs.existsSync(path.join(outPath, 'lib', 'node_modules', 'grep_app_mcp', 'dist', 'server-stdio.js')), true);
});

test('both hosts render grep-app upstream through mcpproxy and preserve existing servers', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  assertIncludesAll(rendered.personal.serverNames, [
    'obsidian',
    'github',
    'mcp-nixos',
    'cavemem',
    'grep-app',
    'fastmail',
    'kagi',
    'slack-hangops',
    'beeper',
  ], 'personal mcpproxy servers');
  assertIncludesAll(rendered.shopify.serverNames, [
    'obsidian',
    'github',
    'mcp-nixos',
    'cavemem',
    'grep-app',
    'buildkite',
    'gcloud-mcp',
    'tool-gateway',
  ], 'Shopify mcpproxy servers');
  assert.equal(rendered.shopify.serverNames.includes('gt-mcp'), false, 'Shopify mcpproxy excludes Graphite CLI');

  assert.equal(rendered.personal.routingMode, 'retrieve_tools');
  assert.equal(rendered.shopify.routingMode, 'retrieve_tools');
  assertGrepAppServer(rendered.personal.grepApp, 'personal');
  assertGrepAppServer(rendered.shopify.grepApp, 'Shopify');
});

test('opencode MCP config keeps only the mcpproxy wrapper entry', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.deepEqual(host.opencodeMcpNames, ['mcpproxy'], `${hostKey} has no direct grep-app opencode MCP entry`);
    assert.deepEqual(host.opencodeMcpproxy, {
      enabled: true,
      type: 'remote',
      url: 'http://127.0.0.1:8080/mcp',
    });
  }
});
