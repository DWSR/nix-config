/*
 * run.js — test-runner entry point for the fabro-sandbox spec.
 * Supports Node's directory-mode `--test tests/fabro-sandbox/`
 * invocation and standalone execution through this file.
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
      if (entry.name === 'fixtures' || entry.name === 'node_modules') {
        continue;
      }
      out.push(...discoverTestFiles(full));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      out.push(full);
    }
  }
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
