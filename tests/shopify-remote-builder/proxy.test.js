'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
} = require('./helpers');
const {
  getNetworkFixture,
  getRouteFixture,
} = require('./fixtures');

const POLICY_PROXY_PATH = path.join(
  repoRoot,
  'scripts/shopify-remote-builder-policy-proxy.nix',
);
const POLICY_PROXY_PORT = 1080;
const TEST_PROXY_USER = os.userInfo().username;

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-proxy-read-only', `
    const childProcess = require('node:child_process');
    const result = childProcess.spawnSync('nix', [process.argv[2], '--read-only', ...process.argv.slice(3)], {
      env: process.env,
      stdio: 'inherit',
    });
    if (result.error) {
      throw result.error;
    }
    process.exit(result.status ?? 1);
  `);
}

function loadPolicyProxy(fixture, proxyExecutable, options = {}) {
  const packageArguments = Object.entries({
    helperTimeoutSeconds: options.helperTimeoutSeconds,
    maxRedirectsLimit: options.maxRedirectsLimit,
    maxRequestBytes: options.maxRequestBytes,
    helperOutputBytesLimit: options.helperOutputBytesLimit,
    maxWorkspaceBytesLimit: options.maxWorkspaceBytesLimit,
    policyPort: options.policyPort,
    startupGraceMilliseconds: options.startupGraceMilliseconds,
    timeoutSecondsLimit: options.timeoutSecondsLimit,
  })
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name} = ${Number(value)};`)
    .join('\n        ');
  const proxyUserArgument = options.proxyUser === undefined
    ? ''
    : `proxyUser = ${nixString(options.proxyUser)};`;
  const processStatusArgument = options.processStatusExecutable === undefined
    ? ''
    : `processStatusExecutable = ${nixString(options.processStatusExecutable)};`;
  const routeArgument = nixString(options.routeExecutable ?? fixture.controls.route.executable);
  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ${nixString(POLICY_PROXY_PATH)} {
        dante = pkgs.writeShellScriptBin "fixture-dante-package" "exit 1";
        proxyExecutable = ${nixString(proxyExecutable)};
        routeExecutable = ${routeArgument};
        ${proxyUserArgument}
        ${processStatusArgument}
        ${packageArguments}
      }).text
  `;
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-policy-proxy');
  fs.writeFileSync(executable, nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture),
  }), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

test('policy proxy accepts the unprivileged listener port and rejects privileged ports', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dante = createDanteBridge(fixture, { name: 'port-validation' });
    assert.doesNotThrow(() => loadPolicyProxy(fixture, dante.executable, {
      policyPort: POLICY_PROXY_PORT,
    }));

    for (const policyPort of [0, 1023]) {
      assert.throws(
        () => loadPolicyProxy(fixture, dante.executable, { policyPort }),
        error => /policyPort/.test(error.stderr ?? error.message),
        `policy port ${policyPort} must be rejected`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test('policy proxy accepts the unprivileged runtime identity and rejects reserved identities', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dante = createDanteBridge(fixture, { name: 'runtime-identity' });
    assert.doesNotThrow(() => loadPolicyProxy(fixture, dante.executable, {
      proxyUser: 'nixremote-test',
    }));

    for (const proxyUser of ['root', 'nobody', '', '-nixremote', 'NixRemote', 'nix remote']) {
      assert.throws(
        () => loadPolicyProxy(fixture, dante.executable, { proxyUser }),
        error => /assertion.*failed/i.test(error.stderr ?? error.message),
        `proxy user ${JSON.stringify(proxyUser)} must be rejected`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

let pinnedDanteExecutable;

function getPinnedDanteExecutable(fixture) {
  pinnedDanteExecutable ??= nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in (toString pkgs.dante) + "/bin/sockd"
  `, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture),
  });
  return pinnedDanteExecutable;
}

