'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { repoRoot } = require('./helpers');

const scriptDirectory = path.join(repoRoot, 'tests/local-binary-cache');
const personalSource = fs.readFileSync(
  path.join(scriptDirectory, '06-personal-endpoint-outage.sh'),
  'utf8',
);

function extractFunction(source, name) {
  const start = source.indexOf(`${name}() {`);
  const end = source.indexOf('\n}', start);
  assert.notEqual(start, -1, `missing Bash function ${name}`);
  assert.notEqual(end, -1, `missing end of Bash function ${name}`);
  return source.slice(start, end + 2);
}

function runBash(body) {
  const result = childProcess.spawnSync('/bin/bash', ['-c', body], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return result;
}

function assertOneTimeChallenge(source, functionName, commandPrefix) {
  const seam = extractFunction(source, functionName);
  const result = runBash(`
set -u
run_id=personal-outage-00000000-0000-4000-8000-000000000001
restore_challenge=personal-restore-00000000-0000-4000-8000-000000000002
restore_consumed=0
recovery_ready_consumed=0
${seam}
mismatch=0
${functionName} "${commandPrefix} $run_id personal-restore-00000000-0000-4000-8000-000000000003" \
  || mismatch=$?
first=0
${functionName} "${commandPrefix} $run_id $restore_challenge" || first=$?
replay=0
${functionName} "${commandPrefix} $run_id $restore_challenge" || replay=$?
printf 'mismatch=%d first=%d replay=%d\n' "$mismatch" "$first" "$replay"
`);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /mismatch=[1-9][0-9]* first=0 replay=[1-9][0-9]*/);
}

test('phase 06 RESTORE challenge rejects mismatch and replay', () => {
  assertOneTimeChallenge(
    personalSource,
    'consume_restore_command',
    'RESTORE',
  );
});
