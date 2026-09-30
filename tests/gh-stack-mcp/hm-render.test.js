'use strict';

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
          ghStackSource = config.home.mcp.extraServers.gh-stack-mcp or { };
          ghStackSourceCommand = builtins.unsafeDiscardStringContext (ghStackSource.command or "");
          ghStackServers = builtins.filter (server: server.name == "gh-stack-mcp") rendered.mcpServers;
          ghStackServer = if ghStackServers == [ ] then { } else builtins.head ghStackServers;
          githubServers = builtins.filter (server: server.name == "github") rendered.mcpServers;
          githubServer = if githubServers == [ ] then { } else builtins.head githubServers;
          opencodeMcp = config.programs.opencode.settings.mcp or { };
          ghStackRelated = name: builtins.match ".*gh[-_]stack.*" name != null;
          installedGhStackPackages = builtins.filter
            (name: builtins.match ".*gh-stack-mcp.*" name != null)
            (map (package: package.name or "") config.home.packages);
        in
        {
          sourceExists = config.home.mcp.extraServers ? gh-stack-mcp;
          sourceCount = builtins.length (builtins.filter
            (name: name == "gh-stack-mcp")
            (builtins.attrNames config.home.mcp.extraServers));
          sourceAttributes = builtins.attrNames ghStackSource;
          sourceCommand = ghStackSourceCommand;
          sourcePackagePath = if ghStackSource ? command
            then builtins.dirOf (builtins.dirOf ghStackSourceCommand)
            else "";
          sourceHasType = ghStackSource ? type;
          sourceHasArgs = ghStackSource ? args;
          sourceHasEnv = ghStackSource ? env;
          sourceHasHeaders = ghStackSource ? headers;
          sourceHasUrl = ghStackSource ? url;
          sourceHasOauth = ghStackSource ? oauth;
          sourceHasDiscoveryOverride = ghStackSource ? tool_discovery_interval;
          installedGhStackPackages = installedGhStackPackages;
          ghStackRelatedSecretNames = builtins.filter ghStackRelated (builtins.attrNames config.home.mcp.keychainSecrets);
          ghStackRelatedFileEnvNames = builtins.filter ghStackRelated (builtins.attrNames config.home.mcp.fileSourcedEnv);
          listen = rendered.listen;
          routingMode = rendered.routing_mode;
          callToolTimeout = rendered.call_tool_timeout;
          toolDiscoveryInterval = rendered.tool_discovery_interval;
          ghStackEntryCount = builtins.length ghStackServers;
          ghStack = {
            name = ghStackServer.name or null;
            protocol = ghStackServer.protocol or null;
            command = builtins.unsafeDiscardStringContext (ghStackServer.command or "");
            args = ghStackServer.args or null;
            enabled = ghStackServer.enabled or false;
            quarantined = ghStackServer.quarantined or true;
            hasEnv = ghStackServer ? env;
            hasHeaders = ghStackServer ? headers;
            hasUrl = ghStackServer ? url;
            hasOauth = ghStackServer ? oauth;
            hasDiscoveryOverride = ghStackServer ? tool_discovery_interval;
          };
          githubEntryCount = builtins.length githubServers;
          github = {
            name = githubServer.name or null;
            protocol = githubServer.protocol or null;
            command = builtins.unsafeDiscardStringContext (githubServer.command or "");
            args = githubServer.args or [ ];
            enabled = githubServer.enabled or false;
            hasGithubTokenEnv = (githubServer ? env) && (githubServer.env ? GITHUB_PERSONAL_ACCESS_TOKEN);
          };
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

function assertGhStackHost(host, hostKey) {
  assert.equal(host.sourceExists, true, `${hostKey} declares gh-stack-mcp in home.mcp.extraServers`);
  assert.equal(host.sourceCount, 1, `${hostKey} declares gh-stack-mcp once`);
  assert.deepEqual(host.sourceAttributes, ['command'], `${hostKey} declaration has only command`);
  assert.match(host.sourcePackagePath, /\/[^/]*gh-stack-mcp-0\.1\.0$/, `${hostKey} uses the packaged 0.1.0 output`);
  assert.equal(
    host.sourceCommand,
    `${host.sourcePackagePath}/bin/gh-stack-mcp`,
    `${hostKey} source command points at the packaged executable`,
  );
  assert.equal(host.sourceHasType, false, `${hostKey} uses the stdio renderer default`);
  assert.equal(host.sourceHasArgs, false, `${hostKey} leaves args at the renderer default`);
  assert.equal(host.sourceHasEnv, false, `${hostKey} adds no environment or secret`);
  assert.equal(host.sourceHasHeaders, false, `${hostKey} adds no headers`);
  assert.equal(host.sourceHasUrl, false, `${hostKey} adds no URL/listener`);
  assert.equal(host.sourceHasOauth, false, `${hostKey} adds no OAuth credentials`);
  assert.equal(host.sourceHasDiscoveryOverride, false, `${hostKey} keeps the global listing default`);
  assert.deepEqual(host.installedGhStackPackages, [], `${hostKey} does not add gh-stack-mcp to home.packages`);
  assert.deepEqual(host.ghStackRelatedSecretNames, [], `${hostKey} adds no keychain secret`);
  assert.deepEqual(host.ghStackRelatedFileEnvNames, [], `${hostKey} adds no file-sourced secret`);

  assert.equal(host.listen, '127.0.0.1:8080', `${hostKey} keeps the existing proxy listener`);
  assert.equal(host.routingMode, 'retrieve_tools', `${hostKey} keeps retrieve_tools routing`);
  assert.equal(host.callToolTimeout, '15m15s', `${hostKey} keeps the shared call deadline`);
  assert.equal(host.toolDiscoveryInterval, '0s', `${hostKey} keeps the disabled global listing sweep`);

  assert.equal(host.ghStackEntryCount, 1, `${hostKey} renders exactly one gh-stack-mcp upstream`);
  assert.deepEqual(host.ghStack, {
    name: 'gh-stack-mcp',
    protocol: 'stdio',
    command: host.sourceCommand,
    args: [],
    enabled: true,
    quarantined: false,
    hasEnv: false,
    hasHeaders: false,
    hasUrl: false,
    hasOauth: false,
    hasDiscoveryOverride: false,
  }, `${hostKey} renders the packaged stdio upstream without extra fields`);

  assert.equal(host.githubEntryCount, 1, `${hostKey} preserves the existing GitHub MCP upstream`);
  assert.match(host.github.command, /\/bin\/github-mcp-server$/);
  assert.deepEqual(host.github, {
    name: 'github',
    protocol: 'stdio',
    command: host.github.command,
    args: ['stdio', '--toolsets=all'],
    enabled: true,
    hasGithubTokenEnv: true,
  }, `${hostKey} preserves the GitHub MCP Stack tool server`);

  assert.deepEqual(host.opencodeMcpNames, ['mcpproxy'], `${hostKey} keeps mcpproxy as the sole OpenCode MCP entry`);
  assert.deepEqual(host.opencodeMcpproxy, {
    enabled: true,
    timeout: 930000,
    type: 'remote',
    url: 'http://127.0.0.1:8080/mcp',
  }, `${hostKey} preserves the OpenCode proxy endpoint and timeout`);
}

test('both hosts render one packaged gh-stack-mcp stdio upstream through mcpproxy', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  assertGhStackHost(rendered.personal, 'personal');
  assertGhStackHost(rendered.shopify, 'Shopify');
  assert.equal(
    rendered.personal.sourcePackagePath,
    rendered.shopify.sourcePackagePath,
    'both hosts use the same gh-stack-mcp package output',
  );
});