function createDanteBridge(fixture, options = {}) {
  const logPath = path.join(fixture.paths.logs, `dante-${options.name ?? 'fixture'}.json`);
  const proxyExecutable = fixture.controls.proxy.executable;
  const behavior = options.behavior ?? 'stay';
  const parserExecutable = options.parserExecutable ?? null;
  const realParser = options.realParser === true;
  const runtimeContract = options.runtimeContract === true;
  const forkChild = options.forkChild === true;
  const executable = fixture.createExecutable(`dante-${options.name ?? 'fixture'}`, `
    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const parserArgs = ${JSON.stringify(realParser)}
      ? ['-V', '-f', args[1], '-N', '1']
      : args;
    const result = childProcess.spawnSync(
      ${JSON.stringify(realParser ? parserExecutable : proxyExecutable)},
      parserArgs,
      {
      encoding: 'utf8',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let descendant;
    if (${JSON.stringify(forkChild)} && !result.error && result.status === 0) {
      descendant = childProcess.spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000);',
      ], { stdio: 'ignore' });
    }
    let runtimeFailure = null;
    if (${JSON.stringify(runtimeContract)} && !result.error && result.status === 0) {
      const config = fs.readFileSync(args[1], 'utf8');
      const privileged = config.match(/^user\\.privileged:\\s*(\\S+)$/m)?.[1];
      const unprivileged = config.match(/^user\\.unprivileged:\\s*(\\S+)$/m)?.[1];
      const internalPorts = [...config.matchAll(/^internal: [^\\n]+ port = ([0-9]+)$/gm)]
        .map(match => match[1]);
      const safeUser = privileged !== undefined
        && /^[a-z_][a-z0-9_-]{0,31}$/.test(privileged)
        && privileged !== 'root'
        && privileged !== 'nobody';
      if (
        process.getuid() === 0
        || !safeUser
        || privileged !== unprivileged
        || internalPorts.length !== 3
        || internalPorts.some(port => port !== '1080')
      ) {
        runtimeFailure = {
          internalPorts,
          privileged,
          uid: process.getuid(),
          unprivileged,
        };
      }
    }
    fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({
      behavior: ${JSON.stringify(behavior)},
      childSignal: result.signal,
      childStatus: runtimeFailure === null ? result.status : 1,
      childPid: descendant?.pid,
      childEnv: process.env,
      pid: process.pid,
      args,
      runtimeFailure,
    }));
    if (${JSON.stringify(behavior)} === 'fail' || result.error || result.status !== 0 || runtimeFailure !== null) {
      process.exit(runtimeFailure === null ? (result.status ?? 1) : 1);
    }
    const stop = () => process.exit(0);
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    process.on('SIGHUP', stop);
    setInterval(() => {}, 1000);
  `);
  return { executable, logPath };
}

function createHeldOpenExecutable(fixture, name, output) {
  return fixture.createExecutable(name, `
    process.stdout.write(${JSON.stringify(output)});
    setInterval(() => {}, 1000);
  `);
}

function makeRouteResponse(routeCase) {
  return {
    gateway: routeCase.observedGateway,
    interface: routeCase.observedInterface,
    vpn: routeCase.vpn,
  };
}

function networkRequest(name, overrides = {}) {
  const network = getNetworkFixture(name);
  return {
    dnsRecords: network.dnsRecords,
    destinations: network.destinations.map(({ hostname, addresses }) => ({ hostname, addresses })),
    redirects: network.redirects.map(({ from, to }) => ({ from, to })),
    ...overrides,
  };
}

function ipv6NetworkRequest(address) {
  return {
    dnsRecords: [{
      hostname: 'ipv6-source.example.test',
      recordType: 'AAAA',
      answers: [address],
    }],
    destinations: [{
      hostname: 'ipv6-source.example.test',
      addresses: [address],
    }],
    redirects: [],
  };
}

function cnameNetworkRequest({ target, targetRecord, aliasAddresses = ['93.184.216.34'] } = {}) {
  const targetHostname = target ?? 'alias-target.example.test';
  const records = [{
    hostname: 'alias-source.example.test',
    recordType: 'CNAME',
    answers: aliasAddresses,
    target: targetHostname,
  }];
  if (targetRecord !== undefined) {
    records.push(targetRecord);
  }
  return {
    dnsRecords: records,
    destinations: [{
      hostname: 'alias-source.example.test',
      addresses: aliasAddresses,
    }],
    redirects: [],
  };
}

function makeRequest(overrides = {}) {
  return {
    schemaVersion: 1,
    nonce: 'fixture-proxy-run-0001',
    publicInterface: 'en0',
    declaredGateway: '192.168.1.1',
    maxRedirects: 5,
    timeoutSeconds: 30,
    maxWorkspaceBytes: 1024 * 1024,
    ...overrides,
  };
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

function waitForClose(child, timeout = 5_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ signal: child.signalCode, status: child.exitCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('policy proxy did not exit')), timeout);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ signal, status });
    });
  });
}

