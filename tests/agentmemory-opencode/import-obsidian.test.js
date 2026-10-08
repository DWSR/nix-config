'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const {
  assertPortAvailable,
  assertNoSecretOnDisk,
  createObsidianImportHarness,
  isProcessAlive,
  isProcessGroupAlive,
  isProcessIdentityAlive,
  listAllListeningProcesses,
  listListeningProcesses,
  refreshOwnedProcessRecords,
  startMockImportEndpoint,
  startPackagedAgentMemory,
  stopOwnedDaemon,
  withObsidianImportHarness,
} = require('./fixtures/obsidian-import-harness.js');

const repoRoot = path.resolve(__dirname, '../..');
const importerPath = path.join(repoRoot, 'scripts', 'agentmemory-import-obsidian.ts');
const importerPackageNixPath = path.join(repoRoot, 'scripts', 'agentmemory-import-obsidian.nix');
let cachedDependencyNodePath;
let cachedImporterNodeBin;
const cachedImporterPackagePaths = new Map();
let cachedAgentMemoryPackagePath;
let cachedMcpProxyPackagePath;

function agentMemoryPackagePath() {
  if (cachedAgentMemoryPackagePath) return cachedAgentMemoryPackagePath;
  const configured = process.env.AGENTMEMORY_PACKAGE_PATH;
  cachedAgentMemoryPackagePath = configured || execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.agentmemory'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
  return cachedAgentMemoryPackagePath;
}

