'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createRemoteBuilderFixture,
  createTemporaryState,
  evalDisabledRoles,
  evalModuleFixture,
  installSignalCleanup,
  nixEvalJson,
  repoRoot,
  runExecutable,
  withRemoteBuilderFixture,
} = require('./helpers');

const disabledRoleModule = `{ lib, ... }: {
  options.services.shopifyRemoteBuilder = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = false;
    };
    role = lib.mkOption {
      type = lib.types.enum [ "personal" "shopify" ];
      default = "personal";
    };
  };
}`;

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForFile(filePath, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await delay(10);
  }
}

function waitForExit(child, timeout = 5_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('child did not exit')), timeout);
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

test('module fixture evaluates both disabled roles in isolated Nix state', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const rendered = evalDisabledRoles(disabledRoleModule, { fixture });

    assert.deepEqual(rendered, {
      personal: { enable: false, role: 'personal' },
      shopify: { enable: false, role: 'shopify' },
    });
    assert.equal(rendered.personal.enable, false);
    assert.equal(rendered.shopify.enable, false);
    assert.ok(rendered);
  } finally {
    fixture.cleanup();
  }
});

test('standalone module evaluation accepts an isolated inline module', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    const rendered = evalModuleFixture(`{ lib, ... }: {
      options.fixture.value = lib.mkOption {
        type = lib.types.str;
        default = "default";
      };
      config.fixture.value = "isolated";
    }`, 'config.fixture.value', { fixture });

    assert.equal(rendered, 'isolated');
  } finally {
    fixture.cleanup();
  }
});

test('Nix evaluation accepts an injected executable', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    fixture.controls.nix.setDefault({
      stdout: '{"fixture":"nix"}\n',
    });

    assert.deepEqual(nixEvalJson('ignored by fake nix', {
      fixture,
      nixExecutable: fixture.controls.nix.executable,
    }), { fixture: 'nix' });
    assert.deepEqual(fixture.controls.nix.calls()[0].args, [
      'eval',
      '--json',
      '--impure',
      '--expr',
      'ignored by fake nix',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('Nix evaluation ignores poisoned host configuration and state paths', () => {
  const poisonRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-remote-builder-poison-'));
  const poisonPaths = {
    home: path.join(poisonRoot, 'home'),
    nixCacheDir: path.join(poisonRoot, 'nix-cache'),
    nixConfigHome: path.join(poisonRoot, 'nix-config-home'),
    nixConfDir: path.join(poisonRoot, 'nix-conf'),
    nixLogDir: path.join(poisonRoot, 'nix-log'),
    nixStateDir: path.join(poisonRoot, 'nix-state'),
    userConfig: path.join(poisonRoot, 'nix-user.conf'),
    xdgCacheHome: path.join(poisonRoot, 'xdg-cache'),
    xdgConfigHome: path.join(poisonRoot, 'xdg-config'),
    xdgDataHome: path.join(poisonRoot, 'xdg-data'),
    xdgStateHome: path.join(poisonRoot, 'xdg-state'),
  };
  const poisonConfig = 'experimental-features = poisoned-feature\n';
  for (const directory of Object.values(poisonPaths).filter(value => !value.endsWith('.conf'))) {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'nix.conf'), poisonConfig);
  }
  fs.writeFileSync(poisonPaths.userConfig, poisonConfig);

  const helperPath = path.join(__dirname, 'helpers.js');
  const childSource = `
    const helpers = require(${JSON.stringify(helperPath)});
    const fixture = helpers.createRemoteBuilderFixture();
    try {
      fixture.controls.nix.setDefault({ stdout: '{}\\n' });
      helpers.nixEvalJson('ignored by fake nix', { fixture, nixExecutable: fixture.controls.nix.executable });
      process.stdout.write(JSON.stringify({
        environment: fixture.controls.nix.calls()[0].env,
        root: fixture.root,
      }));
    } finally {
      fixture.cleanup();
    }
  `;

  try {
    const result = childProcess.spawnSync(process.execPath, ['-e', childSource], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: poisonPaths.home,
        NIX_CACHE_DIR: poisonPaths.nixCacheDir,
        NIX_CONFIG: poisonConfig,
        NIX_CONFIG_HOME: poisonPaths.nixConfigHome,
        NIX_CONF_DIR: poisonPaths.nixConfDir,
        NIX_LOG_DIR: poisonPaths.nixLogDir,
        NIX_STATE_DIR: poisonPaths.nixStateDir,
        NIX_USER_CONF_FILES: poisonPaths.userConfig,
        XDG_CACHE_HOME: poisonPaths.xdgCacheHome,
        XDG_CONFIG_HOME: poisonPaths.xdgConfigHome,
        XDG_DATA_HOME: poisonPaths.xdgDataHome,
        XDG_STATE_HOME: poisonPaths.xdgStateHome,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    assert.equal(result.status, 0, result.stderr);
    const captured = JSON.parse(result.stdout);
    const fixturePaths = [
      'HOME',
      'NIX_CACHE_DIR',
      'NIX_CONFIG_HOME',
      'NIX_CONF_DIR',
      'NIX_LOG_DIR',
      'NIX_STATE_DIR',
      'XDG_CACHE_HOME',
      'XDG_CONFIG_HOME',
      'XDG_DATA_HOME',
      'XDG_STATE_HOME',
    ];
    for (const name of fixturePaths) {
      assert.ok(captured.environment[name], `${name} must be set`);
      assert.equal(captured.environment[name].startsWith(captured.root), true, name);
      assert.equal(captured.environment[name].includes(poisonRoot), false, name);
    }
    assert.equal(captured.environment.NIX_USER_CONF_FILES, '/dev/null');
    assert.equal(captured.environment.NIX_CONFIG, 'experimental-features = nix-command flakes');
    assert.equal(captured.environment.NIX_PATH, undefined);
    assert.equal(captured.environment.NIX_REMOTE, undefined);
    const capturedPath = captured.environment.PATH.split(path.delimiter);
    assert.equal(capturedPath[0], path.join(captured.root, 'bin'));
    for (const entry of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
      assert.ok(capturedPath.includes(entry), `PATH lost executable entry: ${entry}`);
    }
  } finally {
    fs.rmSync(poisonRoot, { force: true, recursive: true });
  }
});

test('fixture controls inject fake Nix, SSH, cache, proxy, and route executables', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    for (const name of ['nix', 'ssh', 'cache', 'proxy', 'route']) {
      const control = fixture.controls[name];
      control.setDefault({ stdout: `${name}:ok\n` });
      const result = runExecutable(control.executable, ['probe', name], { fixture });

      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(result.stdout, `${name}:ok\n`);
      assert.equal(result.signal, null);
      assert.deepEqual(control.calls()[0].args, ['probe', name]);
      assert.equal(control.calls()[0].env.HOME, fixture.paths.home);
      assert.equal(control.calls()[0].env.TMPDIR, fixture.paths.tmp);
    }
  } finally {
    fixture.cleanup();
  }
});