function startProxy(executable, fixture, request, options = {}) {
  const child = childProcess.spawn(executable, [], {
    cwd: fixture.root,
    env: fixture.environment({
      ALL_PROXY: 'fixture-poisoned-all-proxy',
      AWS_ACCESS_KEY_ID: 'fixture-poisoned-aws-key',
      HOME: 'fixture-poisoned-home',
      HTTPS_PROXY: 'fixture-poisoned-https-proxy',
      NIX_CONFIG: 'experimental-features = poisoned-feature',
      SSH_AUTH_SOCK: 'fixture-poisoned-agent',
    }),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let settled = false;
  let resolveLine;
  let rejectLine;
  const firstLine = new Promise((resolve, reject) => {
    resolveLine = resolve;
    rejectLine = reject;
  });
  const settleLine = line => {
    if (!settled) {
      settled = true;
      resolveLine(JSON.parse(line));
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    const newline = stdout.indexOf('\n');
    if (newline >= 0) {
      const line = stdout.slice(0, newline);
      try {
        settleLine(line);
      } catch (error) {
        rejectLine(error);
      }
    }
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('error', error => {
    if (!settled) {
      settled = true;
      rejectLine(error);
    }
  });
  child.once('close', (status, signal) => {
    if (!settled) {
      settled = true;
      rejectLine(new Error(`proxy exited before result: status=${status} signal=${signal} stderr=${stderr}`));
    }
  });
  child.stdin.write(options.input ?? `${JSON.stringify(request)}\n`);
  return {
    child,
    firstLine,
    get stderr() {
      return stderr;
    },
    get stdout() {
      return stdout;
    },
  };
}

function waitForFirstLineWithin(session, timeoutMilliseconds) {
  let timer;
  return Promise.race([
    session.firstLine,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`policy proxy did not emit a result within ${timeoutMilliseconds}ms`));
      }, timeoutMilliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitForProcessGone(pid, timeoutMilliseconds = 3_000) {
  const startedAt = Date.now();
  while (processExists(pid)) {
    if (Date.now() - startedAt >= timeoutMilliseconds) {
      throw new Error(`process ${pid} remained alive`);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

function createProcessStatusRecorder(fixture) {
  const logPath = path.join(fixture.paths.logs, 'process-status.jsonl');
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const executable = fixture.createExecutable('process-status', `
    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const logPath = ${JSON.stringify(logPath)};
    fs.appendFileSync(logPath, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');
    const result = childProcess.spawnSync('/bin/ps', process.argv.slice(2), {
      encoding: 'utf8',
      env: process.env,
    });
    process.stdout.write(result.stdout || '');
  `);
  return {
    executable,
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
  };
}

async function stopProxy(session) {
  if (session.child.exitCode === null && session.child.signalCode === null) {
    session.child.kill('SIGTERM');
  }
  return waitForClose(session.child);
}

function assertNoCredentialLeak(result, forbiddenValues = []) {
  const serialized = JSON.stringify(result);
  for (const value of forbiddenValues) {
    assert.doesNotMatch(
      serialized,
      new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    );
  }
}

function assertMinimalHelperEnvironment(environment, extraKeys = []) {
  const allowedKeys = new Set(['LC_ALL', 'PATH', '__CF_USER_TEXT_ENCODING', ...extraKeys]);
  assert.deepEqual(
    Object.keys(environment).filter(key => allowedKeys.has(key)).sort(),
    Object.keys(environment).sort(),
  );
  assert.equal(environment.ALL_PROXY, undefined);
  assert.equal(environment.AWS_ACCESS_KEY_ID, undefined);
  assert.equal(environment.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(environment.AWS_SESSION_TOKEN, undefined);
  assert.equal(environment.GITHUB_TOKEN, undefined);
  assert.equal(environment.HOME, extraKeys.includes('HOME') ? environment.HOME : undefined);
  assert.equal(environment.HTTPS_PROXY, undefined);
  assert.equal(environment.HTTP_PROXY, undefined);
  assert.equal(environment.NIX_CONFIG, undefined);
  assert.equal(environment.NIX_PATH, undefined);
  assert.equal(environment.NIX_REMOTE, undefined);
  assert.equal(environment.NIX_SUBSTITUTERS, undefined);
  assert.equal(environment.POST_BUILD_HOOK, undefined);
  assert.equal(environment.SSH_AUTH_SOCK, undefined);
  assert.equal(environment.SSH_OPTIONS, undefined);
}

function assertProxyPolicyConfig(config, publicInterface, proxyUser = '_nixremote') {
  const escapedProxyUser = proxyUser.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.match(config, new RegExp(`^user\\.privileged: ${escapedProxyUser}$`, 'm'));
  assert.match(config, new RegExp(`^user\\.unprivileged: ${escapedProxyUser}$`, 'm'));
  assert.doesNotMatch(config, /^user\.(?:privileged|unprivileged): (?:root|nobody)$/m);
  assert.match(config, new RegExp(`internal: 127\\.0\\.0\\.1 port = ${POLICY_PROXY_PORT}`));
  assert.match(config, new RegExp(`internal: ::1 port = ${POLICY_PROXY_PORT}`));
  assert.match(config, new RegExp(`internal: ${publicInterface} port = ${POLICY_PROXY_PORT}`));
  assert.match(config, new RegExp(`external: ${publicInterface}`));
  assert.match(config, /client pass \{[^}]*from: 127\.0\.0\.1\/32[^}]*to: 0\.0\.0\.0\/0/);
  assert.match(config, /client pass \{[^}]*from: ::1\/128[^}]*to: ::\/0/);
  assert.match(config, /client block \{[^}]*from: 0\.0\.0\.0\/0[^}]*to: 0\.0\.0\.0\/0/);
  assert.match(config, /client block \{[^}]*from: ::\/0[^}]*to: ::\/0/);
  assert.doesNotMatch(config, /client pass \{[^}]*from: 0\.0\.0\.0\/0/);
  assert.doesNotMatch(config, /client pass \{[^}]*from: ::\/0/);
  assert.match(config, /socks pass \{[\s\S]*?to: 192\.0\.0\.9\/32 port = 443/);
  assert.match(config, /socks block \{[\s\S]*?to: 10\.0\.0\.0\/8 port = 443/);
  assert.match(config, /socks pass \{[\s\S]*?to: 0\.0\.0\.0\/0 port = 443/);
  assert.match(config, /socks pass \{[\s\S]*?to: ::\/0 port = 443/);
  assert.match(config, /socks block \{[^}]*from: 0\.0\.0\.0\/0[^}]*to: 0\.0\.0\.0\/0/);
  assert.match(config, /socks block \{[^}]*from: ::\/0[^}]*to: ::\/0/);
  assert.doesNotMatch(config, /proxy (?:pass|block)/);
  assert.match(config, /command: connect/);
  assert.match(config, /to: [^\n]+ port = 443/);
  assert.doesNotMatch(config, new RegExp(`port\\s*=\\s*(?!443\\b|${POLICY_PROXY_PORT}\\b)[0-9]+`));
  for (const range of [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.88.99.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
    '255.255.255.255/32',
  ]) {
    assert.match(config, new RegExp(`to: ${range.replaceAll('.', '\\.').replaceAll('/', '\\/')}`), range);
  }
  for (const range of [
    '::/128',
    '::1/128',
    '64:ff9b:1::/48',
    '100::/64',
    '100:0:0:1::/64',
    '2001::/23',
    '2001:2::/48',
    '2001:10::/28',
    '2001:db8::/32',
    '2002::/16',
    '3fff::/20',
    '5f00::/16',
    'fc00::/7',
    'fe80::/10',
    'ff00::/8',
  ]) {
    assert.match(config, new RegExp(`to: ${range.replaceAll(':', '\\:').replaceAll('/', '\\/')}`), range);
  }
  assert.match(config, /IANA special-purpose policy snapshot: 2025-10-09/);
  assert.match(config, /IPv4-mapped IPv6 is represented as IPv4 by Dante/);
  assert.match(config, /socks pass \{[\s\S]*?to: 64:ff9b::\/96/);
  for (const [exception, containingRange] of [
    ['192.0.0.9/32', '192.0.0.0/24'],
    ['192.0.0.10/32', '192.0.0.0/24'],
    ['2001:1::1/128', '2001::/23'],
    ['2001:1::2/128', '2001::/23'],
    ['2001:1::3/128', '2001::/23'],
    ['2001:3::/32', '2001::/23'],
    ['2001:4:112::/48', '2001::/23'],
    ['2001:20::/28', '2001::/23'],
    ['2001:30::/28', '2001::/23'],
  ]) {
    const exceptionIndex = config.indexOf(`to: ${exception}`);
    const containingIndex = config.indexOf(`to: ${containingRange}`);
    assert.notEqual(exceptionIndex, -1, exception);
    assert.notEqual(containingIndex, -1, containingRange);
    assert.ok(exceptionIndex < containingIndex, `${exception} must pass before ${containingRange}`);
  }
  assert.doesNotMatch(config, /direct|bypass/i);
}

test('policy proxy starts one bounded SOCKS5h endpoint with strict bind and destination rules', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, {
      name: 'public',
      parserExecutable: getPinnedDanteExecutable(fixture),
      realParser: true,
      runtimeContract: true,
    });
    const processStatus = createProcessStatusRecorder(fixture);
    const executable = loadPolicyProxy(fixture, dante.executable, {
      proxyUser: TEST_PROXY_USER,
      processStatusExecutable: processStatus.executable,
    });
    session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-redirect'),
    }));

    const result = await session.firstLine;
    const danteStartup = JSON.parse(fs.readFileSync(dante.logPath, 'utf8'));
    assert.equal(danteStartup.runtimeFailure, null);
    assert.deepEqual(result, {
      bindInterface: 'en0',
      decision: 'ready',
      endpoint: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
      maxRedirects: 5,
      nonce: 'fixture-proxy-run-0001',
      port: POLICY_PROXY_PORT,
      proxyEnvironment: {
        ALL_PROXY: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        HTTPS_PROXY: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        HTTP_PROXY: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        NO_PROXY: '',
        all_proxy: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        https_proxy: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        http_proxy: `socks5h://127.0.0.1:${POLICY_PROXY_PORT}`,
        no_proxy: '',
      },
      reason: null,
      schemaVersion: 1,
    }, session.stderr);

    assert.deepEqual(fixture.controls.route.calls()[0].args, ['-n', 'get', 'default']);
    const routeEnvironment = fixture.controls.route.calls()[0].env;
    assert.equal(routeEnvironment.ALL_PROXY, undefined);
    assert.equal(routeEnvironment.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(routeEnvironment.HTTPS_PROXY, undefined);
    assert.equal(routeEnvironment.NIX_CONFIG, undefined);
    assertMinimalHelperEnvironment(routeEnvironment);

    assert.deepEqual(danteStartup.args.slice(0, 1), ['-f']);
    assert.deepEqual(danteStartup.args.slice(2), ['-N', '1']);
    assert.equal(danteStartup.childEnv.ALL_PROXY, undefined);
    assert.equal(danteStartup.childEnv.AWS_ACCESS_KEY_ID, undefined);
    assert.equal(danteStartup.childEnv.HTTPS_PROXY, undefined);
    assert.equal(danteStartup.childEnv.NIX_CONFIG, undefined);
    assertMinimalHelperEnvironment(danteStartup.childEnv, ['HOME', 'LANG', 'TMPDIR']);
    const configPath = danteStartup.args[1];
    assert.equal(path.isAbsolute(configPath), true);
    assert.equal(fs.existsSync(configPath), true);
    assertProxyPolicyConfig(fs.readFileSync(configPath, 'utf8'), 'en0', TEST_PROXY_USER);

    const processStatusCalls = processStatus.calls();
    assert.notEqual(processStatusCalls.length, 0);
    for (const call of processStatusCalls) {
      assertMinimalHelperEnvironment(call.env);
    }

    assert.equal(danteStartup.childStatus, 0);
    assert.equal(processExists(danteStartup.pid), true);

    await stopProxy(session);
    assert.equal(processExists(danteStartup.pid), false);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
    }
    fixture.cleanup();
  }
});

function addressNetworkRequest(addresses, redirects = []) {
  const hostname = 'policy-target.example.test';
  const recordType = addresses.some(address => address.includes(':')) ? 'AAAA' : 'A';
  return {
    dnsRecords: [{ hostname, recordType, answers: addresses }],
    destinations: [{ hostname, addresses }],
    redirects,
  };
}

test('IANA policy rejects omitted IPv4 and IPv6 ranges after canonical normalization', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'canonical-policy' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const cases = [
      ['ipv4-6to4-relay', ['192.88.99.7']],
      ['ipv6-compressed', ['2001:40::1']],
      ['ipv6-expanded', ['2001:0040:0000:0000:0000:0000:0000:0001']],
      ['ipv6-zero-padded', ['2001:0040:0:0:0:0:0:1']],
      ['mixed-public-and-omitted-ipv6', ['93.184.216.34', '2001:0040:0000:0000:0000:0000:0000:0001']],
    ];

    for (const [name, addresses] of cases) {
      const session = startProxy(executable, fixture, makeRequest({
        network: addressNetworkRequest(addresses),
      }));
      const result = await session.firstLine;
      if (result.decision === 'ready') {
        await stopProxy(session);
      } else {
        await waitForClose(session.child);
      }
      assert.equal(result.decision, 'ineligible', name);
      assert.equal(result.reason, 'private endpoint', name);
    }
    assert.equal(fixture.controls.proxy.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('redirect targets must resolve through validated evidence and stay within the redirect bound', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'redirect-binding' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const cases = [
      ['private-literal', networkRequest('public-destination', {
        redirects: [{
          from: 'https://public-source.example.test/source',
          to: 'https://10.0.0.7/private',
        }],
      })],
      ['unresolved-target', networkRequest('public-destination', {
        redirects: [{
          from: 'https://public-source.example.test/source',
          to: 'https://unresolved.example.test/private',
        }],
      })],
      ['mixed-target', networkRequest('public-destination', {
        dnsRecords: [
          ...getNetworkFixture('public-destination').dnsRecords,
          {
            hostname: 'mixed-redirect.example.test',
            recordType: 'A',
            answers: ['10.0.0.7', '93.184.216.35'],
          },
        ],
        destinations: [
          ...getNetworkFixture('public-destination').destinations.map(({ hostname, addresses }) => ({
            hostname,
            addresses,
          })),
          {
            hostname: 'mixed-redirect.example.test',
            addresses: ['10.0.0.7', '93.184.216.35'],
          },
        ],
        redirects: [{
          from: 'https://public-source.example.test/source',
          to: 'https://mixed-redirect.example.test/private',
        }],
      })],
    ];

    for (const [name, network] of cases) {
      const session = startProxy(executable, fixture, makeRequest({ network }));
      const result = await session.firstLine;
      if (result.decision === 'ready') {
        await stopProxy(session);
      } else {
        await waitForClose(session.child);
      }
      assert.equal(result.decision, 'ineligible', name);
      assert.equal(result.reason, 'private endpoint', name);
    }

    const publicChain = {
      dnsRecords: [
        { hostname: 'public-source.example.test', recordType: 'A', answers: ['93.184.216.34'] },
        { hostname: 'public-mirror.example.test', recordType: 'A', answers: ['93.184.216.35'] },
        { hostname: 'public-final.example.test', recordType: 'A', answers: ['93.184.216.36'] },
      ],
      destinations: [
        { hostname: 'public-source.example.test', addresses: ['93.184.216.34'] },
        { hostname: 'public-mirror.example.test', addresses: ['93.184.216.35'] },
        { hostname: 'public-final.example.test', addresses: ['93.184.216.36'] },
      ],
      redirects: [
        {
          from: 'https://public-source.example.test/source',
          to: 'https://public-mirror.example.test/source',
        },
        {
          from: 'https://public-mirror.example.test/source',
          to: 'https://public-final.example.test/source',
        },
      ],
    };
    const allowedSession = startProxy(executable, fixture, makeRequest({
      maxRedirects: 2,
      network: publicChain,
    }));
    const allowedResult = await allowedSession.firstLine;
    assert.equal(allowedResult.decision, 'ready');
    assert.equal(allowedResult.maxRedirects, 2);
    await stopProxy(allowedSession);

    const boundedSession = startProxy(executable, fixture, makeRequest({
      maxRedirects: 1,
      network: publicChain,
    }));
    const boundedResult = await boundedSession.firstLine;
    assert.equal(boundedResult.decision, 'ineligible');
    assert.equal(boundedResult.reason, 'resource limit');
    await waitForClose(boundedSession.child);
  } finally {
    fixture.cleanup();
  }
});

test('missing declared gateway fails before route inspection or proxy startup', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'missing-gateway' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const request = makeRequest({ network: networkRequest('public-destination') });
    delete request.declaredGateway;
    const session = startProxy(executable, fixture, request);
    const result = await session.firstLine;

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'schema drift');
    assert.equal(fixture.controls.route.calls().length, 0);
    assert.equal(fixture.controls.proxy.calls().length, 0);
    await waitForClose(session.child);
  } finally {
    fixture.cleanup();
  }
});

