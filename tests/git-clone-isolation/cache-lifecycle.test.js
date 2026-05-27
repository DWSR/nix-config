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
  runGit,
} = require('./helpers');

function commandEnv(roots) {
  return {
    HOME: roots.home,
    XDG_STATE_HOME: roots.stateRoot,
  };
}

function refreshCache(command, upstream, roots, options = {}) {
  return execCommand(command, [
    'refresh',
    '--repo',
    upstream.repo,
    '--branch',
    options.branch ?? upstream.branch,
    '--cache-root',
    roots.cacheRoot,
  ], {
    env: commandEnv(roots),
    timeout: options.timeout ?? 120_000,
  });
}

function requireSuccessfulRefresh(command, upstream, roots, options = {}) {
  const result = refreshCache(command, upstream, roots, options);
  assert.equal(result.status, 0, result.stderr);
  const cachePath = parseCachePath(result.stdout);
  assert.ok(cachePath.startsWith(`${roots.cacheRoot}${path.sep}`), `cache path under cache root: ${cachePath}`);
  return { ...result, cachePath };
}

function parseCachePath(stdout) {
  const match = stdout.match(/(?:^| )cache-path=([^\n]+)$/m);
  assert.ok(match, `refresh output includes cache-path: ${stdout}`);
  return match[1];
}

function cachedHead(cachePath, branch = 'main') {
  return runGit(['--git-dir', cachePath, 'rev-parse', `refs/heads/${branch}`]);
}

function listCacheRefs(cachePath) {
  return runGit(['--git-dir', cachePath, 'for-each-ref', '--format=%(refname)'])
    .split('\n')
    .filter(Boolean)
    .sort();
}

test('cache lifecycle: refresh creates a bare cache with no working tree for a local main branch', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const { cachePath } = requireSuccessfulRefresh(commandUnderTest(), upstream, roots);

    assert.equal(runGit(['--git-dir', cachePath, 'rev-parse', '--is-bare-repository']), 'true');
    assert.equal(runGit(['--git-dir', cachePath, 'rev-parse', '--is-inside-work-tree']), 'false');
    assert.equal(fs.existsSync(path.join(cachePath, '.git')), false);
    assert.equal(cachedHead(cachePath), upstream.head);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('cache lifecycle: cache contains requested branch and origin but excludes unrequested branch and tag refs', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const featureHead = createCommitOnBranch(upstream, 'feature/unrequested', {
      'feature.txt': 'feature branch content\n',
    }, { parent: upstream.head, message: 'feature commit' });
    runGit(['update-ref', 'refs/tags/v1.0.0', featureHead], { cwd: upstream.repo });

    const { cachePath } = requireSuccessfulRefresh(commandUnderTest(), upstream, roots);
    const refs = listCacheRefs(cachePath);

    assert.ok(refs.includes('refs/heads/main'));
    assert.equal(refs.some((ref) => ref.includes('feature/unrequested')), false, refs.join('\n'));
    assert.equal(refs.some((ref) => ref.startsWith('refs/tags/')), false, refs.join('\n'));
    assert.equal(runGit(['--git-dir', cachePath, 'remote', 'get-url', 'origin']), upstream.repo);
    assert.equal(cachedHead(cachePath), upstream.head);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('cache lifecycle: refresh advances cached main after upstream advances', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const command = commandUnderTest();
    const { cachePath } = requireSuccessfulRefresh(command, upstream, roots);
    assert.equal(cachedHead(cachePath), upstream.head);

    const nextHead = createCommitOnBranch(upstream, upstream.branch, {
      'README.md': '# fixture upstream\n\nupdated\n',
    }, { parent: upstream.head, message: 'advance main' });

    const refreshed = requireSuccessfulRefresh(command, upstream, roots);
    assert.equal(refreshed.cachePath, cachePath);
    assert.equal(cachedHead(cachePath), nextHead);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('cache lifecycle: failed refresh preserves previous usable cache and emits cache_fetch_failed', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const command = commandUnderTest();
    const { cachePath } = requireSuccessfulRefresh(command, upstream, roots);
    const originalHead = cachedHead(cachePath);

    fs.renameSync(upstream.repo, `${upstream.repo}.unreachable`);
    const result = refreshCache(command, upstream, roots);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[git-clone-isolation: cache_fetch_failed\]/);
    assert.equal(cachedHead(cachePath), originalHead);
    assert.equal(runGit(['--git-dir', cachePath, 'fsck', '--no-progress']), '');
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});

test('cache lifecycle: lock conflict emits cache_lock_failed and blocks concurrent cache mutation', () => {
  const upstream = createLocalUpstream();
  const roots = createTempRoots();

  try {
    const command = commandUnderTest();
    const { cachePath } = requireSuccessfulRefresh(command, upstream, roots);
    const lockedHead = cachedHead(cachePath);
    const lockDir = `${cachePath}.lock`;

    const nextHead = createCommitOnBranch(upstream, upstream.branch, {
      'README.md': '# fixture upstream\n\nlocked update\n',
    }, { parent: upstream.head, message: 'advance while locked' });

    fs.mkdirSync(lockDir);
    try {
      const result = refreshCache(command, upstream, roots);

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /\[git-clone-isolation: cache_lock_failed\]/);
      assert.equal(cachedHead(cachePath), lockedHead);
      assert.notEqual(cachedHead(cachePath), nextHead);
    } finally {
      fs.rmSync(lockDir, { recursive: true, force: true });
    }

    requireSuccessfulRefresh(command, upstream, roots);
    assert.equal(cachedHead(cachePath), nextHead);
  } finally {
    cleanupTempRoots(roots);
    cleanupTempRoots(upstream);
  }
});
