'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const PROXY_START_TIMEOUT_MS = 30_000;
const UPSTREAM_START_TIMEOUT_MS = 30_000;
const HTTP_REQUEST_TIMEOUT_MS = 10_000;
const STACK_TOOL_NAMES = Object.freeze([
  'stack_add',
  'stack_checkout',
  'stack_init',
  'stack_link',
  'stack_push',
  'stack_rebase',
  'stack_submit',
  'stack_sync',
  'stack_unstack',
  'stack_view',
]);
const STACK_MUTATION_TOOL_NAMES = Object.freeze(STACK_TOOL_NAMES.filter((name) => name !== 'stack_view'));
const STACK_TOOL_ARGUMENTS = Object.freeze({
  stack_view: {},
  stack_init: { trunk: 'main', branches: ['feature/one'] },
  stack_add: { branch: 'feature/one' },
  stack_checkout: { branch: 'feature/one' },
  stack_rebase: { action: 'start', scope: 'full' },
  stack_sync: { prune: false },
  stack_push: {},
  stack_submit: { open: false },
  stack_link: { branches: ['feature/one', 'feature/two'] },
  stack_unstack: { stackNumber: 1, mode: 'remoteAndLocal' },
});

function packageRoot(attribute, environmentName) {
  const configuredPath = process.env[environmentName];
  if (configuredPath) return configuredPath;

  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', `.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.${attribute}`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
    },
  ).trim().split('\n').at(-1);
}

function packagePaths() {
  const ghStackMcp = packageRoot('gh-stack-mcp', 'GH_STACK_MCP_PACKAGE_PATH');
  const mcpproxy = packageRoot('mcpproxy-go', 'MCPPROXY_PACKAGE_PATH');
  const ghStackMcpExecutable = path.join(ghStackMcp, 'bin/gh-stack-mcp');
  const mcpproxyExecutable = path.join(mcpproxy, 'bin/mcpproxy');

  assert.ok(fs.existsSync(ghStackMcpExecutable), `missing packaged Stack MCP executable: ${ghStackMcpExecutable}`);
  assert.ok(fs.existsSync(mcpproxyExecutable), `missing packaged mcpproxy executable: ${mcpproxyExecutable}`);

  return { ghStackMcpExecutable, mcpproxyExecutable };
}

function fixtureTool(name, description, annotations, properties = {}) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    annotations,
  };
}

