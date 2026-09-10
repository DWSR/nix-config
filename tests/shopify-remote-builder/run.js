'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const TEST_FILE_RE = /(?:\.|-)test\.(?:c?js|mjs)$/;

function discoverTestFiles(directory) {
  const testFiles = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') {
        continue;
      }
      testFiles.push(...discoverTestFiles(fullPath));
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      testFiles.push(fullPath);
    }
  }
  return testFiles.sort();
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

module.exports = { discoverTestFiles };
