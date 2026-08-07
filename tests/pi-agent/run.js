'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TESTS_DIR = __dirname;
const TEST_FILE_RE = /(?:\.|-)test\.(?:c?js|mjs)$/;

function discoverTestFiles(dir) {
  const files = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name !== 'fixtures' && entry.name !== 'node_modules') {
        files.push(...discoverTestFiles(file));
      }
    } else if (entry.isFile() && TEST_FILE_RE.test(entry.name)) {
      files.push(file);
    }
  }

  return files.sort();
}

async function runSmoke() {
  const { assertNoFailedGates, runSmokeFixture } = await import('./harness.mjs');
  const report = await runSmokeFixture();

  assertNoFailedGates(report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (process.argv.slice(2).includes('--smoke')) {
  runSmoke().catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
} else {
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
}

module.exports = { discoverTestFiles };