function writeFixtureServer(directory, { mode, delayMs = 60_000 }) {
  const invocationPath = path.join(directory, `${mode}-invocations.log`);
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const viewAnnotations = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  };
  const mutationAnnotations = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  };
  const fixture = {
    invocationPath,
    delayMs,
    slowTool: mode === 'slow-stack' ? 'stack_push' : '',
    tools: mode === 'slow-stack'
      ? [
          fixtureTool(
            'stack_view',
            'Reads local Stack tracking and may refresh local metadata.',
            viewAnnotations,
            {
              path: { type: 'string' },
              remote: { type: 'string' },
            },
          ),
          fixtureTool(
            'stack_push',
            'Publishes Stack branches to the selected remote.',
            mutationAnnotations,
            {
              path: { type: 'string' },
              remote: { type: 'string' },
            },
          ),
        ]
      : [
          fixtureTool(
            'fixture_echo',
            'Returns a local fixture message.',
            readOnlyAnnotations,
            { message: { type: 'string' } },
          ),
        ],
  };
  const serverPath = path.join(directory, `${mode}-upstream.js`);
  const source = String.raw`
'use strict';

const fs = require('node:fs');
const fixture = ${JSON.stringify(fixture)};
let input = '';

function send(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handle(request) {
  if (!request || request.id === undefined) return;

  if (request.method === 'initialize') {
    send(request.id, {
      protocolVersion: request.params && request.params.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'gh-stack-mcp-proxy-fixture', version: '1.0.0' },
    });
    return;
  }

  if (request.method === 'ping') {
    send(request.id, {});
    return;
  }

  if (request.method === 'tools/list') {
    send(request.id, { tools: fixture.tools });
    return;
  }

  if (request.method === 'tools/call') {
    const name = request.params && request.params.name;
    const args = request.params && request.params.arguments || {};
    if (name === fixture.slowTool) {
      fs.appendFileSync(fixture.invocationPath, name + '\n');
      setTimeout(() => {
        send(request.id, { content: [{ type: 'text', text: 'slow fixture unexpectedly completed' }] });
      }, fixture.delayMs);
      return;
    }
    if (name === 'fixture_echo') {
      const message = String(args.message || '');
      send(request.id, {
        content: [{ type: 'text', text: 'fixture echo: ' + message }],
        structuredContent: { echo: message },
      });
      return;
    }
    if (name === 'stack_view') {
      send(request.id, { content: [{ type: 'text', text: 'fixture local Stack view' }] });
      return;
    }
    send(request.id, { content: [{ type: 'text', text: 'unknown fixture tool: ' + name }], isError: true });
    return;
  }

  sendError(request.id, -32601, 'method not found: ' + request.method);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, newline);
    input = input.slice(newline + 1);
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      process.stderr.write(String(error) + '\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
`;

  fs.writeFileSync(serverPath, source, { mode: 0o600 });
  return {
    invocationPath,
    server: {
      name: mode === 'slow-stack' ? 'gh-stack-mcp' : 'unrelated-fixture',
      command: process.execPath,
      args: [serverPath],
      enabled: true,
    },
  };
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function childHasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) return true;
  return new Promise((resolve) => {
    let timer;
    const onExit = () => finish(true);
    const finish = (exited) => {
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

async function stopChild(child) {
  if (childHasExited(child)) return;
  child.kill('SIGTERM');
  if (await waitForChildExit(child, 6_000)) return;
  child.kill('SIGKILL');
  assert.equal(await waitForChildExit(child, 2_000), true, 'mcpproxy did not exit after SIGKILL');
}

function proxyEnvironment(directory) {
  const env = {
    ...process.env,
    HOME: directory,
    XDG_CONFIG_HOME: path.join(directory, 'config'),
    XDG_DATA_HOME: path.join(directory, 'xdg-data'),
    XDG_STATE_HOME: path.join(directory, 'xdg-state'),
    TMPDIR: directory,
  };
  for (const name of [
    'GH_TOKEN',
    'GITHUB_TOKEN',
    'GH_ENTERPRISE_TOKEN',
    'MCP_GITHUB_TOKEN',
    'MCP_PROXY_AUTH_TOKEN',
    'MCPROXY_BEARER_TOKEN',
    'GH_HOST',
    'GH_REPO',
  ]) {
    delete env[name];
  }
  return env;
}

function redactProxyLogs(text) {
  return text
    .replace(/"api_key":\s*"[^"]+"/g, '"api_key":"[redacted]"')
    .replace(/apikey=[^&\s"]+/gi, 'apikey=[redacted]');
}

async function waitForProxyHealth(proxy) {
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  let lastError = 'not attempted';
  while (Date.now() < deadline) {
    if (childHasExited(proxy.child)) break;
    try {
      const response = await fetch(`${proxy.baseUrl}/healthz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) return;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(100);
  }
  throw new Error(`mcpproxy did not become healthy (${lastError})\n${redactProxyLogs(proxy.output.stderr)}`);
}

async function startProxy({ mcpServers, callToolTimeout = '30s' }) {
  const { mcpproxyExecutable } = packagePaths();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stack-mcp-proxy-'));
  const dataDir = path.join(directory, 'proxy-data');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  for (const name of ['config', 'xdg-data', 'xdg-state']) {
    fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
  }

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(directory, 'mcp_config.json');
  fs.writeFileSync(configPath, JSON.stringify({
    listen: `127.0.0.1:${port}`,
    routing_mode: 'retrieve_tools',
    call_tool_timeout: callToolTimeout,
    quarantine_enabled: false,
    require_mcp_auth: false,
    mcpServers,
  }));

  const output = { stderr: '' };
  const child = spawn(
    mcpproxyExecutable,
    [
      'serve',
      `--config=${configPath}`,
      `--data-dir=${dataDir}`,
      `--listen=127.0.0.1:${port}`,
      '--log-to-file=false',
      '--allow-server-add=false',
      '--allow-server-remove=false',
    ],
    {
      cwd: directory,
      env: proxyEnvironment(directory),
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { output.stderr += chunk; });

  const proxy = {
    baseUrl,
    child,
    directory,
    output,
    client: null,
    async close() {
      if (this.client) {
        await fetch(`${baseUrl}/mcp`, {
          method: 'DELETE',
          headers: { 'mcp-session-id': this.client.sessionId },
          signal: AbortSignal.timeout(1_000),
        }).catch(() => {});
      }
      try {
        await stopChild(child);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };

  try {
    await waitForProxyHealth(proxy);
    proxy.client = await connectMcpClient(baseUrl);
  } catch (error) {
    try {
      await stopChild(child);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
  return proxy;
}

async function connectMcpClient(baseUrl) {
  const url = `${baseUrl}/mcp`;
  const initializeResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'gh-stack-mcp-proxy-contract', version: '1.0.0' },
      },
    }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  const initializeText = await initializeResponse.text();
  assert.equal(initializeResponse.status, 200, `MCP initialize failed: ${initializeText}`);
  const initializeMessage = parseRpcMessage(initializeText);
  assert.ok(initializeMessage.result, `MCP initialize returned no result: ${initializeText}`);
  const sessionId = initializeResponse.headers.get('mcp-session-id');
  assert.ok(sessionId, 'MCP initialize did not return a session id');

  const client = { url, sessionId, nextRequestId: 2 };
  const notificationResponse = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'mcp-session-id': sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    signal: AbortSignal.timeout(HTTP_REQUEST_TIMEOUT_MS),
  });
  assert.equal(notificationResponse.status, 202, 'MCP initialized notification was not accepted');
  return client;
}

async function mcpRequest(client, method, params, timeoutMs = HTTP_REQUEST_TIMEOUT_MS) {
  const id = client.nextRequestId++;
  const response = await fetch(client.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'mcp-session-id': client.sessionId,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  assert.equal(response.status, 200, `MCP ${method} returned HTTP ${response.status}: ${text}`);
  const message = parseRpcMessage(text);
  assert.equal(message.id, id, `MCP ${method} returned a mismatched request id`);
  if (message.error) {
    throw new Error(`MCP ${method} returned JSON-RPC error: ${JSON.stringify(message.error)}`);
  }
  assert.ok(message.result, `MCP ${method} returned no result: ${text}`);
  return message.result;
}

function parseRpcMessage(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);

  const messages = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const message = messages.find((candidate) => candidate.jsonrpc === '2.0' && candidate.result)
    || messages.at(-1);
  assert.ok(message, `MCP response contained no JSON-RPC message: ${text}`);
  return message;
}

function callProxyTool(client, name, args, timeoutMs) {
  return mcpRequest(client, 'tools/call', { name, arguments: args }, timeoutMs);
}

function textFromResult(result) {
  const text = result.content?.find((item) => item.type === 'text')?.text;
  assert.equal(typeof text, 'string', `MCP tool result has no text content: ${JSON.stringify(result)}`);
  return text;
}

async function searchTools(client, query) {
  const result = await callProxyTool(client, 'retrieve_tools', {
    query,
    detail: 'full',
    limit: 100,
  });
  return JSON.parse(textFromResult(result));
}

function serverIndexed(output, serverName) {
  const serverIdentity = `"server": "${serverName}"`;
  return output.stderr.split(/\r?\n/).some((line) => (
    line.includes('Successfully indexed tools for server') && line.includes(serverIdentity)
  ));
}

async function waitForUpstreamIndex(proxy, serverName) {
  const deadline = Date.now() + UPSTREAM_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (serverIndexed(proxy.output, serverName)) return;
    if (childHasExited(proxy.child)) break;
    await sleep(50);
  }
  throw new Error(
    `mcpproxy did not index upstream ${serverName}\n${redactProxyLogs(proxy.output.stderr)}`,
  );
}

async function waitForUpstreamFailure(proxy, serverName) {
  const deadline = Date.now() + UPSTREAM_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const hasFailure = proxy.output.stderr.split(/\r?\n/).some((line) => (
      line.includes(`"server": "${serverName}"`)
      && /failed|error|not found|exec/i.test(line)
    ));
    if (hasFailure) return;
    if (childHasExited(proxy.child)) break;
    await sleep(50);
  }
  throw new Error(
    `mcpproxy did not report a startup failure for ${serverName}\n${redactProxyLogs(proxy.output.stderr)}`,
  );
}

async function waitForSearch(client, query, predicate, proxy) {
  const deadline = Date.now() + UPSTREAM_START_TIMEOUT_MS;
  let lastResult;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastResult = await searchTools(client, query);
      if (predicate(lastResult)) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw new Error(
    `proxy search did not return the expected tools; last result=${JSON.stringify(lastResult)}; last error=${lastError}\n${redactProxyLogs(proxy.output.stderr)}`,
  );
}

function routeArgs(toolName, pathValue, toolArguments = {}) {
  return {
    name: `gh-stack-mcp:${toolName}`,
    args: { path: pathValue, remote: 'origin', ...toolArguments },
    intent_reason: 'Verify the isolated proxy route without invoking the Stack extension',
    intent_data_sensitivity: 'internal',
  };
}

test('the Darwin flake check runs vendored Go contracts across all packages', () => {
  const flakeSource = fs.readFileSync(path.join(repoRoot, 'flake.nix'), 'utf8');
  const checkStart = flakeSource.indexOf('ghStackMcpChecks =');
  const checkEnd = flakeSource.indexOf('\n        in\n', checkStart);
  assert.ok(checkStart >= 0 && checkEnd > checkStart, 'the Stack MCP check block is present');
  const checkSource = flakeSource.slice(checkStart, checkEnd);

  assert.match(checkSource, /system == "aarch64-darwin"/, 'the check is Darwin-only');
  assert.match(checkSource, /pkgs\.gh-stack-mcp\.goModules/, 'the test uses the package-pinned vendor tree');
  assert.match(checkSource, /pkgs\.go_1_26/, 'the test uses the locked Go 1.26 toolchain');
  assert.match(checkSource, /go test -mod=vendor \.\/\.\.\./, 'all Go packages are tested offline');
  assert.match(checkSource, /pkgs\.gh-stack-mcp/, 'the production package remains a check dependency');
});

test('mcpproxy routes Stack view through write and every mutation through destructive', async () => {
  const { ghStackMcpExecutable } = packagePaths();
  const proxy = await startProxy({
    mcpServers: [{
      name: 'gh-stack-mcp',
      command: ghStackMcpExecutable,
      args: [],
      enabled: true,
    }],
  });

  try {
    await waitForUpstreamIndex(proxy, 'gh-stack-mcp');
    const query = `local Stack ${STACK_TOOL_NAMES.join(' ')}`;
    const discovered = await waitForSearch(
      proxy.client,
      query,
      (result) => result.tools?.filter((tool) => tool.server === 'gh-stack-mcp').length === STACK_TOOL_NAMES.length,
      proxy,
    );
    const stackTools = discovered.tools.filter((tool) => tool.server === 'gh-stack-mcp');
    const actualNames = stackTools.map((tool) => tool.name).sort();
    const expectedNames = STACK_TOOL_NAMES.map((name) => `gh-stack-mcp:${name}`).sort();
    assert.deepEqual(actualNames, expectedNames, 'proxy discovery returns the ten typed Stack tools');

    const view = stackTools.find((tool) => tool.name === 'gh-stack-mcp:stack_view');
    assert.ok(view, 'view tool is present');
    assert.equal(view.call_with, 'call_tool_write');
    assert.equal(view.annotations.readOnlyHint, false);
    assert.equal(view.annotations.destructiveHint, false);

    for (const toolName of STACK_MUTATION_TOOL_NAMES) {
      const tool = stackTools.find((candidate) => candidate.name === `gh-stack-mcp:${toolName}`);
      assert.ok(tool, `${toolName} is present`);
      assert.equal(tool.call_with, 'call_tool_destructive', `${toolName} uses the destructive route`);
      assert.equal(tool.annotations.readOnlyHint, false, `${toolName} is not advertised as read-only`);
      assert.equal(tool.annotations.destructiveHint, true, `${toolName} is destructive`);
    }

    const invalidWorktree = path.join(proxy.directory, 'missing-worktree');
    for (const toolName of STACK_TOOL_NAMES) {
      const tool = stackTools.find((candidate) => candidate.name === `gh-stack-mcp:${toolName}`);
      const result = await callProxyTool(
        proxy.client,
        tool.call_with,
        routeArgs(toolName, invalidWorktree, STACK_TOOL_ARGUMENTS[toolName]),
      );
      assert.equal(result.isError, true, `${toolName} rejects the invalid worktree`);
      assert.match(
        textFromResult(result),
        /worktree path must name an existing directory/i,
        `${toolName} rejects before invoking gh-stack`,
      );
    }
  } finally {
    await proxy.close();
  }
});

test('a missing Stack upstream reports its failure without blocking an unrelated upstream', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stack-mcp-missing-'));
  const unrelated = writeFixtureServer(directory, { mode: 'unrelated' });
  const proxy = await startProxy({
    mcpServers: [
      {
        name: 'gh-stack-mcp',
        command: path.join(directory, 'missing-gh-stack-mcp'),
        args: [],
        enabled: true,
      },
      unrelated.server,
    ],
  });

  try {
    await waitForUpstreamIndex(proxy, 'unrelated-fixture');
    await waitForUpstreamFailure(proxy, 'gh-stack-mcp');

    const search = await waitForSearch(
      proxy.client,
      'unrelated fixture echo tool',
      (result) => result.tools?.some((tool) => tool.name === 'unrelated-fixture:fixture_echo'),
      proxy,
    );
    const echoTool = search.tools.find((tool) => tool.name === 'unrelated-fixture:fixture_echo');
    assert.equal(echoTool.call_with, 'call_tool_read');
    assert.equal(search.tools.some((tool) => tool.server === 'gh-stack-mcp'), false);
    assert.match(redactProxyLogs(proxy.output.stderr), /gh-stack-mcp/);

    const echo = await callProxyTool(proxy.client, 'call_tool_read', {
      name: echoTool.name,
      args: { message: 'unrelated-upstream-still-callable' },
      intent_reason: 'Verify the unrelated fixture remains callable after Stack startup failure',
      intent_data_sensitivity: 'internal',
    });
    assert.match(JSON.stringify(echo), /unrelated-upstream-still-callable/);
  } finally {
    try {
      await proxy.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});

test('a shortened nested deadline bounds Stack calls while unrelated tools remain callable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-stack-mcp-deadline-'));
  const slowStack = writeFixtureServer(directory, { mode: 'slow-stack' });
  const unrelated = writeFixtureServer(directory, { mode: 'unrelated' });
  const proxy = await startProxy({
    callToolTimeout: '2s',
    mcpServers: [slowStack.server, unrelated.server],
  });

  try {
    await Promise.all([
      waitForUpstreamIndex(proxy, 'gh-stack-mcp'),
      waitForUpstreamIndex(proxy, 'unrelated-fixture'),
    ]);
    const query = 'local Stack stack_view stack_push unrelated fixture echo';
    const discovered = await waitForSearch(
      proxy.client,
      query,
      (result) => result.tools?.some((tool) => tool.name === 'gh-stack-mcp:stack_push')
        && result.tools?.some((tool) => tool.name === 'unrelated-fixture:fixture_echo'),
      proxy,
    );
    const stackPush = discovered.tools.find((tool) => tool.name === 'gh-stack-mcp:stack_push');
    assert.equal(stackPush.call_with, 'call_tool_destructive');

    const startedAt = Date.now();
    const timeoutResult = await callProxyTool(
      proxy.client,
      'call_tool_destructive',
      {
        name: stackPush.name,
        args: { path: '/fixture/no-worktree', remote: 'origin' },
        intent_reason: 'Exercise the isolated shortened proxy deadline against a delayed fixture',
        intent_data_sensitivity: 'internal',
      },
      8_000,
    );
    const elapsedMs = Date.now() - startedAt;
    assert.ok(fs.existsSync(slowStack.invocationPath), 'the delayed Stack fixture received the tool call');
    assert.match(fs.readFileSync(slowStack.invocationPath, 'utf8'), /stack_push/);
    assert.equal(timeoutResult.isError, true, 'the nested Stack call returns a timeout error');
    assert.ok(elapsedMs < 8_000, `the shortened 2s call deadline returned in ${elapsedMs}ms`);

    const echo = await callProxyTool(proxy.client, 'call_tool_read', {
      name: 'unrelated-fixture:fixture_echo',
      args: { message: 'unrelated-upstream-after-timeout' },
      intent_reason: 'Verify the unrelated fixture remains callable after the Stack timeout',
      intent_data_sensitivity: 'internal',
    });
    assert.match(JSON.stringify(echo), /unrelated-upstream-after-timeout/);
  } finally {
    try {
      await proxy.close();
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
});
