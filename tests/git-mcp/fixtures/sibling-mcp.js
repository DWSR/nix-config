'use strict';

const readline = require('node:readline');

function signingEnvironmentNames() {
  return Object.keys(process.env)
    .filter((name) => (
      name === 'GIT_SIGN_COMMITS'
      || name === 'SSH_SK_PROVIDER'
      || name === 'KEYCHAIN_CERTIFICATES'
      || name.startsWith('GIT_MCP_SIGNING_')
      || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(name)
    ))
    .sort();
}

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function respondError(id, code, message) {
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message },
  })}\n`);
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }

  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    respond(request.id, {
      protocolVersion: request.params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'git-mcp-isolation-sibling', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'ping') {
    respond(request.id, {});
    return;
  }
  if (request.method === 'tools/list') {
    respond(request.id, {
      tools: [{
        name: 'ping',
        description: 'Return an independent sibling liveness marker',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          properties: { marker: { type: 'string' } },
          required: ['marker'],
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      }],
    });
    return;
  }
  if (request.method === 'tools/call' && request.params?.name === 'ping') {
    const leakedNames = signingEnvironmentNames();
    respond(request.id, {
      content: [{
        type: 'text',
        text: [
          `sibling-pong:${request.params.arguments?.marker || ''}`,
          `signing-env:${leakedNames.length === 0 ? 'none' : leakedNames.join(',')}`,
        ].join(';'),
      }],
    });
    return;
  }
  respondError(request.id, -32601, `unsupported method: ${request.method}`);
});

process.on('SIGTERM', () => process.exit(0));
