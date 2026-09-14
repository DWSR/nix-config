'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  nixEvalJson,
  repoRoot,
  runExecutable,
} = require('./helpers');
const {
  getCommandFixture,
  getTrustFixture,
} = require('./fixtures');

const DISPATCHER_PATH = path.join(repoRoot, 'scripts/shopify-remote-builder-dispatch.nix');
const TRUST_FIXTURE = getTrustFixture('valid');
const CLIENT_PUBLIC_KEY = TRUST_FIXTURE.client.publicKey;
const SOURCE_ADDRESS = '192.168.1.42';
const SSH_CONNECTION = `${SOURCE_ADDRESS} 54321 192.168.1.99 22`;
const LEASE_TOKEN = `srb1-fixture-lease-0001-${'a'.repeat(64)}`;
const MAX_NONCE = 'n'.repeat(128);
const MAX_LEASE_TOKEN = `srb1-${MAX_NONCE}-${'c'.repeat(64)}`;
const SECRET_PATH = '/var/db/shopify-remote-builder/requests/fixture-secret';

function nixString(value) {
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function readOnlyNixExecutable(fixture) {
  return fixture.createExecutable('nix-dispatcher-read-only', `
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

function createRecordingExecutable(fixture, name) {
  const logPath = path.join(fixture.paths.logs, `${name}.jsonl`);
  fs.writeFileSync(logPath, '', { mode: 0o600 });
  const executable = fixture.createExecutable(name, `
    const fs = require('node:fs');
    const logPath = ${JSON.stringify(logPath)};
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { input += chunk; });
    process.stdin.on('end', () => {
      fs.appendFileSync(logPath, JSON.stringify({
        args: process.argv.slice(2),
        env: process.env,
        input,
      }) + '\\n');
      process.stdout.write(${JSON.stringify(`${name}-ok\n`)});
    });
  `);
  return {
    calls() {
      return fs.readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    executable,
  };
}

function loadDispatcher(fixture, options = {}) {
  const validator = options.validator ?? createRecordingExecutable(fixture, 'dispatcher-validator');
  const lease = options.lease ?? createRecordingExecutable(fixture, 'dispatcher-lease');
  const daemon = options.daemon ?? createRecordingExecutable(fixture, 'dispatcher-daemon');
  const packageArguments = [
    `validatorExecutable = ${nixString(validator.executable)};`,
    `leaseManagerExecutable = ${nixString(lease.executable)};`,
    `nixDaemonExecutable = ${nixString(daemon.executable)};`,
    'allowedSourceCidrs = [ "192.168.1.0/24" ];',
    `expectedSourceAddress = ${options.expectedSourceAddress === null
      ? 'null'
      : nixString(options.expectedSourceAddress ?? SOURCE_ADDRESS)};`,
    `expectedSshKey = ${options.expectedSshKey === null
      ? 'null'
      : nixString(options.expectedSshKey ?? CLIENT_PUBLIC_KEY)};`,
  ];
  for (const [name, value] of Object.entries(options.variableNames ?? {})) {
    packageArguments.push(`${name} = ${nixString(value)};`);
  }

  const expression = `
    let
      flake = builtins.getFlake (toString ${nixString(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      (pkgs.callPackage ${nixString(DISPATCHER_PATH)} {
        ${packageArguments.join('\n        ')}
      }).text
  `;
  const source = nixEvalJson(expression, {
    fixture,
    nixExecutable: readOnlyNixExecutable(fixture),
  });
  const executable = path.join(fixture.paths.bin, 'shopify-remote-builder-dispatch');
  fs.writeFileSync(executable, source, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return {
    daemon,
    executable,
    lease,
    source,
    validator,
  };
}

function acceptedEnvironment(command, overrides = {}) {
  return {
    LANG: undefined,
    LC_ALL: undefined,
    SSH_CONNECTION,
    SSH_ORIGINAL_COMMAND: command,
    SSH_USER_AUTH: CLIENT_PUBLIC_KEY,
    ...overrides,
  };
}

function runDispatcher(dispatcher, fixture, command, options = {}) {
  return runExecutable(dispatcher.executable, options.args ?? [], {
    fixture,
    env: acceptedEnvironment(command, options.env),
    input: options.input,
  });
}

function assertRejected(result, forbiddenValues = [], label = '') {
  assert.notEqual(result.status, 0, label || result.stdout);
  assert.ok(result.stderr.length > 0);
  assert.ok(result.stderr.length <= 1024, label || result.stderr);
  for (const value of forbiddenValues) {
    assert.doesNotMatch(result.stderr, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
}

test('dispatcher accepts validate and forwards the exact request channel', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    const input = `{"schemaVersion":1,"secret":"${SECRET_PATH}"}\n`;
    const result = runDispatcher(dispatcher, fixture, 'validate', { input });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'dispatcher-validator-ok\n');
    assert.deepEqual(dispatcher.validator.calls().map(call => call.args), [[]]);
    assert.equal(dispatcher.validator.calls()[0].input, input);
    assert.equal(dispatcher.validator.calls()[0].env.SSH_CONNECTION, undefined);
    assert.equal(dispatcher.validator.calls()[0].env.SSH_ORIGINAL_COMMAND, undefined);
    assert.equal(dispatcher.validator.calls()[0].env.SSH_USER_AUTH, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher routes every lease operation with only its validated token', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    for (const operation of ['ready', 'keepalive', 'prepare', 'release']) {
      const result = runDispatcher(dispatcher, fixture, `${operation} ${LEASE_TOKEN}`);
      assert.equal(result.status, 0, `${operation}: ${result.stderr}`);
    }

    assert.deepEqual(
      dispatcher.lease.calls().map(call => call.args),
      [
        ['ready', LEASE_TOKEN],
        ['keepalive', LEASE_TOKEN],
        ['prepare', LEASE_TOKEN],
        ['release', LEASE_TOKEN],
      ],
    );
    for (const call of dispatcher.lease.calls()) {
      assert.equal(call.env.SSH_CONNECTION, undefined);
      assert.equal(call.env.SSH_ORIGINAL_COMMAND, undefined);
      assert.equal(call.env.SSH_USER_AUTH, undefined);
    }
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher accepts the maximum validator-issued lease token and forwards exact argv', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    assert.equal(MAX_NONCE.length, 128);
    assert.equal(MAX_LEASE_TOKEN.length, 198);

    const result = runDispatcher(dispatcher, fixture, `prepare ${MAX_LEASE_TOKEN}`);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'dispatcher-lease-ok\n');
    assert.deepEqual(dispatcher.lease.calls().map(call => call.args), [
      ['prepare', MAX_LEASE_TOKEN],
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher accepts only the exact direct nix-daemon stdio argv', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    const input = 'fixture-worker-protocol-bytes\n';
    const stdioCommand = getCommandFixture('forced-stdio').argv.join(' ');
    const result = runDispatcher(dispatcher, fixture, stdioCommand, { input });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'dispatcher-daemon-ok\n');
    assert.deepEqual(dispatcher.daemon.calls().map(call => call.args), [getCommandFixture('forced-stdio').argv.slice(1)]);
    assert.equal(dispatcher.daemon.calls()[0].input, input);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher rejects unknown, malformed, shell, extra-argument, and wrong-path commands', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    const rejectedCommands = [
      getCommandFixture('unknown-command').argv.join(' '),
      getCommandFixture('malformed-command').argv.join(' '),
      `prepare ${LEASE_TOKEN}; touch ${SECRET_PATH}`,
      `prepare ${LEASE_TOKEN} extra`,
      '/usr/bin/nix-daemon --stdio --store daemon',
      'validate extra',
      `cleanup ${LEASE_TOKEN}`,
    ];

    for (const command of rejectedCommands) {
      const result = runDispatcher(dispatcher, fixture, command, {
        env: { SSH_OPTIONS: 'fixture-option-override' },
      });
      assertRejected(result, [command, LEASE_TOKEN, SECRET_PATH]);
    }

    assert.equal(dispatcher.validator.calls().length, 0);
    assert.equal(dispatcher.lease.calls().length, 0);
    assert.equal(dispatcher.daemon.calls().length, 0);
    assert.equal(fs.existsSync(path.join(fixture.paths.data, 'owned')), false);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher rejects argv overrides and invalid lease tokens before forwarding', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    const cases = [
      { command: 'validate', args: ['--request', SECRET_PATH] },
      { command: `prepare ${'fixture-secret-token'}`, args: [] },
      { command: `prepare srb1-../- ${'b'.repeat(64)}`, args: [] },
      { command: `prepare srb1-${'n'.repeat(129)}-${'c'.repeat(64)}`, args: [] },
      { command: `release ${LEASE_TOKEN} ${SECRET_PATH}`, args: [] },
    ];

    for (const request of cases) {
      const result = runDispatcher(dispatcher, fixture, request.command, {
        args: request.args,
      });
      assertRejected(result, [request.command, SECRET_PATH, 'fixture-secret-token']);
    }

    assert.equal(dispatcher.validator.calls().length, 0);
    assert.equal(dispatcher.lease.calls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher binds source CIDR, exact address, SSH connection, and expected key context', () => {
  const cases = [
    {
      name: 'outside declared source CIDR',
      env: { SSH_CONNECTION: '10.42.0.7 54321 192.168.1.99 22' },
      options: { expectedSourceAddress: null },
    },
    {
      name: 'wrong declared source address',
      env: { SSH_CONNECTION: '192.168.1.43 54321 192.168.1.99 22' },
    },
    {
      name: 'missing SSH connection',
      env: { SSH_CONNECTION: undefined },
    },
    {
      name: 'malformed SSH connection',
      env: { SSH_CONNECTION: '192.168.1.42 54321 192.168.1.99' },
    },
    {
      name: 'missing expected key',
      env: { SSH_USER_AUTH: undefined },
    },
    {
      name: 'wrong expected key',
      env: { SSH_USER_AUTH: TRUST_FIXTURE.host.publicKey },
    },
    {
      name: 'malformed expected key',
      env: { SSH_USER_AUTH: 'ssh-ed25519 malformed' },
    },
    {
      name: 'missing original command',
      env: { SSH_ORIGINAL_COMMAND: undefined },
    },
  ];

  for (const testCase of cases) {
    const fixture = createRemoteBuilderFixture();
    try {
      const dispatcher = loadDispatcher(fixture, testCase.options);
      const result = runDispatcher(dispatcher, fixture, 'validate', { env: testCase.env });
      assertRejected(result, [CLIENT_PUBLIC_KEY, TRUST_FIXTURE.host.publicKey, SECRET_PATH]);
      assert.equal(dispatcher.validator.calls().length, 0, testCase.name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('dispatcher rejects PTY, forwarding, and environment override indicators', () => {
  const poisonedEnvironments = [
    { SSH_TTY: '/dev/ttys001' },
    { SSH_AUTH_SOCK: '/tmp/fixture-agent.sock' },
    { DISPLAY: 'fixture-display:0' },
    { SSH_X11_COOKIE: 'fixture-cookie' },
    { TERM: 'xterm-256color' },
    { LC_CTYPE: 'fixture-locale' },
    { NIX_CONFIG: 'builders = ssh://fixture' },
    { NIX_USER_CONF_FILES: SECRET_PATH },
    { HTTP_PROXY: 'http://fixture-proxy.invalid' },
    { SSH_OPTIONS: 'SendEnv=fixture' },
    { FIXTURE_FORWARDED_ENV: 'fixture-value' },
  ];

  for (const env of poisonedEnvironments) {
    const fixture = createRemoteBuilderFixture();
    try {
      const dispatcher = loadDispatcher(fixture);
      const result = runDispatcher(dispatcher, fixture, 'validate', { env });
      assertRejected(result, [SECRET_PATH, Object.values(env)[0]], Object.keys(env)[0]);
      assert.equal(dispatcher.validator.calls().length, 0, Object.keys(env)[0]);
    } finally {
      fixture.cleanup();
    }
  }
});

test('dispatcher supports injected context variable names without forwarding them', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture, {
      variableNames: {
        sourceAddressEnvironmentVariable: 'FIXTURE_CONNECTION',
        sshKeyEnvironmentVariable: 'FIXTURE_KEY',
        originalCommandEnvironmentVariable: 'FIXTURE_COMMAND',
      },
    });
    const result = runExecutable(dispatcher.executable, [], {
      fixture,
      env: {
        FIXTURE_CONNECTION: SSH_CONNECTION,
        FIXTURE_KEY: CLIENT_PUBLIC_KEY,
        FIXTURE_COMMAND: 'validate',
        LANG: undefined,
        LC_ALL: undefined,
      },
      input: 'fixture-request\n',
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(dispatcher.validator.calls().length, 1);
    assert.equal(dispatcher.validator.calls()[0].env.FIXTURE_CONNECTION, undefined);
    assert.equal(dispatcher.validator.calls()[0].env.FIXTURE_KEY, undefined);
    assert.equal(dispatcher.validator.calls()[0].env.FIXTURE_COMMAND, undefined);
  } finally {
    fixture.cleanup();
  }
});

test('dispatcher source contains no shell-evaluation seam and exposes fixed command argv', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const dispatcher = loadDispatcher(fixture);
    assert.doesNotMatch(dispatcher.source, /\beval\b/);
    assert.doesNotMatch(dispatcher.source, /\bsh\s+-c\b/);
    assert.match(dispatcher.source, /nix-daemon/);
    assert.match(dispatcher.source, /--stdio/);
    assert.match(dispatcher.source, /--store/);
    assert.match(dispatcher.source, /daemon/);
  } finally {
    fixture.cleanup();
  }
});