test('over-limit held-open input is rejected without materializing an unbounded request line', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const dante = createDanteBridge(fixture, { name: 'bounded-input' });
    const executable = loadPolicyProxy(fixture, dante.executable, { maxRequestBytes: 64 });
    session = startProxy(executable, fixture, {}, { input: 'x'.repeat(1024) });
    const result = await waitForFirstLineWithin(session, 1_500);

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'resource limit');
    assert.equal(fixture.controls.proxy.calls().length, 0);
    await waitForClose(session.child);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
      await waitForClose(session.child).catch(() => {});
    }
    fixture.cleanup();
  }
});

test('private, mixed, CNAME, and private-redirect destinations fail before proxy start', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'private-destination' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    for (const name of [
      'private-destination',
      'mixed-destination',
      'private-cname',
      'private-redirect',
    ]) {
      const session = startProxy(executable, fixture, makeRequest({ network: networkRequest(name) }));
      const result = await session.firstLine;

      assert.equal(result.decision, 'ineligible', name);
      assert.equal(result.reason, 'private endpoint', name);
      assert.equal(result.nonce, 'fixture-proxy-run-0001', name);
      assert.equal(fixture.controls.proxy.calls().length, 0, name);
      assert.equal(fs.existsSync(dante.logPath), false, name);
      assertNoCredentialLeak(result, [
        'https://public-source.example.test/source',
        'fixture-poisoned-https-proxy',
      ]);
      await waitForClose(session.child);
    }
  } finally {
    fixture.cleanup();
  }
});

