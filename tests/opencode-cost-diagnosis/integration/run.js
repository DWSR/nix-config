/*
 * run.js — test-runner entry point for the integration test suite of
 * the opencode-cost-diagnosis spec (task 6.2).
 *
 * Mirrors the parent tests/opencode-cost-diagnosis/run.js machinery so
 * the task 6.2 observable command works literally:
 *
 *     opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/integration/
 *
 * Node 22's `--test PATH` treats PATH as a module specifier — it does
 * NOT glob-walk a directory. The sibling package.json declares
 * `"main": "run.js"`, so CJS resolution loads THIS file inside a
 * test-runner test context. From there we walk the integration tree
 * once and `require()` each `*.test.js` file so its `test()`
 * declarations register as sub-tests of the wrapper.
 *
 * Standalone mode (`opencode-cost-diagnosis-node tests/opencode-cost-diagnosis/integration/run.js`)
 * drives node:test's programmatic `run()` API and emits TAP for the
 * smoke-test / CI consumer.
 *
 * Mode detection mirrors the parent runner: presence of
 * `process.env.NODE_TEST_CONTEXT` ⇒ already inside a test-runner
 * worker (directory mode); absence ⇒ this file is the entry point
 * (standalone mode).
 *
 * Subdirectories `golden/` and any stray `fixtures/`, `node_modules/`
 * are skipped — golden/ holds committed bytes consumed by the tests,
 * not test files themselves.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const TEST_FILE_RE = /(?:\.|-)test\.(?:c?js|mjs)$/;
const SKIP_DIRS = new Set(['golden', 'fixtures', 'node_modules']);

function discoverTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      out.push(...discoverTestFiles(full));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  // Stable order — matches the parent runner so output is
  // reproducible across hosts and across the two entry-point modes.
  return out.sort();
}

const testFiles = discoverTestFiles(TESTS_DIR);

if (process.env.NODE_TEST_CONTEXT) {
  for (const file of testFiles) {
    require(file);
  }
} else {
  const { run } = require('node:test');
  const { tap } = require('node:test/reporters');

  const stream = run({
    files: testFiles,
    concurrency: true,
  });

  stream.on('test:fail', () => {
    process.exitCode = 1;
  });

  stream.compose(tap).pipe(process.stdout);
}
