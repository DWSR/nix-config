'use strict';

/*
 * hm-render.test.js — render assertions for git-mcp as a base MCP server.
 *
 * git-mcp (cyanheads/git-mcp-server, security-reviewed) is registered in
 * `baseServers` (home-manager/mcp/default.nix), NOT in any host's
 * `extraServers`. This test renders BOTH nix-darwin hosts' mcp_config.json
 * and asserts that git-mcp is present on each host exactly once with the
 * hardened posture: stdio transport, stateless session mode, in-memory
 * storage provider. Presence on both hosts (with no host extraServers entry)
 * is the proof that it is a base server.
 *
 * Mirrors the tests/grep-app-mcp render harness; the eval is a pure
 * `nix eval` of the rendered config text, so it runs inside the Nix check
 * sandbox without a heavy build.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
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
          gitMcpEntries = builtins.filter (server: server.name == "git-mcp") rendered.mcpServers;
        in
        {
          serverNames = builtins.attrNames servers;
          gitMcp = servers.git-mcp or null;
          gitMcpCount = builtins.length gitMcpEntries;
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function assertGitMcpServer(server, hostKey) {
  assert.ok(server, `${hostKey} renders a git-mcp server`);
  assert.equal(server.name, 'git-mcp', `${hostKey} git-mcp server name`);
  assert.equal(server.protocol, 'stdio', `${hostKey} git-mcp uses stdio`);
  assert.equal(server.enabled, true, `${hostKey} git-mcp enabled`);
  assert.equal(server.quarantined, false, `${hostKey} git-mcp not quarantined`);
  assert.deepEqual(server.args, [], `${hostKey} git-mcp has no args`);
  assert.match(
    server.command,
    /\/[^/]*git-mcp-server-[^/]+\/bin\/git-mcp-server$/,
    `${hostKey} git-mcp command points at the git-mcp-server package binary`,
  );
  assert.equal(server.env.MCP_SESSION_MODE, 'stateless', `${hostKey} git-mcp session mode is stateless`);
  assert.equal(server.env.STORAGE_PROVIDER_TYPE, 'in-memory', `${hostKey} git-mcp storage provider is in-memory`);
}

test('git-mcp is a base server rendered on both hosts with the hardened posture', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.ok(
      host.serverNames.includes('git-mcp'),
      `${hostKey} mcpproxy servers must include git-mcp as a base server`,
    );
    assert.equal(host.gitMcpCount, 1, `${hostKey} git-mcp must be registered exactly once`);
    assertGitMcpServer(host.gitMcp, hostKey);
  }
});