function mcpProxyPackagePath() {
  if (cachedMcpProxyPackagePath) return cachedMcpProxyPackagePath;
  const configured = process.env.MCPPROXY_PACKAGE_PATH;
  cachedMcpProxyPackagePath = configured || execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.mcpproxy-go'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
  return cachedMcpProxyPackagePath;
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

async function startStockCoreProxy(harness, daemon) {
  const port = await freePort();
  const configPath = path.join(harness.configDir, 'mcp-config.json');
  const dataDir = path.join(harness.configDir, 'mcp-data');
  const proxyBinary = path.join(mcpProxyPackagePath(), 'bin/mcpproxy');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(configPath, JSON.stringify({
    listen: `127.0.0.1:${port}`,
    routing_mode: 'retrieve_tools',
    quarantine_enabled: false,
    require_mcp_auth: false,
    mcpServers: [{
      name: 'agentmemory',
      protocol: 'stdio',
      command: path.join(agentMemoryPackagePath(), 'bin/agentmemory'),
      args: ['mcp'],
      enabled: true,
      quarantined: false,
      env: {
        AGENTMEMORY_BM25_MAX_ENTRIES: '100000',
        AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES: '50000',
        AGENTMEMORY_URL: daemon.baseUrl,
        AGENTMEMORY_SECRET: '${env:AGENTMEMORY_BEARER}',
        AGENTMEMORY_TOOLS: 'core',
      },
    }],
  }));
  const output = { stderr: '' };
  const proxy = spawn(
    proxyBinary,
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
      cwd: harness.root,
      env: { ...process.env, HOME: harness.root, AGENTMEMORY_BEARER: harness.bearer },
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  proxy.stderr.setEncoding('utf8');
  proxy.stderr.on('data', (chunk) => { output.stderr += chunk; });

  const record = {
    child: proxy,
    pid: proxy.pid,
    processGroupId: proxy.pid,
    identity: configPath,
    identityMarkers: [configPath, dataDir],
    processOwnership: 'anchored',
    listenerIdentityMarkers: [proxyBinary, configPath, dataDir],
    listenerOwnerPids: [proxy.pid],
    listenerOwnerGroups: [proxy.pid],
    ownedPids: [proxy.pid],
    ownedProcessRecords: [{ pid: proxy.pid, processGroupId: proxy.pid, identity: configPath }],
    ownedProcessGroups: [{ processGroupId: proxy.pid, identity: configPath }],
    ownedListenerPids: [],
    ownedListenerRecords: [],
    ports: [port],
    output,
    cleanupTimeoutMs: harness.cleanupTimeoutMs,
    closed: false,
    async close() {
      await stopOwnedDaemon(record);
    },
  };
  harness.registerOwnedDaemon(record);
  record.claimNewListeners = () => refreshOwnedProcessRecords(record, Date.now() + 5_000);

  const deadline = Date.now() + 30_000;
  let lastError = 'not attempted';
  try {
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`);
        if (response.ok) {
          const startupOwnership = record.claimNewListeners();
          if (startupOwnership.probeErrors.length > 0) {
            throw new Error(`mcpproxy ownership discovery failed: ${startupOwnership.probeErrors.join(' | ')}`);
          }
          return {
            configPath,
            dataDir,
            port,
            proxy: record,
            output,
            root: harness.root,
            bearer: harness.bearer,
          };
        }
        lastError = `HTTP ${response.status}`;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (proxy.exitCode !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`mcpproxy did not become ready (${lastError})\n${output.stderr}`);
  } catch (error) {
    try {
      await stopOwnedDaemon(record);
    } catch (cleanupError) {
      const safeError = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      throw new Error(`${error instanceof Error ? error.message : String(error)}; proxy cleanup failed: ${safeError}`.replaceAll(harness.bearer, '[REDACTED]'));
    }
    throw new Error((error instanceof Error ? error.message : String(error)).replaceAll(harness.bearer, '[REDACTED]'));
  }
}

function callStockCore(proxyHarness, toolName, args) {
  const result = spawnSync(
    path.join(mcpProxyPackagePath(), 'bin/mcpproxy'),
    [
      'call',
      'tool-read',
      `--tool-name=agentmemory:${toolName}`,
      `--json_args=${JSON.stringify(args)}`,
      '--output=json',
      '--reason=Validate imported AgentMemory recall',
      '--sensitivity=internal',
      `--config=${proxyHarness.configPath}`,
      `--data-dir=${proxyHarness.dataDir}`,
    ],
    {
      cwd: proxyHarness.root,
      env: { ...process.env, HOME: proxyHarness.root, AGENTMEMORY_BEARER: proxyHarness.bearer },
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  proxyHarness.proxy.claimNewListeners?.();
  return JSON.parse(result.stdout);
}

async function waitForStockRecall(proxyHarness, query, requiredTerms) {
  const deadline = Date.now() + 30_000;
  let lastResult;
  let lastError;
  while (Date.now() < deadline) {
    try {
      lastResult = callStockCore(proxyHarness, 'memory_recall', { query, limit: 20 });
      const serialized = JSON.stringify(lastResult);
      if (requiredTerms.every((term) => serialized.includes(term))) return lastResult;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(
    `stock AgentMemory recall did not become ready: ${lastError?.message || JSON.stringify(lastResult)}`,
  );
}

function runDiscovery(vaultPath) {
  const script = `
    const { discoverSourceNotes } = require(${JSON.stringify(importerPath)});
    try {
      const result = discoverSourceNotes(${JSON.stringify(vaultPath)});
      process.stdout.write(JSON.stringify({
        sourcePath: result.sourcePath,
        discovered: result.discovered,
        notes: result.notes.map(({ relativePath, bytes, metadata }) => ({
          relativePath,
          bytes: bytes.toString('utf8'),
          metadata,
        })),
        skipped: result.skipped,
      }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    },
  );
}

function importerEnvironment() {
  const nodePaths = [
    process.env.NODE_PATH,
    process.env.AGENTMEMORY_OBSIDIAN_NODE_PATH,
    dependencyNodePath(),
  ]
    .filter(Boolean)
    .flatMap((value) => value.split(path.delimiter));
  return nodePaths.length > 0
    ? { ...process.env, NODE_PATH: [...new Set(nodePaths)].join(path.delimiter) }
    : process.env;
}

function dependencyNodePath() {
  if (cachedDependencyNodePath) return cachedDependencyNodePath;
  const configured = process.env.AGENTMEMORY_OBSIDIAN_NODE_PATH;
  const dependencyRoot = configured || execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.obsidian-importer-deps',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim().split('\n').at(-1);
  cachedDependencyNodePath = dependencyRoot.endsWith('/lib/node_modules')
    ? dependencyRoot
    : path.join(dependencyRoot, 'lib', 'node_modules');
  return cachedDependencyNodePath;
}

function importerNodeBin() {
  if (cachedImporterNodeBin) return cachedImporterNodeBin;
  const configured = process.env.AGENTMEMORY_OBSIDIAN_NODE_BIN;
  if (configured) {
    cachedImporterNodeBin = configured;
    return cachedImporterNodeBin;
  }
  const nodePackage = execFileSync(
    'nix',
    ['eval', '--raw', '.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.nodejs_22'],
    { cwd: repoRoot, encoding: 'utf8' },
  ).trim();
  cachedImporterNodeBin = path.join(nodePackage, 'bin', 'node');
  return cachedImporterNodeBin;
}

function importerPackagePath(restEndpoint = 'http://127.0.0.1:3111') {
  if (cachedImporterPackagePaths.has(restEndpoint)) {
    return cachedImporterPackagePaths.get(restEndpoint);
  }
  const configured = process.env.AGENTMEMORY_OBSIDIAN_IMPORTER_BIN;
  if (configured && restEndpoint === 'http://127.0.0.1:3111') {
    cachedImporterPackagePaths.set(restEndpoint, configured);
    return configured;
  }

  const expression = `(let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    pkgs = import flake.inputs.nixpkgs {
      system = "aarch64-darwin";
      overlays = [ flake.outputs.overlays.custom-packages ];
    };
  in (pkgs.callPackage ${JSON.stringify(importerPackageNixPath)} {
    bearerReference = "fixture-bearer";
    restEndpoint = ${JSON.stringify(restEndpoint)};
  }).drvPath)`;
  const drvPath = execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const packagePath = `${execFileSync('nix-store', ['--realise', drvPath], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim().split('\n').at(-1)}/bin/agentmemory-import-obsidian`;
  cachedImporterPackagePaths.set(restEndpoint, packagePath);
  return packagePath;
}

function runPackagedObsidianImporter(restEndpoint, args, extraEnv = {}) {
  return spawnSync(
    importerPackagePath(restEndpoint),
    args,
    {
      cwd: repoRoot,
      env: { ...process.env, ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function runPackagedObsidianImporterAsync(restEndpoint, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      importerPackagePath(restEndpoint),
      args,
      {
        cwd: repoRoot,
        env: { ...process.env, ...extraEnv },
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

function runMapping(vaultPath, capturedAt = '2026-09-15T01:00:00.000Z') {
  const script = `
    const { discoverSourceNotes, mapSourceNotes } = require(${JSON.stringify(importerPath)});
    try {
      const discovery = discoverSourceNotes(${JSON.stringify(vaultPath)});
      const outcomes = mapSourceNotes(discovery.notes, ${JSON.stringify(capturedAt)});
      process.stdout.write(JSON.stringify({ outcomes }));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(
    importerNodeBin(),
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: importerEnvironment(),
      encoding: 'utf8',
    },
  );
}

function readMapping(vaultPath) {
  const result = runMapping(vaultPath);
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

function assertRuntimeMemory(memory) {
  assert.equal(typeof memory.id, 'string');
  assert.match(memory.id, /^mem_obsidian_[0-9a-f]{64}$/);
  assert.match(memory.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(memory.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof memory.type, 'string');
  assert.equal(typeof memory.title, 'string');
  assert.equal(typeof memory.content, 'string');
  assert.ok(Array.isArray(memory.concepts));
  assert.ok(Array.isArray(memory.files));
  assert.ok(Array.isArray(memory.sessionIds));
  assert.equal(memory.strength, 1);
  assert.equal(memory.version, 1);
  assert.equal(memory.isLatest, true);
  assert.equal(memory.origin.channel, 'import');
  assert.equal(typeof memory.origin.detail, 'string');
  assert.match(memory.origin.capturedAt, /^\d{4}-\d{2}-\d{2}T/);
}

function validateMemory(memory) {
  const script = `
    const { isImportedMemory } = require(${JSON.stringify(importerPath)});
    const memory = ${JSON.stringify(memory)};
    process.stdout.write(JSON.stringify({ valid: isImportedMemory(memory) }));
  `;
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: process.env,
      encoding: 'utf8',
    },
  );
}

function runImporterProbe(script) {
  return spawnSync(
    importerNodeBin(),
    ['--experimental-strip-types', '-e', script],
    {
      cwd: repoRoot,
      env: importerEnvironment(),
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function runObsidianImporter(vaultPath, args = [], extraEnv = {}) {
  return spawnSync(
    importerNodeBin(),
    ['--experimental-strip-types', importerPath, vaultPath, '--json', ...args],
    {
      cwd: repoRoot,
      env: { ...importerEnvironment(), ...extraEnv },
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    },
  );
}

function runObsidianImporterAsync(vaultPath, args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      importerNodeBin(),
      ['--experimental-strip-types', importerPath, vaultPath, '--json', ...args],
      {
        cwd: repoRoot,
        env: { ...importerEnvironment(), ...extraEnv },
      },
    );
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('close', (status) => resolve({
      status,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    }));
  });
}

async function startObsidianMock(handler) {
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', async () => {
      const raw = Buffer.concat(chunks);
      let payload = null;
      try {
        payload = JSON.parse(raw.toString('utf8'));
      } catch {
        // The importer only sends JSON; leave malformed test responses to the handler.
      }
      const requestInfo = {
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
        raw,
        payload,
      };
      requests.push(requestInfo);
      try {
        const result = await handler(requestInfo);
        const body = typeof result.body === 'string' ? result.body : JSON.stringify(result.body);
        response.writeHead(result.status || 200, { 'content-type': 'application/json' });
        response.end(body);
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function writeObsidianNote(vaultPath, name, body) {
  fs.writeFileSync(path.join(vaultPath, 'memories', name), body);
}

function successfulImportResponse(payload, stored) {
  const counts = { success: true, strategy: 'skip', sessions: 0, observations: 0, memories: 0, summaries: 0, skipped: 0 };
  for (const memory of payload.exportData.memories) {
    if (stored.has(memory.id)) {
      counts.skipped += 1;
    } else {
      stored.set(memory.id, JSON.parse(JSON.stringify(memory)));
      counts.memories += 1;
    }
  }
  return counts;
}

function largeNoteBody(title, size = 4_300_000) {
  return `# ${title}\n\n${'x'.repeat(size)}\n`;
}

function spawnDetachedDescendantFixture(marker, pidFile) {
  const descendantSource = [
    "const fs = require('node:fs');",
    'const marker = process.argv[1];',
    'const pidFile = process.argv[2];',
    'void marker;',
    'fs.writeFileSync(pidFile, String(process.pid));',
    "process.on('SIGTERM', () => {});",
    'setTimeout(() => process.exit(0), 30_000);',
  ].join('\n');
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    'const marker = process.argv[1];',
    'const descendantSource = process.argv[2];',
    'const pidFile = process.argv[3];',
    'process.on(\'SIGTERM\', () => {',
    "  const child = spawn(process.execPath, ['-e', descendantSource, marker, pidFile], { detached: true, stdio: 'ignore' });",
    '  child.unref();',
    '});',
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return spawn(
    process.execPath,
    ['-e', parentSource, marker, descendantSource, pidFile],
    { detached: true, stdio: 'ignore' },
  );
}

function spawnUnmarkedGroupDescendantFixture(marker, pidFile) {
  const childSource = [
    "const fs = require('node:fs');",
    'const pidFile = process.argv[1];',
    'fs.writeFileSync(pidFile, String(process.pid));',
    "process.on('SIGTERM', () => {});",
    'setTimeout(() => process.exit(0), 30_000);',
  ].join('\n');
  const parentSource = [
    "const { spawn } = require('node:child_process');",
    'const childSource = process.argv[2];',
    'const pidFile = process.argv[3];',
    "spawn(process.execPath, ['-e', childSource, pidFile], { stdio: 'ignore' });",
    'setInterval(() => {}, 1000);',
  ].join('\n');
  return spawn(
    process.execPath,
    ['-e', parentSource, marker, childSource, pidFile],
    { detached: true, stdio: 'ignore' },
  );
}

function spawnDetachedListenerFixture(readyFile, { marker = '', port = 0, host = '127.0.0.1' } = {}) {
  const source = [
    "const fs = require('node:fs');",
    "const net = require('node:net');",
    'const readyFile = process.argv[1];',
    'const marker = process.argv[2];',
    'const port = Number(process.argv[3]);',
    'const host = process.argv[4];',
    'void marker;',
    'const server = net.createServer(() => {});',
    'server.listen(port, host, () => {',
    '  fs.writeFileSync(readyFile, String(server.address().port));',
    '});',
    "process.on('SIGTERM', () => {});",
    'setTimeout(() => process.exit(0), 30_000);',
  ].join('\n');
  return spawn(
    process.execPath,
    ['-e', source, readyFile, marker, String(port), host],
    { detached: true, stdio: 'ignore' },
  );
}

async function waitForFile(filePath, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`file ${filePath} did not appear`);
}

function runIsolatedListenerProbe(fakeBinDir, ports, deadlineMs, timeoutMs = deadlineMs + 500) {
  const script = `
    const { listListeningProcesses } = require(${JSON.stringify(
      path.join(__dirname, 'fixtures', 'obsidian-import-harness.js'),
    )});
    try {
      process.stdout.write(JSON.stringify(listListeningProcesses(${JSON.stringify(ports)}, Date.now() + ${deadlineMs})));
    } catch (error) {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  `;
  return spawnSync(
    process.execPath,
    ['-e', script],
    {
      env: { ...process.env, PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}` },
      encoding: 'utf8',
      timeout: timeoutMs,
    },
  );
}

async function waitForProcessGroup(processGroupId, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (isProcessGroupAlive(processGroupId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`process group ${processGroupId} did not become alive`);
}

function killProcessGroup(processGroupId) {
  try {
    process.kill(-processGroupId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error;
  }
}

function importedMemoryFixture(sourcePath = 'memories/fixture.md', content = 'fixture body') {
  const timestamp = '2026-09-15T01:00:00.000Z';
  return {
    id: `mem_obsidian_${crypto.createHash('sha256').update(sourcePath).digest('hex')}`,
    createdAt: timestamp,
    updatedAt: timestamp,
    type: 'fact',
    title: 'Fixture',
    content,
    concepts: [`obsidian-source:${sourcePath}`],
    files: [sourcePath],
    sessionIds: [],
    strength: 1,
    version: 1,
    isLatest: true,
    origin: {
      channel: 'import',
      detail: JSON.stringify({ sourcePath, tags: [], sessions: [] }),
      capturedAt: timestamp,
    },
  };
}

function snapshotTree(root) {
  const entries = [];
  const visit = (currentPath) => {
    for (const name of fs.readdirSync(currentPath).sort()) {
      const entryPath = path.join(currentPath, name);
      const relativePath = path.relative(root, entryPath);
      const metadata = fs.lstatSync(entryPath);
      const entry = {
        relativePath,
        mode: metadata.mode,
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        birthtimeMs: metadata.birthtimeMs,
        dev: metadata.dev,
        ino: metadata.ino,
        nlink: metadata.nlink,
      };
      if (metadata.isSymbolicLink()) {
        entry.link = fs.readlinkSync(entryPath);
      } else if (metadata.isDirectory()) {
        visit(entryPath);
      } else if (metadata.isFile()) {
        entry.digest = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
      }
      entries.push(entry);
    }
  };
  visit(root);
  return entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

function snapshotEntry(entryPath) {
  const metadata = fs.lstatSync(entryPath);
  const entry = {
    mode: metadata.mode,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    birthtimeMs: metadata.birthtimeMs,
    dev: metadata.dev,
    ino: metadata.ino,
    nlink: metadata.nlink,
  };
  if (metadata.isSymbolicLink()) entry.link = fs.readlinkSync(entryPath);
  if (metadata.isFile()) {
    entry.digest = crypto.createHash('sha256').update(fs.readFileSync(entryPath)).digest('hex');
  }
  return entry;
}

function createVault() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-source-'));
  fs.mkdirSync(path.join(root, 'memories'));
  return root;
}

test('selects sorted direct Markdown children and excludes nested or unrelated files', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  fs.writeFileSync(path.join(memoriesPath, '2026-01-b.md'), '# B\n\nB body\n');
  fs.writeFileSync(path.join(memoriesPath, '2026-01-a.md'), '# A\n\nA body\n');
  fs.writeFileSync(path.join(memoriesPath, 'attachment.txt'), 'not a note\n');
  fs.mkdirSync(path.join(memoriesPath, 'nested'));
  fs.writeFileSync(path.join(memoriesPath, 'nested', '2026-01-nested.md'), '# Nested\n');
  const before = snapshotTree(vaultPath);

  try {
    const result = runDiscovery(vaultPath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.discovered, 2);
    assert.deepEqual(
      report.notes.map(({ relativePath }) => relativePath),
      ['memories/2026-01-a.md', 'memories/2026-01-b.md'],
    );
    assert.deepEqual(
      report.notes.map(({ bytes }) => bytes),
      ['# A\n\nA body\n', '# B\n\nB body\n'],
    );
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(snapshotTree(vaultPath), before);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('reports non-regular entries and in-tree or escaping symlinks without reading targets', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const outsidePath = path.join(path.dirname(vaultPath), 'agentmemory-obsidian-outside.md');
  fs.writeFileSync(path.join(memoriesPath, 'valid.md'), '# Valid\n');
  fs.writeFileSync(path.join(memoriesPath, 'inside-target.md'), '# Inside target\n');
  fs.mkdirSync(path.join(memoriesPath, 'directory.md'));
  fs.writeFileSync(path.join(memoriesPath, 'directory.md', 'nested.md'), '# Nested\n');
  fs.symlinkSync('inside-target.md', path.join(memoriesPath, 'inside-link.md'));
  fs.writeFileSync(outsidePath, '# Outside target\n');
  fs.symlinkSync(outsidePath, path.join(memoriesPath, 'escaping-link.md'));
  const before = snapshotTree(vaultPath);
  const outsideBefore = snapshotEntry(outsidePath);

  try {
    const result = runDiscovery(vaultPath);
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(
      report.notes.map(({ relativePath }) => relativePath),
      ['memories/inside-target.md', 'memories/valid.md'],
    );
    assert.deepEqual(
      report.skipped.map(({ relativePath }) => relativePath),
      ['memories/directory.md', 'memories/escaping-link.md', 'memories/inside-link.md'],
    );
    assert.equal(report.skipped.find(({ relativePath }) => relativePath.endsWith('directory.md')).reason, 'non-regular entry');
    assert.equal(report.skipped.find(({ relativePath }) => relativePath.endsWith('inside-link.md')).reason, 'symlink');
    assert.equal(
      report.skipped.find(({ relativePath }) => relativePath.endsWith('escaping-link.md')).reason,
      'path escapes memories directory',
    );
    assert.deepEqual(snapshotTree(vaultPath), before);
    assert.deepEqual(snapshotEntry(outsidePath), outsideBefore);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
    fs.rmSync(outsidePath, { force: true });
  }
});

test('rejects relative and missing roots before source or target access', () => {
  const relative = runDiscovery('relative-vault');
  assert.equal(relative.status, 1);
  assert.match(relative.stderr, /vault path must be absolute/);

  const missingPath = path.join(os.tmpdir(), `agentmemory-obsidian-missing-${process.pid}`);
  fs.rmSync(missingPath, { recursive: true, force: true });
  const missing = runDiscovery(missingPath);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /vault path does not exist/);

  const missingMemoriesVault = createVault();
  fs.rmSync(path.join(missingMemoriesVault, 'memories'), { recursive: true, force: true });
  try {
    const missingMemories = runDiscovery(missingMemoriesVault);
    assert.equal(missingMemories.status, 1);
    assert.match(missingMemories.stderr, /memories directory does not exist/);
  } finally {
    fs.rmSync(missingMemoriesVault, { recursive: true, force: true });
  }

  const unreadableVault = createVault();
  const unreadableSource = path.join(unreadableVault, 'memories', 'source.md');
  fs.writeFileSync(unreadableSource, '# Source\n');
  const sourceBefore = snapshotEntry(unreadableSource);
  const originalMode = fs.statSync(unreadableVault).mode;
  fs.chmodSync(unreadableVault, 0o000);
  try {
    const unreadable = runDiscovery(unreadableVault);
    assert.equal(unreadable.status, 1);
    assert.match(unreadable.stderr, /vault path is not readable/);
  } finally {
    fs.chmodSync(unreadableVault, originalMode);
    assert.deepEqual(snapshotEntry(unreadableSource), sourceBefore);
    fs.rmSync(unreadableVault, { recursive: true, force: true });
  }
});

test('rejects an unreadable memories root without changing its metadata', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const sourcePath = path.join(memoriesPath, 'source.md');
  fs.writeFileSync(sourcePath, '# Source\n');
  const sourceBefore = snapshotEntry(sourcePath);
  const originalMode = fs.statSync(memoriesPath).mode;
  fs.chmodSync(memoriesPath, 0o000);
  const inaccessibleRootBefore = snapshotEntry(memoriesPath);

  try {
    let result;
    try {
      result = runDiscovery(vaultPath);
      assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /memories directory is not readable/);
      assert.deepEqual(snapshotEntry(memoriesPath), inaccessibleRootBefore);
    } finally {
      fs.chmodSync(memoriesPath, originalMode);
    }
    assert.deepEqual(snapshotEntry(sourcePath), sourceBefore);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('maps canonical notes to complete memories with searchable provenance and exact bodies', () => {
  const vaultPath = createVault();
  const notePath = path.join(vaultPath, 'memories', '2026-05-13-canonical.md');
  const body = '# Canonical migration memory\n\nCurated credential: keep-this-body\n';
  fs.writeFileSync(notePath, [
    '---',
    'date: 2026-05-13',
    'project: agentmemory-enhancements',
    'tags:',
    '  - memory',
    '  - architecture',
    '  - agentmemory-enhancements',
    '  - architecture',
    'sessions:',
    '  - 2026-05-13T143022',
    '  - legacy-session-2',
    'ignored: true',
    '---',
    body,
  ].join('\n'));

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, 1);
    assert.equal(report.outcomes[0].kind, 'prepared');
    const memory = report.outcomes[0].memory;
    assertRuntimeMemory(memory);

    const sourcePath = 'memories/2026-05-13-canonical.md';
    const expectedId = `mem_obsidian_${crypto.createHash('sha256').update(sourcePath).digest('hex')}`;
    assert.equal(memory.id, expectedId);
    assert.equal(memory.createdAt, '2026-05-13T00:00:00.000Z');
    assert.equal(memory.updatedAt, memory.createdAt);
    assert.equal(memory.type, 'architecture');
    assert.equal(memory.title, 'Canonical migration memory');
    assert.equal(memory.content, body);
    assert.deepEqual(memory.concepts, [
      'architecture',
      'obsidian-source:memories/2026-05-13-canonical.md',
    ]);
    assert.deepEqual(memory.files, [sourcePath]);
    assert.deepEqual(memory.sessionIds, []);
    assert.equal(memory.project, 'agentmemory-enhancements');
    assert.equal(memory.origin.capturedAt, '2026-09-15T01:00:00.000Z');
    assert.deepEqual(JSON.parse(memory.origin.detail), {
      sourcePath,
      tags: ['memory', 'architecture', 'agentmemory-enhancements', 'architecture'],
      sessions: ['2026-05-13T143022', 'legacy-session-2'],
    });
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('maps frontmatter-free notes through filename and mtime fallbacks without changing body bytes', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const filenameDatePath = path.join(memoriesPath, '2026-06-07-fallback.md');
  const filenameDateBody = 'plain body with CRLF\r\n\r\nbody with CRLF\r\n';
  fs.writeFileSync(filenameDatePath, filenameDateBody);
  const mtimePath = path.join(memoriesPath, 'legacy-note.md');
  const mtimeBody = 'plain legacy body\n';
  fs.writeFileSync(mtimePath, mtimeBody);
  const expectedMtime = new Date('2024-02-03T04:05:06.000Z');
  fs.utimesSync(mtimePath, expectedMtime, expectedMtime);

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, 2);
    const byPath = new Map(report.outcomes.map((outcome) => [outcome.relativePath, outcome]));
    const filenameDate = byPath.get('memories/2026-06-07-fallback.md');
    const mtime = byPath.get('memories/legacy-note.md');
    assert.equal(filenameDate.kind, 'prepared');
    assert.equal(mtime.kind, 'prepared');
    assertRuntimeMemory(filenameDate.memory);
    assertRuntimeMemory(mtime.memory);

    assert.equal(filenameDate.memory.title, '2026-06-07-fallback');
    assert.equal(filenameDate.memory.createdAt, '2026-06-07T00:00:00.000Z');
    assert.equal(filenameDate.memory.type, 'fact');
    assert.equal(filenameDate.memory.content, filenameDateBody);
    assert.deepEqual(filenameDate.memory.concepts, [
      'obsidian-source:memories/2026-06-07-fallback.md',
    ]);
    assert.equal(filenameDate.memory.project, undefined);

    assert.equal(mtime.memory.title, 'legacy-note');
    assert.equal(mtime.memory.createdAt, expectedMtime.toISOString());
    assert.equal(mtime.memory.updatedAt, expectedMtime.toISOString());
    assert.equal(mtime.memory.content, mtimeBody);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('strictly validates timestamp components while accepting valid ISO forms', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const fixtures = {
    'quoted-invalid-timestamp.md': '2026-02-29T00:00:00Z',
    'invalid-time-timestamp.md': '2026-05-13T24:00:00Z',
    'invalid-minute-timestamp.md': '2026-05-13T23:60:00Z',
    'valid-z-timestamp.md': '2026-05-13T14:30:22Z',
    'valid-offset-timestamp.md': '2026-05-13T14:30:22.123-04:00',
    'valid-minute-timestamp.md': '2026-05-13T14:30Z',
  };
  for (const [name, timestamp] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(memoriesPath, name), [
      '---',
      `date: ${JSON.stringify(timestamp)}`,
      '---',
      `# ${name}`,
      '',
      'timestamp body',
      '',
    ].join('\n'));
  }

  try {
    const report = readMapping(vaultPath);
    const byPath = new Map(report.outcomes.map((outcome) => [outcome.relativePath, outcome]));
    for (const name of [
      'quoted-invalid-timestamp.md',
      'invalid-time-timestamp.md',
      'invalid-minute-timestamp.md',
    ]) {
      const outcome = byPath.get(`memories/${name}`);
      assert.equal(outcome.kind, 'skipped', name);
      assert.match(outcome.reason, /date/i, name);
    }

    const expectedTimestamps = {
      'valid-z-timestamp.md': '2026-05-13T14:30:22.000Z',
      'valid-offset-timestamp.md': '2026-05-13T18:30:22.123Z',
      'valid-minute-timestamp.md': '2026-05-13T14:30:00.000Z',
    };
    for (const [name, expectedTimestamp] of Object.entries(expectedTimestamps)) {
      const outcome = byPath.get(`memories/${name}`);
      assert.equal(outcome.kind, 'prepared', name);
      assertRuntimeMemory(outcome.memory);
      assert.equal(outcome.memory.createdAt, expectedTimestamp, name);
      assert.equal(outcome.memory.updatedAt, expectedTimestamp, name);
    }
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('reports malformed frontmatter types, delimiters, and empty bodies as mapping skips', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const fixtures = {
    'broken-delimiter.md': '---\nproject: example\n# missing closing delimiter\n',
    'invalid-yaml.md': '---\ntags: [unclosed\n---\nbody\n',
    'invalid-date.md': '---\ndate: 42\n---\nbody\n',
    'invalid-calendar-date.md': '---\ndate: 2026-02-29\n---\nbody\n',
    'invalid-project.md': '---\nproject:\n  - example\n---\nbody\n',
    'invalid-tags.md': '---\ntags: architecture\n---\nbody\n',
    'invalid-sessions.md': '---\nsessions: legacy-session\n---\nbody\n',
    'null-frontmatter.md': '---\nnull\n---\nbody\n',
    'empty-frontmatter.md': '---\n---\nbody\n',
    'scalar-frontmatter.md': '---\nplain scalar\n---\nbody\n',
    'empty-body.md': '---\nproject: example\n---\n \n\t\n',
  };
  for (const [name, content] of Object.entries(fixtures)) {
    fs.writeFileSync(path.join(memoriesPath, name), content);
  }

  try {
    const report = readMapping(vaultPath);
    assert.equal(report.outcomes.length, Object.keys(fixtures).length);
    const skipped = new Map(
      report.outcomes.map((outcome) => [outcome.relativePath, outcome]),
    );
    for (const name of Object.keys(fixtures)) {
      const outcome = skipped.get(`memories/${name}`);
      assert.equal(outcome.kind, 'skipped', name);
      assert.equal(outcome.relativePath, `memories/${name}`, name);
      assert.equal(typeof outcome.reason, 'string', name);
      assert.notEqual(outcome.reason.length, 0, name);
    }
    assert.match(skipped.get('memories/broken-delimiter.md').reason, /closing delimiter/i);
    assert.match(skipped.get('memories/invalid-yaml.md').reason, /yaml/i);
    assert.match(skipped.get('memories/invalid-date.md').reason, /date/i);
    assert.match(skipped.get('memories/invalid-calendar-date.md').reason, /date/i);
    assert.match(skipped.get('memories/invalid-project.md').reason, /project/i);
    assert.match(skipped.get('memories/invalid-tags.md').reason, /tags/i);
    assert.match(skipped.get('memories/invalid-sessions.md').reason, /sessions/i);
    assert.match(skipped.get('memories/null-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/empty-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/scalar-frontmatter.md').reason, /yaml mapping/i);
    assert.match(skipped.get('memories/empty-body.md').reason, /empty body/i);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('runtime validation rejects records that violate importer invariants', () => {
  const vaultPath = createVault();
  const notePath = path.join(vaultPath, 'memories', 'guard.md');
  fs.writeFileSync(notePath, '# Guard\n\nValid body\n');

  try {
    const memory = readMapping(vaultPath).outcomes[0].memory;
    assertRuntimeMemory(memory);
    const validResult = validateMemory(memory);
    assert.equal(validResult.status, 0, `${validResult.stderr}\n${validResult.stdout}`);
    assert.deepEqual(JSON.parse(validResult.stdout), { valid: true });

    const mutations = {
      'non-normalized source path': (candidate) => {
        candidate.files[0] = 'memories/./guard.md';
        candidate.id = `mem_obsidian_${crypto.createHash('sha256').update(candidate.files[0]).digest('hex')}`;
        candidate.concepts = candidate.concepts.map(
          (concept) => concept.startsWith('obsidian-source:')
            ? `obsidian-source:${candidate.files[0]}`
            : concept,
        );
        const detail = JSON.parse(candidate.origin.detail);
        detail.sourcePath = candidate.files[0];
        candidate.origin.detail = JSON.stringify(detail);
      },
      'source identity mismatch': (candidate) => {
        candidate.id = `mem_obsidian_${'0'.repeat(64)}`;
      },
      'empty content': (candidate) => {
        candidate.content = ' \n\t';
      },
      'missing provenance concept': (candidate) => {
        candidate.concepts = candidate.concepts.filter(
          (concept) => !concept.startsWith('obsidian-source:'),
        );
      },
      'updated timestamp mismatch': (candidate) => {
        candidate.updatedAt = new Date(Date.parse(candidate.createdAt) + 1000).toISOString();
      },
    };

    for (const [label, mutate] of Object.entries(mutations)) {
      const candidate = JSON.parse(JSON.stringify(memory));
      mutate(candidate);
      const result = validateMemory(candidate);
      assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
      assert.deepEqual(JSON.parse(result.stdout), { valid: false }, label);
    }
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('keeps same-path identities across content changes and changes identity after rename', () => {
  const vaultPath = createVault();
  const memoriesPath = path.join(vaultPath, 'memories');
  const originalPath = path.join(memoriesPath, 'stable-path.md');
  fs.writeFileSync(originalPath, '# First body\n');

  try {
    const first = readMapping(vaultPath).outcomes[0].memory;
    fs.writeFileSync(originalPath, '# Changed body\n');
    const changed = readMapping(vaultPath).outcomes[0].memory;
    assert.equal(changed.id, first.id);
    assert.notEqual(changed.content, first.content);

    const renamedPath = path.join(memoriesPath, 'renamed-path.md');
    fs.renameSync(originalPath, renamedPath);
    const renamed = readMapping(vaultPath).outcomes[0].memory;
    assert.notEqual(renamed.id, changed.id);
    assert.deepEqual(renamed.files, ['memories/renamed-path.md']);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('validates every field of the complete memory-only import request', () => {
  const memory = importedMemoryFixture();
  const timestamp = '2026-09-15T01:00:00.000Z';
  const probe = runImporterProbe(`
    const { isImportRequest } = require(${JSON.stringify(importerPath)});
    const memory = ${JSON.stringify(memory)};
    const timestamp = ${JSON.stringify(timestamp)};
    const request = {
      exportData: {
        version: '0.9.29',
        exportedAt: timestamp,
        sessions: [],
        observations: {},
        memories: [memory],
        summaries: [],
      },
      strategy: 'skip',
    };
    const clone = () => JSON.parse(JSON.stringify(request));
    const mutations = {
      'top-level value': () => null,
      'missing exportData': () => {
        const candidate = clone();
        delete candidate.exportData;
        return candidate;
      },
      'invalid strategy': () => {
        const candidate = clone();
        candidate.strategy = 'merge';
        return candidate;
      },
      'extra top-level field': () => {
        const candidate = clone();
        candidate.extra = true;
        return candidate;
      },
      'invalid version': () => {
        const candidate = clone();
        candidate.exportData.version = '0.9.28';
        return candidate;
      },
      'invalid exportedAt': () => {
        const candidate = clone();
        candidate.exportData.exportedAt = '2026-02-29';
        return candidate;
      },
      'non-empty sessions': () => {
        const candidate = clone();
        candidate.exportData.sessions = [{}];
        return candidate;
      },
      'non-empty observations': () => {
        const candidate = clone();
        candidate.exportData.observations = { session: [] };
        return candidate;
      },
      'non-array memories': () => {
        const candidate = clone();
        candidate.exportData.memories = {};
        return candidate;
      },
      'invalid memory': () => {
        const candidate = clone();
        candidate.exportData.memories[0].content = ' \\n\\t';
        return candidate;
      },
      'non-empty summaries': () => {
        const candidate = clone();
        candidate.exportData.summaries = [{}];
        return candidate;
      },
      'extra exportData field': () => {
        const candidate = clone();
        candidate.exportData.extra = true;
        return candidate;
      },
    };
    const result = {
      valid: isImportRequest(request),
      invalid: Object.fromEntries(
        Object.entries(mutations).map(([label, mutate]) => [label, isImportRequest(mutate())]),
      ),
    };
    process.stdout.write(JSON.stringify(result));
  `);
  assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.valid, true);
  assert.deepEqual(
    Object.keys(result.invalid).filter((label) => result.invalid[label]),
    [],
  );
});

test('builds lexical memory-only batches at the 10,000-record boundary', () => {
  const probe = runImporterProbe(`
    const crypto = require('node:crypto');
    const { buildImportBatches, isImportRequest } = require(${JSON.stringify(importerPath)});
    const timestamp = '2026-09-15T01:00:00.000Z';
    function memory(index) {
      const sourcePath = 'memories/' + String(index).padStart(5, '0') + '.md';
      return {
        id: 'mem_obsidian_' + crypto.createHash('sha256').update(sourcePath).digest('hex'),
        createdAt: timestamp,
        updatedAt: timestamp,
        type: 'fact',
        title: 'Fixture ' + index,
        content: 'fixture body ' + index,
        concepts: ['obsidian-source:' + sourcePath],
        files: [sourcePath],
        sessionIds: [],
        strength: 1,
        version: 1,
        isLatest: true,
        origin: {
          channel: 'import',
          detail: JSON.stringify({ sourcePath, tags: [], sessions: [] }),
          capturedAt: timestamp,
        },
      };
    }
    function request(memories) {
      return {
        exportData: {
          version: '0.9.29',
          exportedAt: timestamp,
          sessions: [],
          observations: {},
          memories,
          summaries: [],
        },
        strategy: 'skip',
      };
    }
    function inspect(built) {
      const payloads = built.batches.map(({ body, bytes }) => ({
        memoryCount: JSON.parse(body).exportData.memories.length,
        paths: JSON.parse(body).exportData.memories.map((record) => record.files[0]),
        bytes,
        bodyBytes: Buffer.byteLength(body, 'utf8'),
        requestValid: isImportRequest(JSON.parse(body)),
      }));
      return {
        payloads,
        oversized: built.oversized,
      };
    }
    const tenThousand = Array.from({ length: 10_000 }, (_, index) => memory(index));
    const tenThousandAndOne = Array.from({ length: 10_001 }, (_, index) => memory(index));
    const lexical = buildImportBatches([memory(2), memory(0), memory(1)], timestamp);
    process.stdout.write(JSON.stringify({
      tenThousand: inspect(buildImportBatches(tenThousand, timestamp)),
      tenThousandAndOne: inspect(buildImportBatches(tenThousandAndOne, timestamp)),
      overLimitRequestValid: isImportRequest(request(tenThousandAndOne)),
      lexical: inspect(lexical),
    }));
  `);
  assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
  const result = JSON.parse(probe.stdout);
  assert.deepEqual(
    result.tenThousand.payloads.map(({ memoryCount }) => memoryCount),
    [10_000],
  );
  assert.deepEqual(result.tenThousand.oversized, []);
  assert.equal(result.tenThousand.payloads[0].requestValid, true);
  assert.equal(
    result.tenThousand.payloads[0].bytes,
    result.tenThousand.payloads[0].bodyBytes,
  );
  assert.ok(result.tenThousand.payloads[0].bytes < 8 * 1024 * 1024);
  assert.deepEqual(
    result.tenThousandAndOne.payloads.map(({ memoryCount }) => memoryCount),
    [10_000, 1],
  );
  assert.deepEqual(result.tenThousandAndOne.oversized, []);
  assert.equal(result.overLimitRequestValid, false);
  assert.deepEqual(
    result.lexical.payloads.flatMap(({ paths }) => paths),
    ['memories/00000.md', 'memories/00001.md', 'memories/00002.md'],
  );
});

test('uses UTF-8 byte sizing, rejects the ceiling, and isolates oversized singles', () => {
  const probe = runImporterProbe(`
    const crypto = require('node:crypto');
    const {
      MAX_IMPORT_BYTES,
      buildImportBatches,
    } = require(${JSON.stringify(importerPath)});
    const timestamp = '2026-09-15T01:00:00.000Z';
    function memory(sourcePath, content) {
      return {
        id: 'mem_obsidian_' + crypto.createHash('sha256').update(sourcePath).digest('hex'),
        createdAt: timestamp,
        updatedAt: timestamp,
        type: 'fact',
        title: 'Fixture',
        content,
        concepts: ['obsidian-source:' + sourcePath],
        files: [sourcePath],
        sessionIds: [],
        strength: 1,
        version: 1,
        isLatest: true,
        origin: {
          channel: 'import',
          detail: JSON.stringify({ sourcePath, tags: [], sessions: [] }),
          capturedAt: timestamp,
        },
      };
    }
    function bodyFor(record) {
      return JSON.stringify({
        exportData: {
          version: '0.9.29',
          exportedAt: timestamp,
          sessions: [],
          observations: {},
          memories: [record],
          summaries: [],
        },
        strategy: 'skip',
      });
    }
    function sized(target, sourcePath = 'memories/boundary.md') {
      const fixedBytes = Buffer.byteLength(bodyFor(memory(sourcePath, 'x')), 'utf8');
      const content = 'x'.repeat(target - fixedBytes + 1);
      const record = memory(sourcePath, content);
      const actualBytes = Buffer.byteLength(bodyFor(record), 'utf8');
      const built = buildImportBatches([record], timestamp);
      return {
        target,
        actualBytes,
        batchBytes: built.batches.map(({ bytes }) => bytes),
        oversized: built.oversized,
      };
    }
    const under = sized(MAX_IMPORT_BYTES - 1);
    const at = sized(MAX_IMPORT_BYTES);
    const above = sized(MAX_IMPORT_BYTES + 1);
    const oversized = sized(MAX_IMPORT_BYTES, 'memories/b.md');
    const isolation = buildImportBatches([
      memory('memories/c.md', 'later c'),
      memory(
        'memories/b.md',
        'x'.repeat(
          MAX_IMPORT_BYTES
          - Buffer.byteLength(bodyFor(memory('memories/b.md', 'x')), 'utf8')
          + 1,
        ),
      ),
      memory('memories/a.md', 'earlier a'),
    ], timestamp);
    process.stdout.write(JSON.stringify({
      maxBytes: MAX_IMPORT_BYTES,
      under,
      at,
      above,
      oversized,
      isolation: {
        batches: isolation.batches.map(({ body, bytes }) => ({
          paths: JSON.parse(body).exportData.memories.map((record) => record.files[0]),
          bytes,
        })),
        oversized: isolation.oversized,
      },
    }));
  `);
  assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.maxBytes, 8 * 1024 * 1024);
  assert.equal(result.under.actualBytes, result.maxBytes - 1);
  assert.deepEqual(result.under.batchBytes, [result.maxBytes - 1]);
  assert.deepEqual(result.under.oversized, []);
  assert.equal(result.at.actualBytes, result.maxBytes);
  assert.deepEqual(result.at.batchBytes, []);
  assert.equal(result.at.oversized.length, 1);
  assert.equal(result.at.oversized[0].relativePath, 'memories/boundary.md');
  assert.equal(result.above.actualBytes, result.maxBytes + 1);
  assert.deepEqual(result.above.batchBytes, []);
  assert.equal(result.above.oversized.length, 1);
  assert.equal(result.oversized.oversized.length, 1);
  assert.deepEqual(
    result.isolation.batches.flatMap(({ paths }) => paths),
    ['memories/a.md', 'memories/c.md'],
  );
  assert.deepEqual(result.isolation.oversized.map(({ relativePath }) => relativePath), ['memories/b.md']);
  assert.ok(result.isolation.batches.every(({ bytes }) => bytes < result.maxBytes));
});

test('accepts only exact successful counts or the exact logical failure shape', () => {
  const probe = runImporterProbe(`
    const { isImportResponse } = require(${JSON.stringify(importerPath)});
    const valid = {
      success: true,
      strategy: 'skip',
      sessions: 0,
      observations: 0,
      memories: 1,
      summaries: 0,
      skipped: 1,
    };
    const clone = () => JSON.parse(JSON.stringify(valid));
    const mutations = {
      'missing success': () => {
        const candidate = clone();
        delete candidate.success;
        return candidate;
      },
      'invalid success value': () => ({ ...clone(), success: 1 }),
      'invalid strategy': () => ({ ...clone(), strategy: 'merge' }),
      'negative sessions': () => ({ ...clone(), sessions: -1 }),
      'fractional observations': () => ({ ...clone(), observations: 0.5 }),
      'string memories': () => ({ ...clone(), memories: '1' }),
      'non-zero sessions': () => ({ ...clone(), sessions: 1 }),
      'non-zero observations': () => ({ ...clone(), observations: 1 }),
      'non-zero summaries': () => ({ ...clone(), summaries: 1 }),
      'negative skipped': () => ({ ...clone(), skipped: -1 }),
      'count mismatch': () => ({ ...clone(), memories: 0, skipped: 0 }),
      'extra success field': () => ({ ...clone(), extra: true }),
      'not an object': () => null,
    };
    const invalid = Object.fromEntries(
      Object.entries(mutations).map(([label, response]) => [label, isImportResponse(response(), 2)]),
    );
    const logicalFailure = isImportResponse({ success: false, error: 'rejected' }, 2);
    const logicalFailureWithExtraFields = isImportResponse(
      { success: false, error: 'rejected', details: { status: 400 } },
      2,
    );
    const missingLogicalError = isImportResponse({ success: false }, 2);
    const nonStringLogicalError = isImportResponse({ success: false, error: { message: 'rejected' } }, 2);
    process.stdout.write(JSON.stringify({
      valid: isImportResponse(valid, 2),
      invalid,
      logicalFailure,
      logicalFailureWithExtraFields,
      missingLogicalError,
      nonStringLogicalError,
    }));
  `);
  assert.equal(probe.status, 0, `${probe.stderr}\n${probe.stdout}`);
  const result = JSON.parse(probe.stdout);
  assert.equal(result.valid, true);
  assert.deepEqual(
    Object.keys(result.invalid).filter((label) => result.invalid[label]),
    [],
  );
  assert.equal(result.logicalFailure, true);
  assert.equal(result.logicalFailureWithExtraFields, false);
  assert.equal(result.missingLogicalError, false);
  assert.equal(result.nonStringLogicalError, false);
});

test('executes a dry-run without endpoint or bearer access and reports target counts as zero', () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'valid.md', '# Valid\n\nvalid body\n');
  writeObsidianNote(vaultPath, 'malformed.md', '---\ntags: not-an-array\n---\nbody\n');
  const before = snapshotTree(vaultPath);

  try {
    const result = runObsidianImporter(vaultPath, ['--dry-run'], {
      AGENTMEMORY_URL: 'not an endpoint',
      AGENTMEMORY_SECRET: 'dry-run-secret-must-not-be-used',
    });
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.dryRun, true);
    assert.deepEqual(report.counts, {
      discovered: 2,
      eligible: 1,
      imported: 0,
      alreadyPresent: 0,
      skipped: 1,
      failed: 0,
    });
    assert.deepEqual(report.batches, { submitted: 0, succeeded: 0, failed: 0 });
    assert.equal(report.skipped.length, 1);
    assert.match(report.skipped[0].relativePath, /malformed\.md$/);
    assert.deepEqual(report.failures, []);
    assert.equal(result.stdout.includes('dry-run-secret-must-not-be-used'), false);
    assert.deepEqual(snapshotTree(vaultPath), before);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('supports help without a vault path or bearer', () => {
  const result = runObsidianImporter('/tmp/help-does-not-read', ['--help'], {
    AGENTMEMORY_SECRET: 'help-secret-must-not-be-read',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /Usage: agentmemory-import-obsidian <absolute-vault-path>/);
  assert.match(result.stdout, /--dry-run/);
  assert.match(result.stdout, /--help/);
  assert.equal(result.stdout.includes('help-secret-must-not-be-read'), false);
  assert.equal(result.stderr, '');
});

test('packages the managed importer with Node 22, YAML dependencies, and no embedded bearer', () => {
  const packagePath = importerPackagePath();
  const packageText = fs.readFileSync(packagePath, 'utf8');

  assert.match(packageText, /nodejs-22\.[^/]*\/bin\/node/);
  assert.match(packageText, /--experimental-strip-types/);
  assert.match(packageText, /agentmemory-import-obsidian\.ts/);
  assert.match(packageText, /AGENTMEMORY_URL=.*http:\/\/127\.0\.0\.1:3111/);
  assert.match(packageText, /obsidian-importer-deps-[^/]+\/lib\/node_modules/);
  assert.match(packageText, /find-generic-password -s mcpproxy -a fixture-bearer -w/);
  assert.doesNotMatch(packageText, /fixture-(?:secret|bearer-value)/);
  assert.doesNotMatch(packageText, /memories\//);
});

test('the importer dependency package contains only js-yaml and its pure-JS transitive dependency', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'overlays/obsidian-importer-deps/package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'overlays/obsidian-importer-deps/package-lock.json'), 'utf8'));

  assert.deepEqual(manifest.dependencies, { 'js-yaml': '4.1.1' });
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
  assert.deepEqual(Object.keys(lock.packages).sort(), [
    '', 'node_modules/argparse', 'node_modules/js-yaml',
  ]);
});

test('packaged importer skips Keychain for help and dry-run and resolves bearer only for live mode', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'managed.md', '# Managed package\n\nmanaged package body\n');
  const securityPath = path.join(vaultPath, 'security');
  const securityLog = path.join(vaultPath, 'security.log');
  fs.writeFileSync(
    securityPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENTMEMORY_IMPORT_SECURITY_LOG"\n' +
      'if [ "${SECURITY_FAIL:-0}" = 1 ]; then exit 1; fi\n' +
      'printf "managed-import-secret\\n"\n',
    { mode: 0o755 },
  );
  fs.chmodSync(securityPath, 0o755);
  const stored = new Map();
  const secret = 'managed-import-secret';
  const mock = await startObsidianMock(({ payload, authorization }) => {
    assert.equal(authorization, `Bearer ${secret}`);
    return { body: successfulImportResponse(payload, stored) };
  });

  const packageEnvironment = {
    AGENTMEMORY_IMPORT_SECURITY_BIN: securityPath,
    AGENTMEMORY_IMPORT_SECURITY_LOG: securityLog,
    AGENTMEMORY_SECRET: '',
    AGENTMEMORY_URL: 'http://invalid.example',
  };

  try {
    const help = runPackagedObsidianImporter(mock.url, ['--help'], {
      ...packageEnvironment,
      SECURITY_FAIL: '1',
    });
    assert.equal(help.status, 0, `${help.stderr}\n${help.stdout}`);
    assert.match(help.stdout, /Usage: agentmemory-import-obsidian/);
    assert.doesNotMatch(help.stdout, /--(?:endpoint|url)/);
    assert.equal(fs.existsSync(securityLog), false);

    const dryRun = runPackagedObsidianImporter(mock.url, [vaultPath, '--dry-run'], {
      ...packageEnvironment,
      SECURITY_FAIL: '1',
    });
    assert.equal(dryRun.status, 0, `${dryRun.stderr}\n${dryRun.stdout}`);
    assert.deepEqual(JSON.parse(dryRun.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 0,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(fs.existsSync(securityLog), false);

    const missingBearer = runPackagedObsidianImporter(mock.url, [vaultPath], {
      ...packageEnvironment,
      SECURITY_FAIL: '1',
    });
    assert.equal(missingBearer.status, 1);
    assert.match(missingBearer.stderr, /bearer unavailable from macOS Keychain/);
    assert.equal(missingBearer.stdout, '');
    assert.match(fs.readFileSync(securityLog, 'utf8'), /-s mcpproxy -a fixture-bearer -w/);

    fs.rmSync(securityLog);
    const injected = await runPackagedObsidianImporterAsync(mock.url, [vaultPath], {
      ...packageEnvironment,
      AGENTMEMORY_SECRET: secret,
    });
    assert.equal(injected.status, 0, `${injected.stderr}\n${injected.stdout}`);
    assert.deepEqual(JSON.parse(injected.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 1,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(fs.existsSync(securityLog), false);
    assert.equal(injected.stdout.includes(secret), false);
    assert.equal(injected.stdout.includes('managed package body'), false);

    const keychain = await runPackagedObsidianImporterAsync(mock.url, [vaultPath], packageEnvironment);
    assert.equal(keychain.status, 0, `${keychain.stderr}\n${keychain.stdout}`);
    assert.deepEqual(JSON.parse(keychain.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 0,
      alreadyPresent: 1,
      skipped: 0,
      failed: 0,
    });
    assert.equal(keychain.stdout.includes('fixture-bearer'), false);
    assert.equal(keychain.stdout.includes('managed package body'), false);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('managed importer rejects endpoint overrides before Keychain lookup or bearer transmission', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'managed.md', '# Managed package\n\nmanaged package body\n');
  const securityPath = path.join(vaultPath, 'security');
  const securityLog = path.join(vaultPath, 'security.log');
  const bearer = 'managed-endpoint-bearer';
  fs.writeFileSync(
    securityPath,
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$AGENTMEMORY_IMPORT_SECURITY_LOG"\n' +
      `printf "${bearer}\\n"\n`,
    { mode: 0o755 },
  );
  fs.chmodSync(securityPath, 0o755);
  const external = await startObsidianMock(({ payload }) => ({
    body: successfulImportResponse(payload, new Map()),
  }));
  const packageEnvironment = {
    AGENTMEMORY_IMPORT_SECURITY_BIN: securityPath,
    AGENTMEMORY_IMPORT_SECURITY_LOG: securityLog,
    AGENTMEMORY_SECRET: '',
    AGENTMEMORY_URL: 'http://invalid.example',
  };

  try {
    for (const override of [
      ['--endpoint', external.url],
      ['--url', external.url],
      [`--endpoint=${external.url}`],
      [`--url=${external.url}`],
    ]) {
      const result = runPackagedObsidianImporter(
        'http://127.0.0.1:1',
        [vaultPath, ...override],
        packageEnvironment,
      );
      assert.equal(result.status, 2, `${override[0]}: ${result.stderr}\n${result.stdout}`);
      assert.match(result.stderr, /managed importer.*--endpoint.*--url.*configured AgentMemory/i);
      assert.equal(result.stdout, '');
      assert.equal(fs.existsSync(securityLog), false);
      assert.equal(external.requests.length, 0);
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(bearer));
    }
  } finally {
    await external.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('submits the exact authenticated envelope and keeps same-path reruns already-present', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'a.md', '# A\n\ninitial a body\n');
  writeObsidianNote(vaultPath, 'b.md', '# B\n\ninitial b body\n');
  const sourceBefore = snapshotTree(vaultPath);
  const secret = 'obsidian-live-secret';
  const stored = new Map();
  const mock = await startObsidianMock(({ payload, authorization, url }) => {
    assert.equal(url, '/agentmemory/import');
    assert.equal(authorization, `Bearer ${secret}`);
    assert.equal(payload.strategy, 'skip');
    assert.deepEqual(payload.exportData.sessions, []);
    assert.deepEqual(payload.exportData.observations, {});
    assert.deepEqual(payload.exportData.summaries, []);
    assert.ok(payload.exportData.memories.length > 0);
    return { body: successfulImportResponse(payload, stored) };
  });

  try {
    const first = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: secret,
    });
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    const firstReport = JSON.parse(first.stdout);
    assert.deepEqual(firstReport.counts, {
      discovered: 2,
      eligible: 2,
      imported: 2,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.deepEqual(firstReport.batches, { submitted: 1, succeeded: 1, failed: 0 });
    assert.equal(first.stdout.includes(secret), false);
    assert.equal(first.stdout.includes('initial a body'), false);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].raw.byteLength, Buffer.byteLength(JSON.stringify(mock.requests[0].payload)));

    writeObsidianNote(vaultPath, 'a.md', '# A changed\n\nchanged same-path body\n');
    const rerun = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: secret,
    });
    assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
    const rerunReport = JSON.parse(rerun.stdout);
    assert.deepEqual(rerunReport.counts, {
      discovered: 2,
      eligible: 2,
      imported: 0,
      alreadyPresent: 2,
      skipped: 0,
      failed: 0,
    });
    assert.deepEqual(rerunReport.batches, { submitted: 1, succeeded: 1, failed: 0 });
    assert.equal(stored.get([...stored.keys()][0]).content, '# A\n\ninitial a body\n');
    assert.equal(rerun.stdout.includes(secret), false);
    const sourceAfterChange = snapshotTree(vaultPath);
    assert.notDeepEqual(
      sourceAfterChange.map(({ relativePath, digest }) => ({ relativePath, digest })),
      sourceBefore.map(({ relativePath, digest }) => ({ relativePath, digest })),
    );
    assert.deepEqual(
      snapshotTree(vaultPath).map(({ relativePath, digest }) => ({ relativePath, digest })),
      sourceAfterChange.map(({ relativePath, digest }) => ({ relativePath, digest })),
    );
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('continues after an independent batch failure and reruns only missing identities', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'a-large.md', largeNoteBody('A large'));
  writeObsidianNote(vaultPath, 'b-large.md', largeNoteBody('B large'));
  writeObsidianNote(vaultPath, 'c.md', '# C\n\nsmall c body\n');
  const sourceBefore = snapshotTree(vaultPath);
  const stored = new Map();
  let failOnce = true;
  const mock = await startObsidianMock(({ payload }) => {
    if (failOnce) {
      failOnce = false;
      return { status: 503, body: { error: 'temporary batch failure' } };
    }
    return { body: successfulImportResponse(payload, stored) };
  });

  try {
    const first = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: 'partial-secret',
    });
    assert.equal(first.status, 1, `${first.stderr}\n${first.stdout}`);
    const firstReport = JSON.parse(first.stdout);
    assert.deepEqual(firstReport.counts, {
      discovered: 3,
      eligible: 3,
      imported: 2,
      alreadyPresent: 0,
      skipped: 0,
      failed: 1,
    });
    assert.deepEqual(firstReport.batches, { submitted: 2, succeeded: 1, failed: 1 });
    assert.deepEqual(firstReport.failures.map(({ relativePath }) => relativePath), ['memories/a-large.md']);
    assert.equal(mock.requests.length, 2);
    assert.equal(first.stdout.includes('x'.repeat(100)), false);

    const rerun = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: 'partial-secret',
    });
    assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
    const rerunReport = JSON.parse(rerun.stdout);
    assert.deepEqual(rerunReport.counts, {
      discovered: 3,
      eligible: 3,
      imported: 1,
      alreadyPresent: 2,
      skipped: 0,
      failed: 0,
    });
    assert.deepEqual(rerunReport.batches, { submitted: 2, succeeded: 2, failed: 0 });
    assert.equal(mock.requests.length, 4);
    assert.deepEqual(
      snapshotTree(vaultPath).map(({ relativePath, digest }) => ({ relativePath, digest })),
      sourceBefore.map(({ relativePath, digest }) => ({ relativePath, digest })),
    );
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('records malformed response batches and continues with later batches', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'a-large.md', largeNoteBody('A large'));
  writeObsidianNote(vaultPath, 'b-large.md', largeNoteBody('B large'));
  const stored = new Map();
  let malformedOnce = true;
  const mock = await startObsidianMock(({ payload }) => {
    if (malformedOnce) {
      malformedOnce = false;
      return { status: 200, body: '{not-json' };
    }
    return { body: successfulImportResponse(payload, stored) };
  });

  try {
    const result = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: 'malformed-response-secret',
    });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.counts, {
      discovered: 2,
      eligible: 2,
      imported: 1,
      alreadyPresent: 0,
      skipped: 0,
      failed: 1,
    });
    assert.deepEqual(report.batches, { submitted: 2, succeeded: 1, failed: 1 });
    assert.deepEqual(report.failures.map(({ relativePath }) => relativePath), ['memories/a-large.md']);
    assert.match(report.failures[0].reason, /invalid JSON/i);
    assert.equal(result.stdout.includes('malformed-response-secret'), false);
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('redacts arbitrary transport errors from the report and CLI diagnostics', () => {
  const vaultPath = createVault();
  const noteBody = 'distinctive-transport-note-body-7c9e';
  const bearer = 'distinctive-transport-bearer-4f2a';
  writeObsidianNote(vaultPath, 'transport.md', `# Transport\n\n${noteBody}\n`);

  const probe = runImporterProbe(`
    const { main } = require(${JSON.stringify(importerPath)});
    const noteBody = ${JSON.stringify(noteBody)};
    const bearer = ${JSON.stringify(bearer)};
    process.env.AGENTMEMORY_URL = 'http://agentmemory.invalid';
    process.env.AGENTMEMORY_SECRET = bearer;
    globalThis.fetch = async () => {
      throw new Error('socket failed while sending ' + noteBody + ' with bearer ' + bearer);
    };
    main([${JSON.stringify(vaultPath)}, '--json']).catch((error) => {
      process.stderr.write(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
  `);

  try {
    assert.equal(probe.status, 1, `${probe.stderr}\n${probe.stdout}`);
    const report = JSON.parse(probe.stdout);
    assert.deepEqual(report.counts, {
      discovered: 1,
      eligible: 1,
      imported: 0,
      alreadyPresent: 0,
      skipped: 0,
      failed: 1,
    });
    assert.deepEqual(report.batches, { submitted: 1, succeeded: 0, failed: 1 });
    assert.deepEqual(report.failures, [{
      relativePath: 'memories/transport.md',
      reason: 'transport failure',
    }]);
    assert.equal(probe.stdout.includes(noteBody), false);
    assert.equal(probe.stderr.includes(noteBody), false);
    assert.equal(probe.stdout.includes(bearer), false);
    assert.equal(probe.stderr.includes(bearer), false);
  } finally {
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('stops after terminal authentication failure and marks unsent eligible notes failed', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'a-large.md', largeNoteBody('A large'));
  writeObsidianNote(vaultPath, 'b-large.md', largeNoteBody('B large'));
  const secret = 'terminal-auth-secret';
  const mock = await startObsidianMock(() => ({
    status: 401,
    body: { success: false, error: 'authentication rejected' },
  }));

  try {
    const result = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: secret,
    });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.counts, {
      discovered: 2,
      eligible: 2,
      imported: 0,
      alreadyPresent: 0,
      skipped: 0,
      failed: 2,
    });
    assert.deepEqual(report.batches, { submitted: 1, succeeded: 0, failed: 1 });
    assert.deepEqual(
      report.failures.map(({ relativePath }) => relativePath),
      ['memories/a-large.md', 'memories/b-large.md'],
    );
    assert.match(report.failures[0].reason, /authentication/i);
    assert.equal(mock.requests.length, 1);
    assert.equal(mock.requests[0].authorization, `Bearer ${secret}`);
    assert.equal(result.stdout.includes(secret), false);
    assert.equal(result.stderr.includes(secret), false);
    assert.equal(result.stdout.includes('x'.repeat(100)), false);
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

test('isolates a record above the strict request ceiling and submits later records', async () => {
  const vaultPath = createVault();
  writeObsidianNote(vaultPath, 'oversized.md', largeNoteBody('Oversized', 8 * 1024 * 1024));
  writeObsidianNote(vaultPath, 'small.md', '# Small\n\nsmall body\n');
  const stored = new Map();
  const mock = await startObsidianMock(({ payload }) => ({
    body: successfulImportResponse(payload, stored),
  }));

  try {
    const result = await runObsidianImporterAsync(vaultPath, [], {
      AGENTMEMORY_URL: mock.url,
      AGENTMEMORY_SECRET: 'oversized-secret',
    });
    assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
    const report = JSON.parse(result.stdout);
    assert.deepEqual(report.counts, {
      discovered: 2,
      eligible: 2,
      imported: 1,
      alreadyPresent: 0,
      skipped: 0,
      failed: 1,
    });
    assert.deepEqual(report.batches, { submitted: 1, succeeded: 1, failed: 0 });
    assert.deepEqual(report.failures.map(({ relativePath }) => relativePath), ['memories/oversized.md']);
    assert.match(report.failures[0].reason, /8 MiB/i);
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(
      mock.requests[0].payload.exportData.memories.map(({ files }) => files[0]),
      ['memories/small.md'],
    );
  } finally {
    await mock.close();
    fs.rmSync(vaultPath, { recursive: true, force: true });
  }
});

function assertDaemonCleanup(evidence) {
  const deadline = Date.now() + 15_000;
  assert.equal(isProcessAlive(evidence.pid), false, `daemon PID ${evidence.pid} survived teardown`);
  assert.equal(
    isProcessGroupAlive(evidence.processGroupId),
    false,
    `daemon process group ${evidence.processGroupId} survived teardown`,
  );
  for (const pid of evidence.ownedPids) {
    assert.equal(isProcessAlive(pid), false, `owned process PID ${pid} survived teardown`);
  }
  assert.equal(isProcessIdentityAlive(evidence.root), false, `owned process identity survived teardown: ${evidence.root}`);
  return Promise.all(evidence.ports.map((port) => assertPortAvailable(port, deadline)));
}

test('isolated importer harness keeps source and target paths temporary and resolves Keychain only for live mode', async () => {
  let evidence;
  await withObsidianImportHarness(async (harness) => {
    const body = '# Isolated harness fixture\n\nfixture body must stay out of reports\n';
    harness.writeNote('fixture.md', body);
    const endpoint = await startMockImportEndpoint(harness, ({ payload, authorization }) => {
      if (authorization !== `Bearer ${harness.bearer}`) {
        return { status: 401, body: { success: false, error: 'authentication rejected' } };
      }
      return { body: successfulImportResponse(payload, new Map()) };
    });
    evidence = {
      root: harness.root,
      endpointPort: endpoint.port,
      securityLog: harness.securityLog,
      sourcePath: harness.vaultPath,
      dataDir: harness.dataDir,
      runtimeDir: harness.runtimeDir,
      logDir: harness.logDir,
    };

    assert.notEqual(harness.root, repoRoot);
    assert.equal(harness.vaultPath, path.join(harness.root, 'vault'));
    assert.equal(path.join(harness.vaultPath, 'memories'), harness.memoriesPath);
    for (const directory of [harness.dataDir, harness.runtimeDir, harness.logDir]) {
      assert.equal(path.relative(harness.root, directory).startsWith('..'), false);
      assert.ok(fs.existsSync(directory));
    }

    const packageEnvironment = harness.importerEnvironment();
    const help = runPackagedObsidianImporter(endpoint.url, ['--help'], {
      ...packageEnvironment,
      AGENTMEMORY_SECRET: '',
      AGENTMEMORY_IMPORT_SECURITY_FAIL: '1',
    });
    assert.equal(help.status, 0, `${help.stderr}\n${help.stdout}`);
    assert.equal(fs.existsSync(harness.securityLog), false);

    const dryRun = runPackagedObsidianImporter(endpoint.url, [harness.vaultPath, '--dry-run'], {
      ...packageEnvironment,
      AGENTMEMORY_SECRET: '',
      AGENTMEMORY_IMPORT_SECURITY_FAIL: '1',
    });
    assert.equal(dryRun.status, 0, `${dryRun.stderr}\n${dryRun.stdout}`);
    assert.deepEqual(JSON.parse(dryRun.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 0,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(fs.existsSync(harness.securityLog), false);

    const live = await runPackagedObsidianImporterAsync(endpoint.url, [harness.vaultPath], {
      ...packageEnvironment,
      AGENTMEMORY_SECRET: '',
    });
    assert.equal(live.status, 0, `${live.stderr}\n${live.stdout}`);
    assert.deepEqual(JSON.parse(live.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 1,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(live.stdout.includes(harness.bearer), false);
    assert.equal(live.stderr.includes(harness.bearer), false);
    assert.equal(live.stdout.includes(body), false);
    assert.equal(live.stderr.includes(body), false);
    assert.equal(endpoint.requests.length, 1);
    assert.equal(endpoint.requests[0].authorization, `Bearer ${harness.bearer}`);
    assert.match(fs.readFileSync(harness.securityLog, 'utf8'), /find-generic-password -s mcpproxy -a fixture-bearer -w/);
    assert.doesNotMatch(fs.readFileSync(harness.securityLog, 'utf8'), new RegExp(harness.bearer));
    assert.deepEqual(fs.readFileSync(path.join(harness.memoriesPath, 'fixture.md'), 'utf8'), body);
  });

  assert.equal(fs.existsSync(evidence.root), false);
  assert.equal(fs.existsSync(evidence.sourcePath), false);
  assert.equal(fs.existsSync(evidence.dataDir), false);
  assert.equal(fs.existsSync(evidence.runtimeDir), false);
  assert.equal(fs.existsSync(evidence.logDir), false);
  await assertPortAvailable(evidence.endpointPort);
});

test('packaged daemon harness owns an authenticated ready process group and removes all target state on success', {
  timeout: 120_000,
}, async () => {
  let evidence;
  await withObsidianImportHarness(async (harness) => {
    harness.writeNote('daemon-fixture.md', '# Daemon fixture\n\nnot imported by task 4.1\n');
    await startMockImportEndpoint(harness, () => ({ body: { ok: true } }));
    const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
    evidence = {
      root: harness.root,
      pid: daemon.pid,
      processGroupId: daemon.processGroupId,
      ownedPids: daemon.ownedPids,
      ports: daemon.ports,
      restPort: daemon.restPort,
      endpointPort: harness.endpoint.port,
      dataDir: harness.dataDir,
      runtimeDir: harness.runtimeDir,
      logDir: harness.logDir,
    };
    assert.ok(daemon.pid > 0);
    assert.equal(daemon.processGroupId, daemon.pid);
    assert.ok(daemon.ownedPids.includes(daemon.pid));
    assert.equal(fs.existsSync(harness.dataDir), true);
    assert.equal(fs.existsSync(harness.runtimeDir), true);
    assert.equal(fs.existsSync(harness.logDir), true);
    assert.equal(
      `${daemon.output.stdout}\n${daemon.output.stderr}`.includes(harness.bearer),
      false,
      'daemon output must not contain the bearer',
    );

    const health = await fetch(`${daemon.baseUrl}/agentmemory/health`, {
      headers: { Authorization: `Bearer ${harness.bearer}` },
    });
    assert.equal(health.ok, true);
    const healthBody = await health.json();
    assert.ok(['healthy', 'degraded'].includes(healthBody.status), JSON.stringify(healthBody));
  }, { cleanupTimeoutMs: 30_000 });

  await assertDaemonCleanup(evidence);
  await assertPortAvailable(evidence.endpointPort);
  assert.equal(fs.existsSync(evidence.root), false);
  assert.equal(fs.existsSync(evidence.dataDir), false);
  assert.equal(fs.existsSync(evidence.runtimeDir), false);
  assert.equal(fs.existsSync(evidence.logDir), false);
});

test('packaged daemon harness tracks and tears down a detached descendant group discovered during startup and escalation', {
  timeout: 120_000,
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-detached-fixture-'));
  const childPidFile = path.join(fixtureDir, 'child.pid');
  let detached;
  let evidence;

  try {
    await withObsidianImportHarness(async (harness) => {
      harness.writeNote('detached-fixture.md', '# Detached fixture\n\nnot imported by task 4.1\n');
      detached = spawnDetachedDescendantFixture(harness.root, childPidFile);
      assert.ok(detached.pid);
      await waitForProcessGroup(detached.pid);
      await startMockImportEndpoint(harness, () => ({ body: { ok: true } }));
      const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
      assert.ok(
        daemon.ownedProcessRecords.some((record) => (
          record.pid === detached.pid
          && record.processGroupId !== daemon.processGroupId
          && record.identity === harness.root
        )),
        'startup discovery must retain the detached descendant process group identity',
      );
      evidence = {
        root: harness.root,
        pid: daemon.pid,
        processGroupId: daemon.processGroupId,
        ownedPids: daemon.ownedPids,
        ownedProcessRecords: daemon.ownedProcessRecords,
        ports: daemon.ports,
        detachedProcessGroupId: detached.pid,
        childPidFile,
        endpointPort: harness.endpoint.port,
        dataDir: harness.dataDir,
        runtimeDir: harness.runtimeDir,
        logDir: harness.logDir,
      };
    });

    await assertDaemonCleanup(evidence);
    assert.equal(isProcessGroupAlive(evidence.detachedProcessGroupId), false);
    assert.equal(isProcessIdentityAlive(evidence.root), false);
    assert.equal(fs.existsSync(evidence.root), false);
  } finally {
    if (detached?.pid && isProcessAlive(detached.pid)) killProcessGroup(detached.pid);
    if (fs.existsSync(childPidFile)) {
      const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
      if (Number.isInteger(childPid) && childPid > 1 && isProcessAlive(childPid)) killProcessGroup(childPid);
    }
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('harness tracks an unmarked descendant in an owned process group', {
  timeout: 10_000,
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-group-fixture-'));
  const childPidFile = path.join(fixtureDir, 'child.pid');
  const marker = path.join(fixtureDir, 'owned-marker');
  const parent = spawnUnmarkedGroupDescendantFixture(marker, childPidFile);
  assert.ok(parent.pid);

  try {
    await waitForFile(childPidFile);
    const childPid = Number(fs.readFileSync(childPidFile, 'utf8'));
    assert.ok(childPid > 1);
    const daemon = {
      child: parent,
      pid: parent.pid,
      processGroupId: parent.pid,
      identity: marker,
      identityMarkers: [marker],
      ownedPids: [parent.pid],
      ownedProcessRecords: [{ pid: parent.pid, processGroupId: parent.pid, identity: marker }],
      ownedProcessGroups: [{ processGroupId: parent.pid, identity: marker }],
      ownedListenerRecords: [],
      ports: [],
      cleanupTimeoutMs: 2_000,
      closed: false,
    };

    const processKillCalls = [];
    const originalProcessKill = process.kill;
    try {
      process.kill = (pid, signal) => {
        processKillCalls.push({ pid, signal });
        return originalProcessKill.call(process, pid, signal);
      };
      await stopOwnedDaemon(daemon);
    } finally {
      process.kill = originalProcessKill;
    }
    assert.equal(isProcessAlive(parent.pid), false);
    assert.equal(isProcessAlive(childPid), false, 'unmarked same-group descendant survived teardown');
    assert.ok(
      processKillCalls.some(({ pid, signal }) => (
        pid === -parent.pid
        && signal !== undefined
        && signal !== 0
        && signal !== '0'
      )),
      `teardown must send a nonzero signal to -${parent.pid}; calls=${JSON.stringify(processKillCalls)}`,
    );
    assert.ok(
      daemon.initialOwnershipSnapshot.records.some((record) => record.pid === childPid),
      'ownership snapshot must include the unmarked same-group descendant',
    );
  } finally {
    if (isProcessAlive(parent.pid)) killProcessGroup(parent.pid);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('harness discovers and tears down a detached listener through real listener probes', {
  timeout: 20_000,
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-listener-fixture-'));
  const readyFile = path.join(fixtureDir, 'listener.port');
  const marker = path.join(fixtureDir, 'owned-listener');
  const listener = spawnDetachedListenerFixture(readyFile);
  assert.ok(listener.pid);

  try {
    await waitForFile(readyFile);
    const port = Number(fs.readFileSync(readyFile, 'utf8'));
    assert.ok(port > 0);
    assert.ok(listListeningProcesses([port], Date.now() + 5_000).some(({ pid }) => pid === listener.pid));

    const daemon = {
      child: listener,
      pid: listener.pid,
      processGroupId: undefined,
      identity: marker,
      identityMarkers: [marker],
      ownedPids: [],
      ownedListenerPids: [listener.pid],
      ownedProcessRecords: [],
      ownedProcessGroups: [],
      ownedListenerRecords: [],
      ports: [port],
      cleanupTimeoutMs: 10_000,
      closed: false,
    };

    await stopOwnedDaemon(daemon);
    assert.equal(isProcessAlive(listener.pid), false);
    assert.equal(isProcessGroupAlive(listener.pid), false);
    await assertPortAvailable(port, Date.now() + 5_000);
  } finally {
    if (isProcessAlive(listener.pid)) killProcessGroup(listener.pid);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('harness enforces one absolute deadline for occupied-port retries', {
  timeout: 10_000,
}, async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const deadline = Date.now() + 250;
  const startedAt = Date.now();
  const resultPromise = assertPortAvailable(address.port, deadline).then(
    () => ({ status: 'resolved' }),
    (error) => ({ status: 'rejected', error }),
  );

  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
    let result = await Promise.race([
      resultPromise,
      new Promise((resolve) => setTimeout(() => resolve({ status: 'timed-out' }), 100)),
    ]);
    if (result.status === 'timed-out') {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      result = await resultPromise;
    }
    assert.equal(result.status, 'rejected', 'port retry ignored the absolute teardown deadline');
    assert.match(result.error.message, /deadline|occupied/i);
    assert.ok(Date.now() - startedAt < 2_000, 'port retry exceeded its shared deadline');
  } finally {
    if (server.listening) server.close();
  }
});

test('listener discovery bounds sequential lsof probes by one absolute deadline', {
  timeout: 10_000,
}, () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-lsof-fixture-'));
  const fakeBinDir = path.join(fixtureDir, 'bin');
  const fakeLsof = path.join(fakeBinDir, 'lsof');
  fs.mkdirSync(fakeBinDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fakeLsof, '#!/bin/sh\nsleep 2\n', { mode: 0o700 });
  const startedAt = Date.now();
  try {
    const result = runIsolatedListenerProbe(fakeBinDir, [31_001, 31_002, 31_003], 1_000, 5_000);
    assert.equal(result.status, 1, 'listener discovery returned after consuming separate per-port waits');
    assert.match(result.stderr, /deadline|timed out/i);
    assert.ok(Date.now() - startedAt < 4_000, 'listener discovery exceeded the shared absolute deadline');
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('teardown returns a bounded ownership report when listener discovery exhausts its deadline', {
  timeout: 10_000,
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-teardown-timeout-'));
  const fakeBinDir = path.join(fixtureDir, 'bin');
  const fakeLsof = path.join(fakeBinDir, 'lsof');
  const marker = path.join(fixtureDir, 'owned-marker');
  fs.mkdirSync(fakeBinDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(fakeLsof, '#!/bin/sh\nsleep 2\n', { mode: 0o700 });
  const owned = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);', marker],
    { detached: true, stdio: 'ignore' },
  );
  assert.ok(owned.pid);
  await waitForProcessGroup(owned.pid);
  const startedAt = Date.now();

  try {
    await assert.rejects(
      stopOwnedDaemon({
        child: owned,
        pid: owned.pid,
        processGroupId: owned.pid,
        identity: marker,
        identityMarkers: [marker],
        ownedPids: [owned.pid],
        ownedProcessRecords: [{ pid: owned.pid, processGroupId: owned.pid, identity: marker }],
        ownedProcessGroups: [{ processGroupId: owned.pid, identity: marker }],
        ownedListenerRecords: [],
        ports: [31_004],
        listenerProbe(deadline) {
          const timeoutMs = Math.max(1, deadline - Date.now());
          const result = runIsolatedListenerProbe(fakeBinDir, [31_004], timeoutMs, timeoutMs);
          if (result.status !== 0) {
            throw new Error(result.stderr || result.error?.message || 'isolated listener probe failed');
          }
          return JSON.parse(result.stdout);
        },
        cleanupTimeoutMs: 250,
        closed: false,
      }),
      (error) => {
        assert.match(error.message, /listener discovery|teardown deadline/i);
        assert.ok(error.message.includes(marker));
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 1_500, 'teardown exceeded its absolute deadline');
  } finally {
    if (isProcessAlive(owned.pid)) killProcessGroup(owned.pid);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('harness does not kill an unrelated same-command lookalike process', {
  timeout: 10_000,
}, async () => {
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-obsidian-identity-fixture-'));
  const marker = path.join(fixtureDir, 'owned-marker');
  const lookalikeMarker = `${marker}-lookalike`;
  const owned = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);', marker],
    { detached: true, stdio: 'ignore' },
  );
  const unrelated = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1000);', lookalikeMarker],
    { detached: true, stdio: 'ignore' },
  );
  assert.ok(owned.pid && unrelated.pid);

  try {
    await Promise.all([waitForProcessGroup(owned.pid), waitForProcessGroup(unrelated.pid)]);
    const daemon = {
      child: owned,
      pid: owned.pid,
      processGroupId: owned.pid,
      identity: marker,
      identityMarkers: [marker],
      ownedPids: [owned.pid],
      ownedProcessRecords: [{ pid: owned.pid, processGroupId: owned.pid, identity: marker }],
      ownedProcessGroups: [{ processGroupId: owned.pid, identity: marker }],
      ownedListenerRecords: [],
      ports: [],
      cleanupTimeoutMs: 2_000,
      closed: false,
    };

    await stopOwnedDaemon(daemon);
    assert.equal(isProcessAlive(owned.pid), false);
    assert.equal(isProcessAlive(unrelated.pid), true, 'lookalike process was treated as owned');
  } finally {
    if (isProcessAlive(owned.pid)) killProcessGroup(owned.pid);
    if (isProcessAlive(unrelated.pid)) killProcessGroup(unrelated.pid);
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('packaged daemon harness tears down its owned process group and temporary target after callback failure', {
  timeout: 120_000,
}, async () => {
  let evidence;
  await assert.rejects(
    withObsidianImportHarness(async (harness) => {
      harness.writeNote('daemon-failure-fixture.md', '# Daemon failure fixture\n\nnot imported by task 4.1\n');
      await startMockImportEndpoint(harness, () => ({ body: { ok: true } }));
      const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
      evidence = {
        root: harness.root,
        pid: daemon.pid,
        processGroupId: daemon.processGroupId,
        ownedPids: daemon.ownedPids,
        ports: daemon.ports,
        restPort: daemon.restPort,
        endpointPort: harness.endpoint.port,
        dataDir: harness.dataDir,
        runtimeDir: harness.runtimeDir,
        logDir: harness.logDir,
      };
      throw new Error('intentional importer harness failure');
    }),
    /intentional importer harness failure/,
  );

  await assertDaemonCleanup(evidence);
  await assertPortAvailable(evidence.endpointPort);
  assert.equal(fs.existsSync(evidence.root), false);
  assert.equal(fs.existsSync(evidence.dataDir), false);
  assert.equal(fs.existsSync(evidence.runtimeDir), false);
  assert.equal(fs.existsSync(evidence.logDir), false);
});

test('stock core proxy leaves an unrelated same-port lookalike listener alive', {
  timeout: 120_000,
}, async () => {
  let proxyHarness;
  let lookalike;
  let lookalikeFixtureDir;
  await withObsidianImportHarness(async (harness) => {
    const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
    proxyHarness = await startStockCoreProxy(harness, daemon);
    lookalikeFixtureDir = fs.mkdtempSync(path.join(harness.root, 'lookalike-'));
    const readyFile = path.join(lookalikeFixtureDir, 'listener.port');
    lookalike = spawnDetachedListenerFixture(readyFile, {
      marker: proxyHarness.configPath,
      port: proxyHarness.port,
      host: '::1',
    });

    try {
      await waitForFile(readyFile);
      assert.equal(Number(fs.readFileSync(readyFile, 'utf8')), proxyHarness.port);
      assert.ok(
        listAllListeningProcesses(Date.now() + 10_000).some(({ pid, port }) => (
          pid === lookalike.pid && port === proxyHarness.port
        )),
      );

      proxyHarness.proxy.claimNewListeners();
      assert.equal(
        proxyHarness.proxy.ownedListenerPids.includes(lookalike.pid),
        false,
        'unrelated same-port lookalike listener was claimed as proxy-owned',
      );
      await stopOwnedDaemon(proxyHarness.proxy);
      assert.equal(isProcessAlive(lookalike.pid), true, 'unrelated listener was killed with the proxy');
    } finally {
      try {
        if (proxyHarness?.proxy && !proxyHarness.proxy.closed) {
          await stopOwnedDaemon(proxyHarness.proxy);
        }
      } finally {
        if (lookalike?.pid && isProcessAlive(lookalike.pid)) killProcessGroup(lookalike.pid);
        if (lookalikeFixtureDir) fs.rmSync(lookalikeFixtureDir, { recursive: true, force: true });
      }
    }
  }, { cleanupTimeoutMs: 30_000 });
});

test('harness retains its root until a registered proxy survives teardown failure handling', {
  timeout: 120_000,
}, async () => {
  let evidence;
  let originalListenerProbe;
  await assert.rejects(
    withObsidianImportHarness(async (harness) => {
      const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
      const proxyHarness = await startStockCoreProxy(harness, daemon);
      originalListenerProbe = proxyHarness.proxy.listenerProbe;
      proxyHarness.proxy.listenerProbe = () => {
        throw new Error('forced proxy listener teardown failure');
      };
      evidence = {
        root: harness.root,
        proxy: proxyHarness.proxy,
        pid: proxyHarness.proxy.pid,
        processGroupId: proxyHarness.proxy.processGroupId,
        port: proxyHarness.port,
      };
      throw new Error('intentional callback failure after proxy start');
    }),
    /intentional callback failure|forced proxy listener teardown failure|listener discovery/i,
  );

  try {
    assert.equal(fs.existsSync(evidence.root), true, 'harness deleted the root before proxy cleanup completed');
    assert.equal(isProcessAlive(evidence.pid), false, 'registered proxy survived teardown failure handling');
  } finally {
    evidence.proxy.listenerProbe = originalListenerProbe;
    if (!evidence.proxy.closed) {
      await stopOwnedDaemon(evidence.proxy);
    }
    if (fs.existsSync(evidence.root)) fs.rmSync(evidence.root, { recursive: true, force: true });
  }
});

test('packaged importer persists a fixture recalled through the stock AgentMemory core surface', {
  timeout: 120_000,
}, async () => {
  let proxyEvidence;
  await withObsidianImportHarness(async (harness) => {
    const title = 'Task 4.2 distinctive imported title';
    const bodyTerm = 'task-4-2-distinctive-body-7f3c';
    const source = [
      '---',
      'project: agentmemory-enhancements',
      'tags:',
      '  - memory',
      '  - architecture',
      'sessions:',
      '  - task-4-2-session',
      '---',
      `# ${title}`,
      '',
      `${bodyTerm} remains verbatim in the imported record.`,
      '',
    ].join('\n');
    harness.writeNote('task-4-2-fixture.md', source);
    const sourceBefore = snapshotTree(harness.vaultPath);
    const daemon = await startPackagedAgentMemory(harness, agentMemoryPackagePath());
    const result = await runPackagedObsidianImporterAsync(
      daemon.baseUrl,
      [harness.vaultPath],
      {
        ...harness.importerEnvironment(),
        AGENTMEMORY_SECRET: '',
      },
    );

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.deepEqual(JSON.parse(result.stdout).counts, {
      discovered: 1,
      eligible: 1,
      imported: 1,
      alreadyPresent: 0,
      skipped: 0,
      failed: 0,
    });
    assert.equal(result.stdout.includes(harness.bearer), false);
    assert.equal(result.stderr.includes(harness.bearer), false);
    assert.equal(result.stdout.includes(bodyTerm), false);
    assert.equal(result.stderr.includes(bodyTerm), false);
    assert.deepEqual(snapshotTree(harness.vaultPath), sourceBefore);

    const proxyHarness = await startStockCoreProxy(harness, daemon);
    proxyEvidence = {
      root: harness.root,
      pid: proxyHarness.proxy.pid,
      processGroupId: proxyHarness.proxy.processGroupId,
      identity: proxyHarness.proxy.identity,
      port: proxyHarness.port,
    };
    try {
      const originalPath = path.join(harness.memoriesPath, 'task-4-2-fixture.md');
      const originalId = `mem_obsidian_${crypto.createHash('sha256').update('memories/task-4-2-fixture.md').digest('hex')}`;
      const recalled = await waitForStockRecall(
        proxyHarness,
        title,
        [
          title,
          bodyTerm,
          originalId,
          'memories/task-4-2-fixture.md',
          'obsidian-source:memories/task-4-2-fixture.md',
        ],
      );
      assert.match(JSON.stringify(recalled), /memories\/task-4-2-fixture\.md/);

      const changedTitle = 'Task 4.2 changed same-path title';
      const changedBodyTerm = 'task-4-2-changed-same-path-body-91bd';
      fs.writeFileSync(
        originalPath,
        source.replaceAll(title, changedTitle).replaceAll(bodyTerm, changedBodyTerm),
      );
      const changedSourceBefore = snapshotTree(harness.vaultPath);
      const rerun = await runPackagedObsidianImporterAsync(
        daemon.baseUrl,
        [harness.vaultPath],
        {
          ...harness.importerEnvironment(),
          AGENTMEMORY_SECRET: '',
        },
      );
      assert.equal(rerun.status, 0, `${rerun.stderr}\n${rerun.stdout}`);
      assert.deepEqual(JSON.parse(rerun.stdout).counts, {
        discovered: 1,
        eligible: 1,
        imported: 0,
        alreadyPresent: 1,
        skipped: 0,
        failed: 0,
      });
      assert.equal(rerun.stdout.includes(harness.bearer), false);
      assert.equal(rerun.stderr.includes(harness.bearer), false);
      assert.equal(rerun.stdout.includes(changedBodyTerm), false);
      assert.deepEqual(snapshotTree(harness.vaultPath), changedSourceBefore);

      const unchanged = await waitForStockRecall(
        proxyHarness,
        title,
        [title, bodyTerm, originalId, 'memories/task-4-2-fixture.md'],
      );
      assert.doesNotMatch(JSON.stringify(unchanged), new RegExp(changedBodyTerm));

      const renamedPath = path.join(harness.memoriesPath, 'task-4-2-renamed.md');
      fs.renameSync(originalPath, renamedPath);
      const renamedSourceBefore = snapshotTree(harness.vaultPath);
      const renamed = await runPackagedObsidianImporterAsync(
        daemon.baseUrl,
        [harness.vaultPath],
        {
          ...harness.importerEnvironment(),
          AGENTMEMORY_SECRET: '',
        },
      );
      assert.equal(renamed.status, 0, `${renamed.stderr}\n${renamed.stdout}`);
      assert.deepEqual(JSON.parse(renamed.stdout).counts, {
        discovered: 1,
        eligible: 1,
        imported: 1,
        alreadyPresent: 0,
        skipped: 0,
        failed: 0,
      });
      assert.equal(renamed.stdout.includes(harness.bearer), false);
      assert.equal(renamed.stderr.includes(harness.bearer), false);
      assert.equal(renamed.stdout.includes(changedBodyTerm), false);
      assert.deepEqual(snapshotTree(harness.vaultPath), renamedSourceBefore);

      const renamedSourcePath = 'memories/task-4-2-renamed.md';
      const renamedId = `mem_obsidian_${crypto.createHash('sha256').update(renamedSourcePath).digest('hex')}`;
      assert.notEqual(renamedId, originalId);
      const recalledRenamed = await waitForStockRecall(
        proxyHarness,
        changedTitle,
        [
          changedTitle,
          changedBodyTerm,
          renamedId,
          renamedSourcePath,
          `obsidian-source:${renamedSourcePath}`,
        ],
      );
      assert.match(JSON.stringify(recalledRenamed), new RegExp(renamedId));
      const recalledOriginalAfterRename = await waitForStockRecall(
        proxyHarness,
        title,
        [
          title,
          bodyTerm,
          originalId,
          'memories/task-4-2-fixture.md',
          'obsidian-source:memories/task-4-2-fixture.md',
        ],
      );
      assert.match(JSON.stringify(recalledOriginalAfterRename), new RegExp(originalId));
      assert.match(fs.readFileSync(harness.securityLog, 'utf8'), /find-generic-password -s mcpproxy -a fixture-bearer -w/);
      assert.equal(fs.readFileSync(harness.securityLog, 'utf8').trim().split('\n').length, 3);
      assert.doesNotMatch(fs.readFileSync(harness.securityLog, 'utf8'), new RegExp(harness.bearer));
      assert.doesNotMatch(proxyHarness.output.stderr, new RegExp(harness.bearer));
    } finally {
      const teardownStartedAt = Date.now();
      await stopOwnedDaemon(proxyHarness.proxy, {
        deadline: teardownStartedAt + harness.cleanupTimeoutMs,
      });
      assert.ok(
        Date.now() - teardownStartedAt <= harness.cleanupTimeoutMs,
        'mcpproxy teardown exceeded the harness deadline',
      );
      assertNoSecretOnDisk(harness.root, harness.bearer);
      assert.equal(proxyHarness.proxy.child.exitCode !== null, true);
      assert.equal(isProcessAlive(proxyHarness.proxy.pid), false);
      assert.equal(isProcessGroupAlive(proxyHarness.proxy.processGroupId), false);
      assert.equal(isProcessIdentityAlive(proxyHarness.proxy.identity), false);
      assert.deepEqual(proxyHarness.proxy.lastOwnershipSnapshot.groups, []);
      assert.deepEqual(proxyHarness.proxy.lastOwnershipSnapshot.records, []);
      assert.deepEqual(proxyHarness.proxy.lastOwnershipSnapshot.listeners, []);
      assert.deepEqual(proxyHarness.proxy.lastOwnershipSnapshot.probeErrors, []);
      assert.equal(fs.existsSync(harness.root), true);
      const portDeadline = Date.now() + harness.cleanupTimeoutMs;
      await Promise.all(
        proxyHarness.proxy.ports.map((port) => assertPortAvailable(port, portDeadline)),
      );
    }
  });
  assert.equal(fs.existsSync(proxyEvidence.root), false);
  await assertPortAvailable(proxyEvidence.port);
});

test('packaged wrapper reports exact mock outcomes and exits non-zero only for failed eligible notes', {
  timeout: 120_000,
}, async () => {
  await withObsidianImportHarness(async (harness) => {
    const firstBody = 'task-4-2-mock-first-body-3a1e';
    const secondBody = 'task-4-2-mock-second-body-4b2f';
    harness.writeNote('first.md', `# First mock note\n\n${firstBody}\n`);
    harness.writeNote('second.md', `# Second mock note\n\n${secondBody}\n`);
    const initialSource = snapshotTree(harness.vaultPath);
    const stored = new Map();
    let mode = 'success';
    let failPartialBatch = true;
    const endpoint = await startMockImportEndpoint(harness, ({ payload, authorization }) => {
      if (authorization !== `Bearer ${harness.bearer}`) {
        return { status: 401, body: { success: false, error: 'authentication rejected' } };
      }
      if (mode === 'auth') {
        return { status: 401, body: { success: false, error: 'authentication rejected' } };
      }
      if (mode === 'malformed') return { status: 200, body: '{not-json' };
      if (mode === 'invalid-counts') {
        return {
          body: {
            success: true,
            strategy: 'skip',
            sessions: 0,
            observations: 0,
            memories: 0,
            summaries: 0,
            skipped: 0,
          },
        };
      }
      if (mode === 'partial' && failPartialBatch) {
        failPartialBatch = false;
        return { status: 503, body: { error: 'independent batch failure' } };
      }
      return { body: successfulImportResponse(payload, stored) };
    });

    const runPackaged = () => runPackagedObsidianImporterAsync(
      endpoint.url,
      [harness.vaultPath],
      {
        ...harness.importerEnvironment(),
        AGENTMEMORY_SECRET: '',
      },
    );
    const assertReport = (result, counts, batches) => {
      assert.equal(result.stdout.includes(harness.bearer), false);
      assert.equal(result.stderr.includes(harness.bearer), false);
      assert.deepEqual(JSON.parse(result.stdout).counts, counts);
      assert.deepEqual(JSON.parse(result.stdout).batches, batches);
    };

    try {
      const dryRun = runPackagedObsidianImporter(endpoint.url, [harness.vaultPath, '--dry-run'], {
        ...harness.importerEnvironment(),
        AGENTMEMORY_SECRET: '',
        AGENTMEMORY_IMPORT_SECURITY_FAIL: '1',
      });
      assert.equal(dryRun.status, 0, `${dryRun.stderr}\n${dryRun.stdout}`);
      assert.deepEqual(JSON.parse(dryRun.stdout).counts, {
        discovered: 2,
        eligible: 2,
        imported: 0,
        alreadyPresent: 0,
        skipped: 0,
        failed: 0,
      });
      assert.deepEqual(JSON.parse(dryRun.stdout).batches, { submitted: 0, succeeded: 0, failed: 0 });
      assert.equal(endpoint.requests.length, 0);
      assert.equal(fs.existsSync(harness.securityLog), false);
      assert.deepEqual(snapshotTree(harness.vaultPath), initialSource);

      const first = await runPackaged();
      assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
      assertReport(
        first,
        { discovered: 2, eligible: 2, imported: 2, alreadyPresent: 0, skipped: 0, failed: 0 },
        { submitted: 1, succeeded: 1, failed: 0 },
      );
      assert.equal(first.stdout.includes(firstBody), false);
      assert.equal(first.stdout.includes(secondBody), false);
      assert.deepEqual(snapshotTree(harness.vaultPath), initialSource);

      const alreadyPresent = await runPackaged();
      assert.equal(alreadyPresent.status, 0, `${alreadyPresent.stderr}\n${alreadyPresent.stdout}`);
      assertReport(
        alreadyPresent,
        { discovered: 2, eligible: 2, imported: 0, alreadyPresent: 2, skipped: 0, failed: 0 },
        { submitted: 1, succeeded: 1, failed: 0 },
      );
      assert.deepEqual(snapshotTree(harness.vaultPath), initialSource);

      mode = 'auth';
      const authFailure = await runPackaged();
      assert.equal(authFailure.status, 1, `${authFailure.stderr}\n${authFailure.stdout}`);
      assertReport(
        authFailure,
        { discovered: 2, eligible: 2, imported: 0, alreadyPresent: 0, skipped: 0, failed: 2 },
        { submitted: 1, succeeded: 0, failed: 1 },
      );
      assert.match(JSON.parse(authFailure.stdout).failures[0].reason, /authentication/i);
      assert.deepEqual(snapshotTree(harness.vaultPath), initialSource);

      mode = 'invalid-counts';
      const invalidCounts = await runPackaged();
      assert.equal(invalidCounts.status, 1, `${invalidCounts.stderr}\n${invalidCounts.stdout}`);
      assertReport(
        invalidCounts,
        { discovered: 2, eligible: 2, imported: 0, alreadyPresent: 0, skipped: 0, failed: 2 },
        { submitted: 1, succeeded: 0, failed: 1 },
      );
      assert.match(JSON.parse(invalidCounts.stdout).failures[0].reason, /response counts/i);

      mode = 'malformed';
      const malformed = await runPackaged();
      assert.equal(malformed.status, 1, `${malformed.stderr}\n${malformed.stdout}`);
      assertReport(
        malformed,
        { discovered: 2, eligible: 2, imported: 0, alreadyPresent: 0, skipped: 0, failed: 2 },
        { submitted: 1, succeeded: 0, failed: 1 },
      );
      assert.match(JSON.parse(malformed.stdout).failures[0].reason, /invalid JSON/i);

      harness.writeNote('a-large.md', largeNoteBody('A packaged partial'));
      harness.writeNote('b-large.md', largeNoteBody('B packaged partial'));
      harness.writeNote('c.md', '# C packaged partial\n\nsmall later body\n');
      const partialSource = snapshotTree(harness.vaultPath);
      const requestsBeforePartial = endpoint.requests.length;
      mode = 'partial';
      const partial = await runPackaged();
      assert.equal(partial.status, 1, `${partial.stderr}\n${partial.stdout}`);
      assertReport(
        partial,
        { discovered: 5, eligible: 5, imported: 2, alreadyPresent: 2, skipped: 0, failed: 1 },
        { submitted: 2, succeeded: 1, failed: 1 },
      );
      assert.deepEqual(JSON.parse(partial.stdout).failures.map(({ relativePath }) => [relativePath]), [
        ['memories/a-large.md'],
      ]);
      assert.deepEqual(
        endpoint.requests.slice(requestsBeforePartial).map(({ payload }) => (
          payload.exportData.memories.map(({ files }) => files[0])
        )),
        [
          ['memories/a-large.md'],
          ['memories/b-large.md', 'memories/c.md', 'memories/first.md', 'memories/second.md'],
        ],
      );
      assert.equal(partial.stdout.includes('x'.repeat(100)), false);
      assert.deepEqual(snapshotTree(harness.vaultPath), partialSource);

      mode = 'success';
      const partialRerun = await runPackaged();
      assert.equal(partialRerun.status, 0, `${partialRerun.stderr}\n${partialRerun.stdout}`);
      assertReport(
        partialRerun,
        { discovered: 5, eligible: 5, imported: 1, alreadyPresent: 4, skipped: 0, failed: 0 },
        { submitted: 2, succeeded: 2, failed: 0 },
      );
      assert.deepEqual(snapshotTree(harness.vaultPath), partialSource);

      const securityInvocations = fs.readFileSync(harness.securityLog, 'utf8').trim().split('\n');
      assert.equal(securityInvocations.length, 7);
      assert.ok(securityInvocations.every((line) => /find-generic-password -s mcpproxy -a fixture-bearer -w/.test(line)));
      assert.doesNotMatch(fs.readFileSync(harness.securityLog, 'utf8'), new RegExp(harness.bearer));
    } finally {
      assert.equal(endpoint.requests.every(({ authorization }) => authorization === `Bearer ${harness.bearer}`), true);
    }
  });
});