test('unexpected default and VPN routes fail closed without starting Dante', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dante = createDanteBridge(fixture, { name: 'unexpected-route' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    for (const name of ['unexpected-default', 'unexpected-vpn']) {
      const routeCase = getRouteFixture(name);
      fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
      const session = startProxy(executable, fixture, makeRequest({
        network: networkRequest('public-destination'),
      }));
      const result = await session.firstLine;

      assert.equal(result.decision, 'ineligible', name);
      assert.equal(result.reason, 'unexpected route', name);
      assert.equal(fixture.controls.proxy.calls().length, 0, name);
      assert.equal(fs.existsSync(dante.logPath), false, name);
      await waitForClose(session.child);
    }
  } finally {
    fixture.cleanup();
  }
});

test('malformed route and direct-proxy request controls fail closed without leaking values', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    fixture.controls.route.setDefault({
      stdout: 'fixture-route-malformed-secret\n',
    });
    const dante = createDanteBridge(fixture, { name: 'malformed' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const session = startProxy(executable, fixture, makeRequest({
      directProxy: 'https://fixture-user:fixture-password@example.test/?token=fixture-query',
      network: networkRequest('public-destination'),
    }));
    const result = await session.firstLine;

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'schema drift');
    assert.equal(fixture.controls.route.calls().length, 0);
    assert.equal(fixture.controls.proxy.calls().length, 0);
    assertNoCredentialLeak(result, [
      'fixture-route-malformed-secret',
      'fixture-user',
      'fixture-password',
      'fixture-query',
    ]);
    await waitForClose(session.child);

    const malformedRouteSession = startProxy(
      executable,
      fixture,
      makeRequest({ network: networkRequest('public-destination') }),
    );
    const malformedRouteResult = await malformedRouteSession.firstLine;
    assert.equal(malformedRouteResult.decision, 'ineligible');
    assert.equal(malformedRouteResult.reason, 'unexpected route');
    assertNoCredentialLeak(malformedRouteResult, ['fixture-route-malformed-secret']);
    await waitForClose(malformedRouteSession.child);
  } finally {
    fixture.cleanup();
  }
});

