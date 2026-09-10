'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_EVAL_TIMEOUT_MS = 120_000;
const NIX_EVAL_MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_SIGNAL_NAMES = ['SIGHUP', 'SIGINT', 'SIGTERM'];
const FAKE_COMMAND_NAMES = ['nix', 'ssh', 'cache', 'proxy', 'route'];

function assertExecutableName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`invalid fixture executable name: ${name}`);
  }
}

function fixturePath(root, name, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath === ''
    || path.isAbsolute(relativePath)
    || relativePath.split(/[\\/]/).includes('..')
  ) {
    throw new Error(`${name} must be a relative path inside the fixture`);
  }

  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`${name} escapes the fixture`);
  }
  return resolved;
}

function assertNixPath(filePath, name = 'Nix path') {
  if (!path.isAbsolute(filePath) || /[\s'"\\$]/.test(filePath)) {
    throw new Error(`unsupported ${name}: ${filePath}`);
  }
  return filePath;
}

function nixString(value, name = 'Nix string') {
  if (typeof value !== 'string') {
    throw new Error(`${name} must be a string`);
  }
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function createTemporaryState(options = {}) {
  const parent = path.resolve(options.parent ?? os.tmpdir());
  const prefix = options.prefix ?? 'shopify-remote-builder-';
  if (typeof prefix !== 'string' || prefix === '' || !/^[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new Error(`invalid temporary-state prefix: ${prefix}`);
  }
  if (!fs.statSync(parent).isDirectory()) {
    throw new Error(`temporary-state parent is not a directory: ${parent}`);
  }

  const root = fs.mkdtempSync(path.join(parent, prefix));
  try {
    const paths = Object.fromEntries([
      ['home', 'home'],
      ['bin', 'bin'],
      ['tmp', 'tmp'],
      ['state', 'state'],
      ['config', 'config'],
      ['cache', 'cache'],
      ['nixConfDir', 'nix-conf'],
      ['nixConfigHome', 'nix-config-home'],
      ['nixStateDir', 'nix-state'],
      ['nixLogDir', 'nix-log'],
      ['nixCacheDir', 'nix-cache'],
      ['data', 'data'],
      ['control', 'control'],
      ['logs', 'logs'],
    ].map(([name, relativePath]) => {
      const resolved = fixturePath(root, `${name} directory`, relativePath);
      fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
      return [name, resolved];
    }));
    const statePaths = Object.fromEntries(Object.entries(options.statePaths ?? {}).map(
      ([name, relativePath]) => {
        const resolved = fixturePath(root, `state path ${name}`, relativePath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
        return [name, resolved];
      },
    ));

    let cleaned = false;
    return {
      cleanup() {
        if (cleaned) {
          return;
        }
        cleaned = true;
        fs.rmSync(root, { force: true, recursive: true });
      },
      paths: { root, ...paths },
      root,
      statePaths,
    };
  } catch (error) {
    fs.rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

function fixtureEnvironment(fixture, overrides = {}) {
  return {
    HOME: fixture.paths.home,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: fixture.paths.bin,
    TMPDIR: fixture.paths.tmp,
    XDG_CACHE_HOME: fixture.paths.cache,
    XDG_CONFIG_HOME: fixture.paths.config,
    XDG_DATA_HOME: fixture.paths.data,
    XDG_STATE_HOME: fixture.paths.state,
    ...overrides,
  };
}

function fixtureCwd(fixture, cwd) {
  const resolved = path.resolve(fixture.root, cwd ?? '.');
  const relative = path.relative(fixture.root, resolved);
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error(`fixture working directory escapes the fixture: ${cwd}`);
  }
  return resolved;
}

function nixEnvironment(options = {}) {
  if (!options.fixture) {
    throw new Error('nixEnvironment requires an isolated fixture');
  }

  const fixture = options.fixture;
  const overrides = options.env ?? {};
  const pathValue = [fixture.paths.bin, overrides.PATH ?? process.env.PATH ?? '']
    .filter(Boolean)
    .join(path.delimiter);
  return {
    ...fixtureEnvironment(fixture, {
      PATH: pathValue,
    }),
    ...overrides,
    HOME: fixture.paths.home,
    LANG: 'C',
    LC_ALL: 'C',
    PATH: pathValue,
    TMPDIR: fixture.paths.tmp,
    XDG_CACHE_HOME: fixture.paths.cache,
    XDG_CONFIG_HOME: fixture.paths.config,
    XDG_DATA_HOME: fixture.paths.data,
    XDG_STATE_HOME: fixture.paths.state,
    NIX_CACHE_DIR: fixture.paths.nixCacheDir,
    NIX_CONFIG: 'experimental-features = nix-command flakes',
    NIX_CONFIG_HOME: fixture.paths.nixConfigHome,
    NIX_CONF_DIR: fixture.paths.nixConfDir,
    NIX_LOG_DIR: fixture.paths.nixLogDir,
    NIX_STATE_DIR: fixture.paths.nixStateDir,
    NIX_USER_CONF_FILES: '/dev/null',
  };
}

function nixEvalJson(expr, options = {}) {
  const ownsFixture = options.fixture === undefined;
  const fixture = options.fixture ?? createTemporaryState({
    prefix: 'shopify-remote-builder-nix-',
  });
  try {
    const output = childProcess.execFileSync(
      options.nixExecutable ?? 'nix',
      ['eval', '--json', '--impure', '--expr', expr],
      {
        cwd: options.cwd ?? repoRoot,
        encoding: 'utf8',
        env: nixEnvironment({ ...options, fixture }),
        maxBuffer: options.maxBuffer ?? NIX_EVAL_MAX_BUFFER,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: options.timeout ?? NIX_EVAL_TIMEOUT_MS,
      },
    );
    return JSON.parse(output);
  } finally {
    if (ownsFixture) {
      fixture.cleanup();
    }
  }
}

function nixEvalFailure(expr, options = {}) {
  try {
    nixEvalJson(expr, options);
  } catch (error) {
    return String(error.stderr ?? error.message);
  }
  throw new Error('expected nix eval to fail, but it succeeded');
}

function moduleEntries(moduleSource, options = {}) {
  const paths = options.modulePaths ?? (options.modulePath ? [options.modulePath] : []);
  if (!Array.isArray(paths)) {
    throw new Error('modulePaths must be an array');
  }
  const entries = paths.map((modulePath, index) => {
    if (typeof modulePath !== 'string') {
      throw new Error(`module path ${index} must be a string`);
    }
    return `import ${assertNixPath(modulePath, `module path ${index}`)}`;
  });
  const sources = Array.isArray(moduleSource) ? moduleSource : [moduleSource];
  for (const [index, source] of sources.entries()) {
    if (source === undefined || source === null) {
      continue;
    }
    if (typeof source !== 'string' || source.trim() === '') {
      throw new Error(`moduleSource ${index} must be a non-empty Nix expression`);
    }
    entries.push(`(${source})`);
  }
  return entries;
}

function darwinFixtureExpr(moduleSource, resultSource, options = {}) {
  if (typeof resultSource !== 'string' || resultSource.trim() === '') {
    throw new Error('resultSource must be a non-empty Nix expression');
  }
  const modules = [
    ...moduleEntries(moduleSource, options),
    '({ ... }: { nixpkgs.hostPlatform = builtins.currentSystem; })',
  ];
  return `
    let
      flake = builtins.getFlake (toString ${assertNixPath(repoRoot, 'repository path')});
      fixture = flake.inputs.darwin.lib.darwinSystem {
        modules = [
          ${modules.join('\n          ')}
        ];
      };
      config = fixture.config;
    in
      ${resultSource}
  `;
}

function evalDarwinFixture(moduleSource, resultSource, options = {}) {
  return nixEvalJson(darwinFixtureExpr(moduleSource, resultSource, options), options);
}

function moduleFixtureExpr(moduleSource, resultSource, options = {}) {
  if (typeof resultSource !== 'string' || resultSource.trim() === '') {
    throw new Error('resultSource must be a non-empty Nix expression');
  }
  const modules = moduleEntries(moduleSource, options);
  return `
    let
      flake = builtins.getFlake (toString ${assertNixPath(repoRoot, 'repository path')});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      fixture = flake.inputs.nixpkgs.lib.evalModules {
        modules = [
          ${modules.join('\n          ')}
        ];
        specialArgs = { inherit pkgs; };
      };
      config = fixture.config;
    in
      ${resultSource}
  `;
}

function evalModuleFixture(moduleSource, resultSource, options = {}) {
  return nixEvalJson(moduleFixtureExpr(moduleSource, resultSource, options), options);
}

function evalDisabledRoles(moduleSource, options = {}) {
  const roles = options.roles ?? ['personal', 'shopify'];
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new Error('roles must be a non-empty array');
  }

  return Object.fromEntries(roles.map(role => {
    if (typeof role !== 'string' || role === '') {
      throw new Error(`invalid disabled role: ${role}`);
    }
    const roleModule = `({ ... }: {
      services.shopifyRemoteBuilder = {
        enable = false;
        role = ${nixString(role, 'role')};
      };
    })`;
    const result = evalDarwinFixture(
      [moduleSource, roleModule],
      `{
        enable = config.services.shopifyRemoteBuilder.enable;
        role = config.services.shopifyRemoteBuilder.role;
      }`,
      options,
    );
    return [role, result];
  }));
}

function createExecutable(fixture, name, source, options = {}) {
  assertExecutableName(name);
  if (!fixture?.paths?.bin) {
    throw new Error('createExecutable requires a temporary fixture');
  }
  if (typeof source !== 'string') {
    throw new Error('fixture executable source must be a string');
  }

  const executable = path.join(fixture.paths.bin, name);
  const interpreter = options.interpreter;
  const contents = interpreter === undefined
    ? `#!${process.execPath}\n'use strict';\n${source}\n`
    : `#!${interpreter}\n${source}\n`;
  fs.writeFileSync(executable, contents, { mode: 0o700 });
  fs.chmodSync(executable, 0o700);
  return executable;
}

function runExecutable(executable, args = [], options = {}) {
  if (!options.fixture) {
    throw new Error('runExecutable requires an isolated fixture');
  }
  if (!Array.isArray(args)) {
    throw new Error('executable arguments must be an array');
  }

  const result = childProcess.spawnSync(executable, args, {
    cwd: fixtureCwd(options.fixture, options.cwd),
    encoding: 'utf8',
    env: fixtureEnvironment(options.fixture, options.env),
    input: options.input,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    signal: result.signal,
    status: result.status,
    stderr: String(result.stderr ?? ''),
    stdout: String(result.stdout ?? ''),
  };
}

function normalizeResponse(response = {}) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) {
    throw new Error('fake command response must be an object');
  }
  const status = response.status ?? 0;
  if (!Number.isInteger(status) || status < 0 || status > 255) {
    throw new Error(`fake command status must be an integer from 0 through 255: ${status}`);
  }
  if (response.signal !== undefined && typeof response.signal !== 'string') {
    throw new Error('fake command signal must be a signal name');
  }
  return {
    signal: response.signal,
    status,
    stderr: response.stderr ?? '',
    stdout: response.stdout ?? '',
  };
}

function createFakeCommand(fixture, name, options = {}) {
  assertExecutableName(name);
  const controlPath = path.join(fixture.paths.control, `${name}.json`);
  const callsPath = path.join(fixture.paths.logs, `${name}.jsonl`);
  const initialState = {
    defaultResponse: normalizeResponse(options.defaultResponse),
    queue: (options.responses ?? []).map(normalizeResponse),
  };
  fs.writeFileSync(controlPath, `${JSON.stringify(initialState)}\n`, { mode: 0o600 });
  fs.writeFileSync(callsPath, '', { mode: 0o600 });

  const source = [
    "const fs = require('node:fs');",
    `const callsPath = ${JSON.stringify(callsPath)};`,
    `const controlPath = ${JSON.stringify(controlPath)};`,
    'const state = JSON.parse(fs.readFileSync(controlPath, "utf8"));',
    'const call = { args: process.argv.slice(2), cwd: process.cwd(), env: process.env };',
    'fs.appendFileSync(callsPath, `${JSON.stringify(call)}\\n`);',
    'const response = state.queue.length > 0 ? state.queue.shift() : state.defaultResponse;',
    'fs.writeFileSync(controlPath, `${JSON.stringify(state)}\\n`);',
    'if (response.stdout) process.stdout.write(String(response.stdout));',
    'if (response.stderr) process.stderr.write(String(response.stderr));',
    'if (response.signal) process.kill(process.pid, response.signal);',
    'process.exit(response.status);',
  ].join('\n');
  const executable = createExecutable(fixture, `fake-${name}`, source);

  return {
    calls() {
      if (!fs.existsSync(callsPath)) {
        return [];
      }
      return fs.readFileSync(callsPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line));
    },
    clearCalls() {
      fs.writeFileSync(callsPath, '', { mode: 0o600 });
    },
    controlPath,
    enqueue(...responses) {
      const state = readFakeState(controlPath);
      state.queue.push(...responses.map(normalizeResponse));
      writeFakeState(controlPath, state);
    },
    executable,
    setDefault(response) {
      const state = readFakeState(controlPath);
      state.defaultResponse = normalizeResponse(response);
      writeFakeState(controlPath, state);
    },
  };
}

function readFakeState(controlPath) {
  return JSON.parse(fs.readFileSync(controlPath, 'utf8'));
}

function writeFakeState(controlPath, state) {
  fs.writeFileSync(controlPath, `${JSON.stringify(state)}\n`, { mode: 0o600 });
}

function createFakeNix(fixture, options = {}) {
  return createFakeCommand(fixture, 'nix', options);
}

function createFakeSsh(fixture, options = {}) {
  return createFakeCommand(fixture, 'ssh', options);
}

function createFakeCache(fixture, options = {}) {
  return createFakeCommand(fixture, 'cache', options);
}

function createFakeProxy(fixture, options = {}) {
  return createFakeCommand(fixture, 'proxy', options);
}

function createFakeRoute(fixture, options = {}) {
  return createFakeCommand(fixture, 'route', options);
}

function createProcessControl(fixture) {
  const processes = new Map();
  const invocations = [];

  function forget(pid) {
    processes.delete(pid);
  }

  function track(childOrPid, options = {}) {
    const child = childOrPid;
    const pid = child?.pid;
    if (!Number.isInteger(pid) || pid <= 0) {
      throw new Error(`process control can only track a spawned child: ${pid}`);
    }
    processes.set(pid, { child, group: options.group ?? true });
    if (child) {
      child.once('exit', () => forget(pid));
      child.once('error', () => forget(pid));
    }
    return childOrPid;
  }

  function spawn(command, args = [], options = {}) {
    if (!Array.isArray(args)) {
      throw new Error('process arguments must be an array');
    }
    const {
      cwd: requestedCwd,
      detached = true,
      env,
      stdio = 'ignore',
      ...spawnOptions
    } = options;
    const resolvedCwd = fixtureCwd(fixture, requestedCwd);
    const isolatedEnv = fixtureEnvironment(fixture, env);
    invocations.push({
      args: [...args],
      command,
      cwd: resolvedCwd,
      detached,
      env: { ...isolatedEnv },
    });
    const child = childProcess.spawn(command, args, {
      ...spawnOptions,
      cwd: resolvedCwd,
      detached,
      env: isolatedEnv,
      stdio,
    });
    return track(child, { group: detached });
  }

  function isAlive(pid) {
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

  function activePids() {
    for (const pid of processes.keys()) {
      if (!isAlive(pid)) {
        processes.delete(pid);
      }
    }
    return [...processes.keys()].sort((left, right) => left - right);
  }

  function killAll(signal = 'SIGKILL') {
    for (const [pid, record] of processes) {
      if (record.group) {
        try {
          process.kill(-pid, signal);
        } catch (error) {
          if (error.code !== 'ESRCH') {
            throw error;
          }
        }
      }
      try {
        if (record.child) {
          record.child.kill(signal);
        } else {
          process.kill(pid, signal);
        }
      } catch (error) {
        if (error.code !== 'ESRCH') {
          throw error;
        }
      }
    }
  }

  return {
    activePids,
    calls() {
      return invocations.map(invocation => ({
        ...invocation,
        args: [...invocation.args],
        env: { ...invocation.env },
      }));
    },
    clearCalls() {
      invocations.splice(0);
    },
    isAlive,
    killAll,
    spawn,
    track,
  };
}

function createRemoteBuilderFixture(options = {}) {
  const state = createTemporaryState({
    parent: options.parent,
    prefix: options.prefix,
    statePaths: options.statePaths,
  });
  const fixture = {
    ...state,
    environment(overrides = {}) {
      return fixtureEnvironment(fixture, overrides);
    },
  };
  const cleanupCallbacks = [];
  let cleaned = false;

  fixture.registerCleanup = callback => {
    if (typeof callback !== 'function') {
      throw new Error('cleanup callback must be a function');
    }
    if (cleaned) {
      callback();
    } else {
      cleanupCallbacks.push(callback);
    }
    return callback;
  };
  fixture.createExecutable = (name, source, executableOptions = {}) => (
    createExecutable(fixture, name, source, executableOptions)
  );
  fixture.runExecutable = (executable, args = [], executableOptions = {}) => (
    runExecutable(executable, args, { fixture, ...executableOptions })
  );

  try {
    const processControl = createProcessControl(fixture);
    const controlOptions = options.controls ?? {};
    fixture.controls = {
      ...createDefaultControls(fixture, controlOptions),
      process: processControl,
    };
    fixture.processControl = processControl;
    fixture.executables = Object.fromEntries(Object.entries(options.executables ?? {}).map(
      ([name, executableOptions]) => [
        name,
        fixture.createExecutable(name, executableOptions.source ?? '', executableOptions),
      ],
    ));
    fixture.cleanup = () => {
      if (cleaned) {
        return;
      }
      cleaned = true;
      let cleanupError;
      try {
        processControl.killAll();
      } catch (error) {
        cleanupError = error;
      }
      for (const callback of cleanupCallbacks.splice(0).reverse()) {
        try {
          callback();
        } catch (error) {
          cleanupError ??= error;
        }
      }
      try {
        state.cleanup();
      } catch (error) {
        cleanupError ??= error;
      }
      if (cleanupError) {
        throw cleanupError;
      }
    };
    return fixture;
  } catch (error) {
    state.cleanup();
    throw error;
  }
}

function installSignalCleanup(fixture, options = {}) {
  if (!fixture || typeof fixture.cleanup !== 'function') {
    throw new Error('installSignalCleanup requires a fixture');
  }
  const signals = options.signals ?? DEFAULT_SIGNAL_NAMES;
  if (!Array.isArray(signals) || signals.length === 0) {
    throw new Error('signals must be a non-empty array');
  }

  const uniqueSignals = [...new Set(signals)];
  for (const signal of uniqueSignals) {
    if (typeof signal !== 'string' || !/^SIG[A-Z0-9]+$/.test(signal)) {
      throw new Error(`invalid cleanup signal: ${signal}`);
    }
  }

  let handlingSignal = false;
  const handlers = new Map();
  const uninstall = () => {
    for (const [signal, handler] of handlers) {
      process.removeListener(signal, handler);
    }
    handlers.clear();
  };
  for (const signal of uniqueSignals) {
    const handler = () => {
      if (handlingSignal) {
        return;
      }
      handlingSignal = true;
      try {
        fixture.cleanup();
      } finally {
        if (options.rethrow !== false) {
          process.kill(process.pid, signal);
        } else {
          process.exitCode = 128;
        }
      }
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  fixture.registerCleanup(uninstall);
  return uninstall;
}

async function withRemoteBuilderFixture(callback, options = {}) {
  if (typeof callback !== 'function') {
    throw new Error('withRemoteBuilderFixture requires a callback');
  }
  const fixture = createRemoteBuilderFixture(options);
  try {
    return await callback(fixture);
  } finally {
    fixture.cleanup();
  }
}

function createDefaultControls(fixture, options = {}) {
  return Object.fromEntries(FAKE_COMMAND_NAMES.map(name => [
    name,
    createFakeCommand(fixture, name, options[name]),
  ]));
}

module.exports = {
  createDefaultControls,
  createExecutable,
  createFakeCache,
  createFakeCommand,
  createFakeNix,
  createFakeProxy,
  createFakeRoute,
  createFakeSsh,
  createProcessControl,
  createRemoteBuilderFixture,
  createTemporaryState,
  darwinFixtureExpr,
  evalDarwinFixture,
  evalDisabledRoles,
  evalModuleFixture,
  fixtureEnvironment,
  installSignalCleanup,
  moduleFixtureExpr,
  nixEvalFailure,
  nixEvalJson,
  nixEnvironment,
  repoRoot,
  runExecutable,
  withRemoteBuilderFixture,
};
