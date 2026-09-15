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

function astGrepPackageExpr() {
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
      pkg = pkgs.ast-grep-mcp;
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

function astGrepPackageBuildExpr() {
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
      pkgs.ast-grep-mcp
  `;
}

function hostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      astGrepRelated = name: builtins.match ".*ast[-_]grep.*" name != null;
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          rendered = builtins.fromJSON (builtins.unsafeDiscardStringContext config.xdg.configFile."mcpproxy/mcp_config.json".text);
          servers = builtins.listToAttrs (map (server: { name = server.name; value = server; }) rendered.mcpServers);
          serverNames = builtins.attrNames servers;
          opencodeMcp = config.programs.opencode.settings.mcp or { };
          astGrepSource = config.home.mcp.extraServers.ast-grep;
        in
        {
          routingMode = rendered.routing_mode;
          serverNames = serverNames;
          astGrep = servers.ast-grep;
          astGrepSource = {
            command = builtins.unsafeDiscardStringContext astGrepSource.command;
            hasArgs = astGrepSource ? args;
            hasEnv = astGrepSource ? env;
            hasHeaders = astGrepSource ? headers;
            hasUrl = astGrepSource ? url;
          };
          astGrepSecretNames = builtins.filter astGrepRelated (builtins.attrNames config.home.mcp.keychainSecrets);
          astGrepFileSourcedEnvNames = builtins.filter astGrepRelated (builtins.attrNames config.home.mcp.fileSourcedEnv);
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

function assertAstGrepServer(server, hostKey) {
  assert.equal(server.name, 'ast-grep', `${hostKey} ast-grep server name`);
  assert.equal(server.protocol, 'stdio', `${hostKey} ast-grep uses stdio`);
  assert.equal(server.enabled, true, `${hostKey} ast-grep enabled`);
  assert.equal(server.quarantined, false, `${hostKey} ast-grep not quarantined`);
  assert.deepEqual(server.args, [], `${hostKey} ast-grep has no args or default project path`);
  assert.equal(Object.hasOwn(server, 'env'), false, `${hostKey} ast-grep has no rendered env`);
  assert.equal(Object.hasOwn(server, 'headers'), false, `${hostKey} ast-grep has no rendered headers`);
  assert.equal(Object.hasOwn(server, 'url'), false, `${hostKey} ast-grep is not an HTTP/SSE server`);
  assert.match(server.command, /\/[^/]*ast-grep-mcp-0\.1\.0\/bin\/ast-grep-mcp$/, `${hostKey} ast-grep command points at package binary`);
}

test('ast-grep-mcp package exposes metadata, built executable output, and help smoke path', () => {
  const metadata = nixEvalJson(astGrepPackageExpr());

  assert.equal(metadata.pname, 'ast-grep-mcp');
  assert.equal(metadata.version, '0.1.0');
  assert.match(metadata.name, /^ast-grep-mcp-0\.1\.0/);
  assert.match(metadata.packagePath, /\/[^/]*ast-grep-mcp-0\.1\.0$/);
  assert.equal(metadata.meta.description, 'MCP server for structural code search via ast-grep');
  assert.equal(metadata.meta.homepage, 'https://github.com/ast-grep/ast-grep-mcp');
  assert.equal(metadata.meta.license, 'mit');
  assert.equal(metadata.meta.mainProgram, 'ast-grep-mcp');

  const outPath = nixBuildOutPath(astGrepPackageBuildExpr());
  const executable = path.join(outPath, 'bin', 'ast-grep-mcp');
  assert.equal(fs.existsSync(executable), true);
  assert.equal(fs.existsSync(path.join(outPath, 'lib', 'ast-grep-mcp', 'main.py')), true);

  const help = childProcess.execFileSync(executable, ['--help'], {
    cwd: outPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });
  assert.match(help, /usage:/i);
  assert.match(help, /ast-grep/i);
  assert.match(help, /--config/);
});

test('both hosts render ast-grep upstream through mcpproxy and preserve existing servers', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  assert.equal(rendered.personal.serverNames.includes('obsidian'), false);
  assert.equal(rendered.shopify.serverNames.includes('obsidian'), false);
  assertIncludesAll(rendered.personal.serverNames, [
    'github',
    'time',
    'instances-mcp',
    'git-mcp',
    'agentmemory',
    'grep-app',
    'ast-grep',
    'fastmail',
    'kagi',
    'slack-hangops',
    'beeper',
  ], 'personal mcpproxy servers');
  assertIncludesAll(rendered.shopify.serverNames, [
    'github',
    'time',
    'instances-mcp',
    'git-mcp',
    'agentmemory',
    'grep-app',
    'ast-grep',
    'buildkite',
    'gcloud-mcp',
    'tool-gateway',
  ], 'Shopify mcpproxy servers');

  assert.equal(rendered.personal.routingMode, 'retrieve_tools');
  assert.equal(rendered.shopify.routingMode, 'retrieve_tools');
  assertAstGrepServer(rendered.personal.astGrep, 'personal');
  assertAstGrepServer(rendered.shopify.astGrep, 'Shopify');
});

test('ast-grep host declarations add no required secrets or direct opencode MCP entries', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.astGrepSource.hasArgs, false, `${hostKey} source ast-grep has no args`);
    assert.equal(host.astGrepSource.hasEnv, false, `${hostKey} source ast-grep has no env`);
    assert.equal(host.astGrepSource.hasHeaders, false, `${hostKey} source ast-grep has no headers`);
    assert.equal(host.astGrepSource.hasUrl, false, `${hostKey} source ast-grep has no url`);
    assert.match(host.astGrepSource.command, /\/[^/]*ast-grep-mcp-0\.1\.0\/bin\/ast-grep-mcp$/, `${hostKey} source ast-grep command points at package binary`);
    assert.deepEqual(host.astGrepSecretNames, [], `${hostKey} has no ast-grep keychain secret`);
    assert.deepEqual(host.astGrepFileSourcedEnvNames, [], `${hostKey} has no ast-grep file-sourced env`);
    assert.deepEqual(host.opencodeMcpNames, ['mcpproxy'], `${hostKey} has no direct ast-grep opencode MCP entry`);
    assert.deepEqual(host.opencodeMcpproxy, {
      enabled: true,
      type: 'remote',
      url: 'http://127.0.0.1:8080/mcp',
    });
  }
});