test('requested redirect limits are enforced before proxy startup', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'redirect-limit' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const session = startProxy(executable, fixture, makeRequest({
      maxRedirects: 0,
      network: networkRequest('public-redirect'),
    }));
    const result = await session.firstLine;

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'resource limit');
    assert.equal(fixture.controls.route.calls().length, 0);
    assert.equal(fixture.controls.proxy.calls().length, 0);
    assert.equal(fs.existsSync(dante.logPath), false);
    await waitForClose(session.child);
  } finally {
    fixture.cleanup();
  }
});

test('IANA non-global IPv6 destinations fail before proxy startup', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'ipv6-private' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const session = startProxy(executable, fixture, makeRequest({
      network: ipv6NetworkRequest('fc00::1'),
    }));
    const result = await session.firstLine;

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'private endpoint');
    assert.equal(fixture.controls.route.calls().length, 0);
    assert.equal(fixture.controls.proxy.calls().length, 0);
    await waitForClose(session.child);
  } finally {
    fixture.cleanup();
  }
});

test('Dante startup failure is reported and its transient state is removed', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    fixture.controls.proxy.setDefault({
      status: 1,
      stderr: 'fixture-proxy-startup-secret\n',
    });
    const dante = createDanteBridge(fixture, { behavior: 'fail', name: 'startup-failure' });
    const executable = loadPolicyProxy(fixture, dante.executable, {
      startupGraceMilliseconds: 3000,
    });
    const session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-destination'),
    }));
    const result = await session.firstLine;

    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'proxy startup failure');
    assert.equal(fixture.controls.proxy.calls().length, 1);
    assertNoCredentialLeak(result, ['fixture-proxy-startup-secret']);
    const danteState = JSON.parse(fs.readFileSync(dante.logPath, 'utf8'));
    assert.equal(processExists(danteState.pid), false);
    await waitForClose(session.child);
  } finally {
    fixture.cleanup();
  }
});

