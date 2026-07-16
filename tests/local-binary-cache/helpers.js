'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const modulePath = path.join(repoRoot, 'configurations/common-darwin/local-binary-cache.nix');
const NIX_EVAL_TIMEOUT_MS = 120_000;
const NIX_EVAL_MAX_BUFFER = 64 * 1024 * 1024;
const NIX_BUILD_TIMEOUT_MS = 600_000;

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

function nixPathLiteral(filePath) {
  if (!path.isAbsolute(filePath) || /[\s'"\\$]/.test(filePath)) {
    throw new Error(`unsupported Nix path literal: ${filePath}`);
  }
  return filePath;
}

function nixValueLiteral(value) {
  if (typeof value === 'boolean') {
    return String(value);
  }
  if (typeof value !== 'string') {
    throw new Error(`unsupported injected Nix value: ${typeof value}`);
  }
  return JSON.stringify(value).replaceAll('${', '\\${');
}

function buildScript(relativePath, injected = {}, options = {}) {
  const scriptPath = fixturePath(repoRoot, 'script path', relativePath);
  const injectedSource = Object.entries(injected).map(([name, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid injected Nix argument name: ${name}`);
    }
    return `${name} = ${nixValueLiteral(value)};`;
  }).join('\n');
  const expr = `
    let
      flake = builtins.getFlake ${nixValueLiteral(repoRoot)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      pkgs.callPackage ${nixPathLiteral(scriptPath)} {
        ${injectedSource}
      }
  `;
  const outPath = childProcess.execFileSync(
    options.nixExecutable ?? 'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...(options.env ?? {}),
      },
      maxBuffer: NIX_EVAL_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: options.timeout ?? NIX_BUILD_TIMEOUT_MS,
    },
  ).trim();
  const executableName = options.executableName ?? path.basename(relativePath, '.nix');
  return path.join(outPath, 'bin', executableName);
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
  buildScript,
  createScriptFixture,
  darwinFixtureExpr,
  evalDarwinFixture,
  nixEvalJson,
  repoRoot,
  runScript,
};
