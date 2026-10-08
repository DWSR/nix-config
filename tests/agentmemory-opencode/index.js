'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const featureTests = [
  'activation-secret.test.js',
  'capture-smoke.test.js',
  'core-surface.test.js',
  'cutover-contract.test.js',
  'host-render.test.js',
  'import-obsidian.test.js',
  'instructions-contract.test.js',
  'matrix.test.js',
  'mcp-runtime.test.js',
  'module-render.test.js',
  'package-contract.test.js',
  'plugin-contract.test.js',
  'preflight.test.js',
  'specialist-prompts.test.js',
  'status.test.js',
  'validation-suite.test.js',
];
const integrationTests = [
  'tests/session-compaction/integration/automatic-flow.test.ts',
  'tests/session-compaction/integration/manual-flow.test.ts',
];

function detachedSource() {
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    return { root: repoRoot, cleanup() {} };
  }

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-feature-suite-'));
  const root = path.join(temporaryDirectory, 'source');
  const excluded = new Set(['.direnv', '.git', 'result']);
  fs.cpSync(repoRoot, root, {
    recursive: true,
    filter(source) {
      const relative = path.relative(repoRoot, source);
      return relative === '' || !excluded.has(relative.split(path.sep)[0]);
    },
  });

  return {
    root,
    cleanup() {
      fs.rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

const source = detachedSource();
try {
  const result = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-concurrency=1',
      ...featureTests.map((testFile) => path.join('tests', 'agentmemory-opencode', testFile)),
      ...integrationTests,
    ],
    {
      cwd: source.root,
      env: process.env,
      stdio: 'inherit',
    },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  source.cleanup();
}