test('SIGTERM stops Dante and removes one-run proxy state', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'signal' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    session = startProxy(executable, fixture, makeRequest({
      timeoutSeconds: 60,
      network: networkRequest('public-destination'),
    }));
    await session.firstLine;
    const proxyCalls = fixture.controls.proxy.calls();
    const configPath = proxyCalls[0].args[1];
    const danteState = JSON.parse(fs.readFileSync(dante.logPath, 'utf8'));
    assert.equal(processExists(danteState.pid), true);
    assert.equal(fs.existsSync(configPath), true);

    session.child.kill('SIGTERM');
    await waitForClose(session.child);
    assert.equal(processExists(danteState.pid), false);
    assert.equal(fs.existsSync(configPath), false);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
    }
    fixture.cleanup();
  }
});

test('network evidence is mandatory and CNAME targets require complete public DNS evidence', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'cname-evidence' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    const cases = [
      ['missing-network-evidence', makeRequest(), 'schema drift'],
      ['missing-cname-target-record', makeRequest({
        network: cnameNetworkRequest(),
      }), 'private endpoint'],
      ['private-cname-target', makeRequest({
        network: cnameNetworkRequest({
          targetRecord: {
            hostname: 'alias-target.example.test',
            recordType: 'A',
            answers: ['10.0.0.7'],
          },
        }),
      }), 'private endpoint'],
      ['unresolved-redirect-target', makeRequest({
        network: {
          dnsRecords: [{
            hostname: 'public-source.example.test',
            recordType: 'A',
            answers: ['93.184.216.34'],
          }],
          destinations: [{
            hostname: 'public-source.example.test',
            addresses: ['93.184.216.34'],
          }],
          redirects: [{
            from: 'https://public-source.example.test/source',
            to: 'https://unresolved.example.test/final',
          }],
        },
      }), 'private endpoint'],
      ['missing-destination-evidence', makeRequest({
        network: {
          dnsRecords: [{
            hostname: 'public-source.example.test',
            recordType: 'A',
            answers: ['93.184.216.34'],
          }],
          destinations: [],
          redirects: [],
        },
      }), 'schema drift'],
    ];

    for (const [name, request, reason] of cases) {
      const session = startProxy(executable, fixture, request);
      const result = await session.firstLine;
      assert.equal(result.decision, 'ineligible', name);
      assert.equal(result.reason, reason, name);
      if (result.decision === 'ready') {
        await stopProxy(session);
      } else {
        await waitForClose(session.child);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

test('nonce validation is explicit, bounded, and accepts one valid invocation nonce', async () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'nonce' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    for (const nonce of ['', 'a'.repeat(129), 'fixture nonce', 'fixture/nonce']) {
      const session = startProxy(executable, fixture, makeRequest({
        nonce,
        network: networkRequest('public-destination'),
      }));
      const result = await session.firstLine;
      assert.equal(result.decision, 'ineligible', JSON.stringify(nonce));
      assert.equal(result.reason, 'schema drift', JSON.stringify(nonce));
      assert.equal(fixture.controls.route.calls().length, 0, JSON.stringify(nonce));
      assert.equal(fixture.controls.proxy.calls().length, 0, JSON.stringify(nonce));
      await waitForClose(session.child);
    }

    const validSession = startProxy(executable, fixture, makeRequest({
      nonce: 'A9._-z',
      network: networkRequest('public-destination'),
    }));
    const validResult = await validSession.firstLine;
    assert.equal(validResult.decision, 'ready');
    assert.equal(validResult.nonce, 'A9._-z');
    await stopProxy(validSession);
    assert.equal(fixture.controls.proxy.calls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('held-open oversized route helper is bounded and cannot block validation', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const heldOpenRoute = createHeldOpenExecutable(
      fixture,
      'held-open-route',
      'R'.repeat(1024 * 1024),
    );
    const dante = createDanteBridge(fixture, { name: 'held-open-route' });
    const executable = loadPolicyProxy(fixture, dante.executable, {
      helperTimeoutSeconds: 1,
      routeExecutable: heldOpenRoute,
    });
    session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-destination'),
    }));
    const result = await waitForFirstLineWithin(session, 2_500);
    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'unexpected route');
    await waitForClose(session.child);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
      await waitForClose(session.child).catch(() => {});
    }
    fixture.cleanup();
  }
});

