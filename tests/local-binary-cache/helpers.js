'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const modulePath = path.join(repoRoot, 'configurations/common-darwin/local-binary-cache.nix');
const NIX_EVAL_TIMEOUT_MS = 120_000;
const NIX_EVAL_MAX_BUFFER = 64 * 1024 * 1024;

function nixEvalJson(expr, options = {}) {
  return JSON.parse(childProcess.execFileSync(
    options.nixExecutable ?? 'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      maxBuffer: NIX_EVAL_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? NIX_EVAL_TIMEOUT_MS,
    },
  ));
}

function darwinFixtureExpr(moduleSource, resultSource) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      fixture = flake.inputs.darwin.lib.darwinSystem {
        modules = [
          ${modulePath}
          ({ ... }: {
            nixpkgs.hostPlatform = builtins.currentSystem;
          })
          (${moduleSource})
        ];
      };
      config = fixture.config;
    in
      ${resultSource}
  `;
}

function evalDarwinFixture(moduleSource, resultSource, options = {}) {
  return nixEvalJson(darwinFixtureExpr(moduleSource, resultSource), options);
}

function fixturePath(root, name, relativePath) {
  if (
    typeof relativePath !== 'string'
    || relativePath === ''
    || path.isAbsolute(relativePath)
    || relativePath.split(path.sep).includes('..')
  ) {
    throw new Error(`${name} must be a relative path inside the script fixture`);
  }

  const resolved = path.resolve(root, relativePath);
  if (path.relative(root, resolved).startsWith('..')) {
    throw new Error(`${name} escapes the script fixture`);
  }
  return resolved;
}

function createScriptFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-binary-cache-'));
  const home = path.join(root, 'home');
  const bin = path.join(root, 'bin');
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  fs.mkdirSync(tmp);

  const statePaths = Object.fromEntries(Object.entries(options.statePaths ?? {}).map(
    ([name, relativePath]) => {
      const resolved = fixturePath(root, `state path ${name}`, relativePath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      return [name, resolved];
    },
  ));

  const executables = Object.fromEntries(Object.entries(options.executables ?? {}).map(
    ([name, source]) => {
      if (!/^[A-Za-z0-9._-]+$/.test(name)) {
        throw new Error(`invalid fixture executable name: ${name}`);
      }
      const executable = path.join(bin, name);
      fs.writeFileSync(executable, `#!${process.execPath}\n'use strict';\n${source}\n`, { mode: 0o700 });
      return [name, executable];
    },
  ));

  return {
    bin,
    cleanup: () => fs.rmSync(root, { force: true, recursive: true }),
    executables,
    home,
    root,
    statePaths,
    tmp,
  };
}

function runScript(executable, args = [], options = {}) {
  if (!options.fixture) {
    throw new Error('runScript requires an isolated fixture');
  }

  const fixture = options.fixture;
  const result = childProcess.spawnSync(executable, args, {
    cwd: options.cwd ?? fixture.root,
    encoding: 'utf8',
    env: {
      HOME: fixture.home,
      LANG: 'C',
      LC_ALL: 'C',
      PATH: fixture.bin,
      TMPDIR: fixture.tmp,
      ...(options.env ?? {}),
    },
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

module.exports = {
  createScriptFixture,
  darwinFixtureExpr,
  evalDarwinFixture,
  nixEvalJson,
  repoRoot,
  runScript,
};
