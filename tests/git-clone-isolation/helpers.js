'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

let cachedCommandUnderTest;

function runGit(args, options = {}) {
  return childProcess.execFileSync('git', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Fixture Author',
      GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'Fixture Committer',
      GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
      ...(options.env ?? {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: options.timeout ?? 120_000,
    input: options.input,
  }).trim();
}

function createTempRoots(prefix = 'git-clone-isolation-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const home = path.join(root, 'home');
  const stateRoot = path.join(root, 'state');
  const cacheRoot = path.join(stateRoot, 'git-clone-isolation');
  const cloneRoot = path.join(home, 'scratch');

  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  fs.mkdirSync(cloneRoot, { recursive: true });

  return { root, home, stateRoot, cacheRoot, cloneRoot };
}

function createLocalUpstream(options = {}) {
  const roots = createTempRoots('git-clone-isolation-upstream-');
  const repo = path.join(roots.root, options.name ?? 'upstream');
  const branch = options.branch ?? 'main';
  const files = options.files ?? {
    'README.md': '# fixture upstream\n',
  };

  fs.mkdirSync(repo, { recursive: true });
  runGit(['init', '-q'], { cwd: repo });
  runGit(['symbolic-ref', 'HEAD', `refs/heads/${branch}`], { cwd: repo });

  const indexFile = path.join(roots.root, 'fixture.index');
  for (const [filePath, content] of Object.entries(files).sort(([left], [right]) => left.localeCompare(right))) {
    if (path.isAbsolute(filePath) || filePath === '' || filePath.split('/').includes('..')) {
      throw new Error(`fixture file path must be relative and stay inside the repository: ${filePath}`);
    }
    const oid = runGit(['hash-object', '-w', '--stdin'], { cwd: repo, input: content });
    runGit(['update-index', '--add', '--cacheinfo', `100644,${oid},${filePath}`], {
      cwd: repo,
      env: { GIT_INDEX_FILE: indexFile },
    });
  }

  const tree = runGit(['write-tree'], { cwd: repo, env: { GIT_INDEX_FILE: indexFile } });
  const commit = runGit(['commit-tree', tree, '-m', options.message ?? 'fixture initial commit'], { cwd: repo });
  runGit(['update-ref', `refs/heads/${branch}`, commit], { cwd: repo });

  return { ...roots, repo, branch, head: commit };
}

function nixPathLiteral(filePath) {
  if (!path.isAbsolute(filePath) || /[\s'"\\]/.test(filePath)) {
    throw new Error(`unsupported Nix path literal: ${filePath}`);
  }
  return filePath;
}

function buildCommandUnderTest() {
  const expr = `
    let
      flake = builtins.getFlake (toString ${nixPathLiteral(repoRoot)});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
    in
      pkgs.callPackage ${nixPathLiteral(path.join(repoRoot, 'scripts/git-clone-isolation.nix'))} { }
  `;

  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ).trim();

  return path.join(outPath, 'bin', 'git-clone-isolation');
}

function commandUnderTest(options = {}) {
  if (process.env.GIT_CLONE_ISOLATION_BIN) {
    return process.env.GIT_CLONE_ISOLATION_BIN;
  }
  if (cachedCommandUnderTest) {
    return cachedCommandUnderTest;
  }
  if (options.build === false) {
    return path.join(repoRoot, 'result/bin/git-clone-isolation');
  }
  cachedCommandUnderTest = buildCommandUnderTest();
  return cachedCommandUnderTest;
}

function cleanupTempRoots(roots) {
  fs.rmSync(roots.root, { recursive: true, force: true });
}

module.exports = {
  buildCommandUnderTest,
  cleanupTempRoots,
  commandUnderTest,
  createLocalUpstream,
  createTempRoots,
  repoRoot,
  runGit,
};
