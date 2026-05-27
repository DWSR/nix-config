'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');

const {
  cleanupTempRoots,
  commandUnderTest,
  createLocalUpstream,
  createTempRoots,
  runGit,
} = require('./helpers');

test('fixture helper creates a local upstream repository with a main branch', () => {
  const upstream = createLocalUpstream();

  try {
    assert.equal(runGit(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: upstream.repo }), 'main');
    assert.equal(runGit(['rev-parse', '--verify', 'refs/heads/main'], { cwd: upstream.repo }), upstream.head);
    assert.equal(runGit(['show', '--no-patch', '--format=%s', upstream.head], { cwd: upstream.repo }), 'fixture initial commit');
    assert.equal(fs.readFileSync(`${upstream.repo}/.git/HEAD`, 'utf8').trim(), 'ref: refs/heads/main');
  } finally {
    cleanupTempRoots(upstream);
  }
});

test('temporary roots provide isolated home, state, cache, and clone paths', () => {
  const roots = createTempRoots();

  try {
    assert.equal(fs.statSync(roots.home).isDirectory(), true);
    assert.equal(fs.statSync(roots.stateRoot).isDirectory(), true);
    assert.equal(fs.statSync(roots.cloneRoot).isDirectory(), true);
    assert.equal(roots.cacheRoot, `${roots.stateRoot}/git-clone-isolation`);
  } finally {
    cleanupTempRoots(roots);
  }
});

test('command helper locates an explicit packaged command override', () => {
  const roots = createTempRoots();
  const command = `${roots.root}/bin/git-clone-isolation`;

  try {
    fs.mkdirSync(`${roots.root}/bin`, { recursive: true });
    fs.writeFileSync(command, '#!/bin/sh\nprintf "%s\\n" "git-clone-isolation 0.0.0-test"\n', { mode: 0o755 });

    const previousOverride = process.env.GIT_CLONE_ISOLATION_BIN;
    process.env.GIT_CLONE_ISOLATION_BIN = command;

    let result;
    try {
      result = childProcess.execFileSync(commandUnderTest({ build: false }), ['--version'], {
        encoding: 'utf8',
      }).trim();
    } finally {
      if (previousOverride === undefined) {
        delete process.env.GIT_CLONE_ISOLATION_BIN;
      } else {
        process.env.GIT_CLONE_ISOLATION_BIN = previousOverride;
      }
    }

    assert.equal(result, 'git-clone-isolation 0.0.0-test');
  } finally {
    cleanupTempRoots(roots);
  }
});
