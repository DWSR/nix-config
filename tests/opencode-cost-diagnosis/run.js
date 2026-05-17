/*
 * run.js — test-runner entry point for the opencode-cost-diagnosis
 * spec (Task 1.6, Requirement 1.4).
 *
 * Two invocation modes, both routed through the
 * `opencode-cost-diagnosis-node` wrapper from Task 1.4 (so
 * `require('better-sqlite3')` and `require('tiktoken')` resolve
 * against the vendored deps tree from Task 1.2):
 *
 * 1. Directory mode — the published contract from tasks.md:1.6:
 *
 *      opencode-cost-diagnosis-node --test tests/opencode-cost-diagnosis/
 *
 *    Node 22's `--test PATH` treats PATH as a module specifier (NOT
 *    a directory to glob-walk). The sibling `package.json` declares
 *    `"main": "run.js"`, so CJS resolution loads THIS file inside a
 *    test-runner test context. From within that context every
 *    `require()` of a `*.test.js` file registers its `test()`
 *    declarations as sub-tests of the wrapper. We walk the
 *    directory once and require each matching file — so tasks 6.1
 *    and 6.2 only need to add `*.test.js` siblings under this tree,
 *    no further wiring here.
 *
 *    With zero `*.test.js` files (this task's state) the wrapper
 *    test passes vacuously and the process exits 0, satisfying the
 *    observable in tasks.md:127-133.
 *
 * 2. Standalone mode — for the smoke-test derivation from task 6.3
 *    (or any other consumer that wants a single dispatchable file
 *    target rather than the `--test` flag):
 *
 *      opencode-cost-diagnosis-node tests/opencode-cost-diagnosis/run.js
 *
 *    Same directory walk, but execution goes through node:test's
 *    programmatic `run()` API piped through a reporter so the
 *    output matches what `node --test` produces.
 *
 * Mode detection: the Node test runner sets
 * `process.env.NODE_TEST_CONTEXT` (to `child-v8` in Node 22) inside
 * the worker that loads each test file. Its presence is the
 * canonical signal that we are already inside a node:test execution
 * context — i.e., directory mode. Its absence means we are the
 * entry-point script and should drive `node:test`'s programmatic
 * `run()` ourselves — i.e., standalone mode. (Using
 * `require.main === module` would not work: in both modes this
 * file IS the entry-point module, because in directory mode
 * Node's CJS resolution loads us via the package.json `main`
 * field as the top-level test file.)
 *
 * Patterns matched in both modes: `*.test.js`, `*.test.cjs`,
 * `*.test.mjs`, and the same set with `-test` instead of `.test`.
 * Mirrors Node's default test-file glob set so future tasks adding
 * test files don't need to know anything about this file.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const TEST_FILE_RE = /(?:\.|-)test\.(?:c?js|mjs)$/;

function discoverTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip fixtures (binary SQLite files) and any stray node_modules.
      if (entry.name === 'fixtures' || entry.name === 'node_modules') {
        continue;
      }
      out.push(...discoverTestFiles(full));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
  // Stable order so test execution and failure messages are
  // reproducible across machines (raw readdir order is FS-dependent).
  return out.sort();
}

const testFiles = discoverTestFiles(TESTS_DIR);

if (process.env.NODE_TEST_CONTEXT) {
  // Directory mode: we are already inside a test-runner context
  // (Node ran `--test PATH`, CJS resolved this file via package.json
  // main, and Node wrapped the load in a top-level test). Just
  // require each discovered file so its `test()` calls hoist into
  // our wrapper. Zero files → wrapper passes vacuously.
  for (const file of testFiles) {
    require(file);
  }
} else {
  // Standalone mode: drive node:test's programmatic API and emit
  // TAP. TAP is preferred over `spec` here because the primary
  // consumer (the task-6.3 smoke-test running under Nix/CI) is
  // non-interactive and machine-parseable.
  const { run } = require('node:test');
  const { tap } = require('node:test/reporters');

  const stream = run({
    files: testFiles,
    concurrency: true,
  });

  stream.on('test:fail', () => {
    // Mirror Node CLI behavior: any failing sub-test → non-zero exit.
    process.exitCode = 1;
  });

  stream.compose(tap).pipe(process.stdout);
}
