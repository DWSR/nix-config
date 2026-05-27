'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  cleanupTempRoots,
  commandUnderTest,
  createCommitOnBranch,
  createLocalUpstream,
  createTempRoots,
  execCommand,
  repoRoot,
  runGit,
} = require('./helpers');

function commandEnv(roots) {
  return {
    HOME: roots.home,
    XDG_STATE_HOME: roots.stateRoot,
  };
}

function runClone(command, upstream, roots, options = {}) {
  const args = [
    'clone',
    '--repo',
    upstream.repo,
    '--cache-root',
    roots.cacheRoot,
    '--clone-root',
    roots.cloneRoot,
  ];

  if (options.branch) {
    args.push('--branch', options.branch);
  }

  if (options.dest) {
    args.push('--dest', options.dest);
  }

  return execCommand(command, args, {
    env: commandEnv(roots),
    timeout: options.timeout ?? 120_000,
  });
}

function refreshCache(command, upstream, roots, options = {}) {
  const args = [
    'refresh',
    '--repo',
    upstream.repo,
    '--cache-root',
    roots.cacheRoot,
  ];

  if (options.branch) {
    args.push('--branch', options.branch);
  }

  const result = execCommand(command, args, {
    env: commandEnv(roots),
    timeout: options.timeout ?? 120_000,
  });

  assert.equal(result.status, 0, result.stderr);
  return {
    ...result,
    cachePath: parseOutputPath(result.stdout, 'cache-path'),
  };
}

function requireSuccessfulClone(command, upstream, roots, options = {}) {
  const result = runClone(command, upstream, roots, options);
  assert.equal(result.status, 0, result.stderr);
  return {
    ...result,
    cachePath: parseOutputPath(result.stdout, 'cache-path'),
    dest: parseOutputPath(result.stdout, 'dest'),
  };
}

function parseOutputPath(stdout, key) {
  const match = stdout.match(new RegExp(`(?:^| )${key}=([^\\s]+)`));
  assert.ok(match, `clone output includes ${key}: ${stdout}`);
  return match[1];
}

function gitHead(repoPath) {
  return runGit(['rev-parse', 'HEAD'], { cwd: repoPath });
}

function cacheHead(cachePath, branch = 'main') {
  return runGit(['--git-dir', cachePath, 'rev-parse', `refs/heads/${branch}`]);
}