test('temporary state rejects escapes and cleanup is idempotent', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'shopify-remote-builder-parent-'));
  assert.throws(
    () => createTemporaryState({ parent, statePaths: { escaped: '../outside' } }),
    /inside the fixture/,
  );
  assert.deepEqual(fs.readdirSync(parent), []);
  fs.rmSync(parent, { force: true, recursive: true });

  const state = createTemporaryState();
  assert.ok(state.root.startsWith(os.tmpdir()));
  assert.equal(path.relative(state.root, state.paths.state).startsWith('..'), false);
  state.cleanup();
  state.cleanup();
  assert.equal(fs.existsSync(state.root), false);
});

test('fixture cleanup removes processes and directories on success and error', async () => {
  let successRoot;
  let successPid;
  await withRemoteBuilderFixture(async fixture => {
    successRoot = fixture.root;
    const child = fixture.controls.process.spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000);',
    ]);
    successPid = child.pid;
    await delay(25);
    assert.equal(processExists(successPid), true);
  });
  assert.equal(fs.existsSync(successRoot), false);
  await delay(25);
  assert.equal(processExists(successPid), false);

  let errorRoot;
  let errorPid;
  await assert.rejects(
    withRemoteBuilderFixture(async fixture => {
      errorRoot = fixture.root;
      const child = fixture.controls.process.spawn(process.execPath, [
        '-e',
        'setInterval(() => {}, 1000);',
      ]);
      errorPid = child.pid;
      await delay(25);
      throw new Error('fixture callback failed');
    }),
    /fixture callback failed/,
  );
  assert.equal(fs.existsSync(errorRoot), false);
  await delay(25);
  assert.equal(processExists(errorPid), false);
});

test('signal cleanup removes child processes and temporary state without signaling the test runner', async () => {
  const infoPath = path.join(
    os.tmpdir(),
    `shopify-remote-builder-signal-${process.pid}-${Date.now()}.json`,
  );
  const helperPath = path.join(__dirname, 'helpers.js');
  const childSource = `
    'use strict';
    const childProcess = require('node:child_process');
    const fs = require('node:fs');
    const helpers = require(${JSON.stringify(helperPath)});
    const fixture = helpers.createRemoteBuilderFixture();
    helpers.installSignalCleanup(fixture, { signals: ['SIGTERM'], rethrow: true });
    const child = fixture.controls.process.spawn(process.execPath, [
      '-e',
      'setInterval(() => {}, 1000);',
    ]);
    fs.writeFileSync(${JSON.stringify(infoPath)}, JSON.stringify({
      childPid: child.pid,
      root: fixture.root,
    }));
    setInterval(() => {}, 1000);
  `;
  const child = childProcess.spawn(process.execPath, ['-e', childSource], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });

  try {
    await waitForFile(infoPath);
    const info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
    assert.equal(processExists(info.childPid), true);
    assert.equal(child.kill('SIGTERM'), true);
    const exit = await waitForExit(child);

    assert.equal(exit.signal, 'SIGTERM', stderr);
    assert.equal(fs.existsSync(info.root), false);
    await delay(25);
    assert.equal(processExists(info.childPid), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
    fs.rmSync(infoPath, { force: true });
  }
});

test('fixture paths are rooted under a disposable directory', () => {
  const fixture = createRemoteBuilderFixture();
  try {
    for (const fixturePath of Object.values(fixture.paths)) {
      assert.equal(
        path.relative(fixture.root, fixturePath).startsWith('..'),
        false,
        fixturePath,
      );
    }
    assert.equal(repoRoot, path.resolve(__dirname, '../..'));
  } finally {
    fixture.cleanup();
  }
});