test('finite oversized route helper output is rejected before Dante startup', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const routeCase = getRouteFixture('declared-en0');
    const oversizedRoute = fixture.createExecutable('finite-oversized-route', `
      const routeOutput = ${JSON.stringify(JSON.stringify(makeRouteResponse(routeCase)))};
      process.stdout.write(routeOutput + ' '.repeat(512));
    `);
    const dante = createDanteBridge(fixture, { name: 'finite-oversized-route' });
    const executable = loadPolicyProxy(fixture, dante.executable, {
      helperOutputBytesLimit: 256,
      routeExecutable: oversizedRoute,
    });
    session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-destination'),
    }));
    const result = await session.firstLine;

    if (result.decision === 'ready') {
      await stopProxy(session);
    } else {
      await waitForClose(session.child);
    }
    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'resource limit');
    assert.equal(fixture.controls.proxy.calls().length, 0);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
      await waitForClose(session.child).catch(() => {});
    }
    fixture.cleanup();
  }
});

test('held-open oversized process-status helper is bounded during Dante startup', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const heldOpenStatus = createHeldOpenExecutable(
      fixture,
      'held-open-process-status',
      'S'.repeat(1024 * 1024),
    );
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { name: 'held-open-status' });
    const executable = loadPolicyProxy(fixture, dante.executable, {
      helperTimeoutSeconds: 1,
      processStatusExecutable: heldOpenStatus,
      startupGraceMilliseconds: 100,
    });
    session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-destination'),
    }));
    const result = await waitForFirstLineWithin(session, 2_500);
    assert.equal(result.decision, 'ineligible');
    assert.equal(result.reason, 'proxy startup failure');
    await waitForClose(session.child);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
      await waitForClose(session.child).catch(() => {});
    }
    fixture.cleanup();
  }
});

test('route parser accepts the production text form without widening the declared route', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    fixture.controls.route.setDefault({
      stdout: [
        'route to: default',
        'gateway: 192.168.1.1',
        'interface: en0',
        '',
      ].join('\n'),
    });
    const dante = createDanteBridge(fixture, { name: 'text-route' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    session = startProxy(executable, fixture, makeRequest({
      network: networkRequest('public-destination'),
    }));
    const result = await session.firstLine;
    assert.equal(result.decision, 'ready');
    assert.equal(result.bindInterface, 'en0');
    await stopProxy(session);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
    }
    fixture.cleanup();
  }
});

test('cleanup terminates a Dante process group and its descendants', async () => {
  const fixture = createRemoteBuilderFixture();
  let session;
  try {
    const routeCase = getRouteFixture('declared-en0');
    fixture.controls.route.setDefault({ stdout: `${JSON.stringify(makeRouteResponse(routeCase))}\n` });
    const dante = createDanteBridge(fixture, { forkChild: true, name: 'descendant' });
    const executable = loadPolicyProxy(fixture, dante.executable);
    session = startProxy(executable, fixture, makeRequest({
      timeoutSeconds: 60,
      network: networkRequest('public-destination'),
    }));
    await session.firstLine;
    const danteState = JSON.parse(fs.readFileSync(dante.logPath, 'utf8'));
    assert.equal(processExists(danteState.pid), true);
    assert.equal(typeof danteState.childPid, 'number');
    assert.equal(processExists(danteState.childPid), true);

    session.child.kill('SIGTERM');
    await waitForClose(session.child);
    await waitForProcessGone(danteState.pid);
    await waitForProcessGone(danteState.childPid);
  } finally {
    if (session?.child.exitCode === null && session?.child.signalCode === null) {
      session.child.kill('SIGKILL');
    }
    fixture.cleanup();
  }
});