test('clone behavior: missing cache fails without refreshing before clone creation', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();
  const dest = path.join(roots.cloneRoot, 'missing-cache-clone');

  try {
    assert.equal(fs.existsSync(roots.cacheRoot), false);

    const result = runClone(commandUnderTest(), upstream, roots, { dest });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[git-cache-clone: clone_failed\]/);
    assert.match(result.stderr, /step=clone_from_cache/);
    assert.equal(fs.existsSync(roots.cacheRoot), false);
    assert.equal(fs.existsSync(dest), false);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('clone behavior: GitHub URLs map to stable ghq-style cache paths', () => {
  const roots = createTempRoots();
  const repo = 'https://github.com/Shopify/globaldb-yugabyte';
  const expectedCachePath = path.join(roots.cacheRoot, 'github.com', 'Shopify', 'globaldb-yugabyte');

  try {
    const result = execCommand(commandUnderTest(), [
      'clone',
      '--repo',
      repo,
      '--cache-root',
      roots.cacheRoot,
      '--clone-root',
      roots.cloneRoot,
      '--dest',
      path.join(roots.cloneRoot, 'globaldb-yugabyte'),
    ], {
      env: commandEnv(roots),
      timeout: 120_000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[git-cache-clone: clone_failed\]/);
    assert.match(result.stderr, new RegExp(`cache=${escapeRegExp(expectedCachePath)}`));
  } finally {
    cleanupTempRoots(roots);
  }
});

test('clone behavior: stale cache is used as-is before clone creation', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const command = commandUnderTest();
    const cached = refreshCache(command, upstream, roots);
    assert.equal(cacheHead(cached.cachePath, upstream.branch), upstream.head);

    const nextHead = createCommitOnBranch(upstream, upstream.branch, {
      'README.md': '# fixture upstream\n\nclone refresh update\n',
    }, { parent: upstream.head, message: 'advance before clone' });

    const clone = requireSuccessfulClone(command, upstream, roots, {
      dest: path.join(roots.cloneRoot, 'stale-cache-clone'),
    });

    assert.equal(clone.cachePath, cached.cachePath);
    assert.equal(cacheHead(clone.cachePath, upstream.branch), upstream.head);
    assert.notEqual(cacheHead(clone.cachePath, upstream.branch), nextHead);
    assert.equal(gitHead(clone.dest), upstream.head);
    assert.equal(fs.readFileSync(path.join(clone.dest, 'README.md'), 'utf8'), '# fixture upstream\n');
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('clone behavior: generated clone has upstream origin, requested branch, isolated metadata, and no cache dependency', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const releaseHead = createCommitOnBranch(upstream, 'release', {
      'release.txt': 'release branch content\n',
    }, { parent: upstream.head, message: 'release commit' });

    refreshCache(commandUnderTest(), upstream, roots, { branch: 'release' });

    const result = requireSuccessfulClone(commandUnderTest(), upstream, roots, {
      branch: 'release',
      dest: path.join(roots.cloneRoot, 'release-clone'),
    });

    assert.equal(fs.statSync(path.join(result.dest, '.git')).isDirectory(), true);
    assert.notEqual(path.resolve(path.join(result.dest, '.git')), path.resolve(result.cachePath));
    assert.equal(runGit(['remote', 'get-url', 'origin'], { cwd: result.dest }), upstream.repo);
    assert.notEqual(runGit(['remote', 'get-url', 'origin'], { cwd: result.dest }), result.cachePath);
    assert.equal(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: result.dest }), 'release');
    assert.equal(gitHead(result.dest), releaseHead);
    assert.equal(fs.existsSync(path.join(result.dest, '.git', 'objects', 'info', 'alternates')), false);

    fs.rmSync(result.cachePath, { recursive: true, force: true });
    assert.equal(runGit(['fsck', '--no-progress'], { cwd: result.dest }), '');
    assert.equal(runGit(['show', '--no-patch', '--format=%s', 'HEAD'], { cwd: result.dest }), 'release commit');
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('clone behavior: non-empty destination is rejected before clone work begins', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();
  const dest = path.join(roots.cloneRoot, 'occupied');

  try {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'existing.txt'), 'do not overwrite\n');

    const result = runClone(commandUnderTest(), upstream, roots, { dest });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[git-cache-clone: unsafe_destination\]/);
    assert.match(result.stderr, new RegExp(escapeRegExp(dest)));
    assert.equal(fs.existsSync(path.join(dest, '.git')), false);
    assert.equal(fs.existsSync(roots.cacheRoot), false);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('clone behavior: remote and checkout failure labels include failing step and destination path', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/git-clone-isolation.nix'), 'utf8');

  assert.match(source, /fail "remote_rewrite_failed" "step=remote_set_url dest=\$dest origin=\$repo"/);
  assert.match(source, /fail "checkout_failed" "step=checkout dest=\$dest branch=\$branch"/);
});

test('clone behavior: source remains outside Graphite, worktree, zellij, and Graphite metadata ownership', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/git-clone-isolation.nix'), 'utf8');
  const executableLines = source
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const executableSource = executableLines.join('\n');

  assert.doesNotMatch(executableSource, /(^|[^A-Za-z0-9_-])gt(\s|$)/);
  assert.doesNotMatch(executableSource, /git\s+worktree/);
  assert.doesNotMatch(executableSource, /zellij/);
  assert.doesNotMatch(executableSource, /\.git\/\.graphite_/);
  assert.doesNotMatch(executableSource, /graphite.*(write|edit|modify|rm|mv|touch)/i);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
