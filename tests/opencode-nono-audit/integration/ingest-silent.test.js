/*
 * ingest-silent.test.js — pins the `--silent` argv contract for the
 * Compatibility Assessor's `nono profile show --json` shell-out
 * (opencode-nono-audit spec, Requirement 2.1).
 *
 * Phase 0 (opencode-nono-sandbox, 2026-06-04) verified that nono 0.43.1
 * prints its "update available" banner to STDERR, so the audit's
 * stdout-only JSON.parse is NOT broken by it — this is hardening, not a
 * bug fix. `--silent` is paired with `--json` so stdout stays strictly
 * the JSON payload regardless of nono version (a future version that
 * emitted the banner on stdout could otherwise corrupt the parse).
 *
 * The fake `nono` below emits a stdout banner UNLESS `--silent` is in its
 * argv; the audit must pass --silent for the parse to succeed. Removing
 * --silent from readProfileShowJson's argv makes this test fail (the
 * banner-prefixed stdout is not valid JSON → assessment 'skipped').
 *
 * Lives under integration/ (NOT fixtures/) so run.js's discoverTestFiles()
 * picks it up.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ingestProfileGrants } = require('../../../scripts/opencode-nono-audit.js');

// Fake `nono` mimicking nono's stdout contract:
//   - `--silent` in argv -> stdout is ONLY the grants JSON.
//   - otherwise          -> stdout starts with a banner, so it is not JSON.
// Use the current Node executable directly so this fake works with a minimal PATH.
function writeFakeNono(dir) {
  const bin = path.join(dir, 'nono');
  // Real `nono profile show --json` shape (verified 0.61.1): top-level
  // filesystem/network/groups, NO `grants` map.
  const json =
    '{"name":"opencode-managed","filesystem":{"allow":["/srv/app"],"read":[],"write":[],"deny":[]},"network":{"block":false,"allow_domain":[],"open_port":[]},"groups":{"include":["node_runtime"],"exclude":[]}}';
  const script = [
    `#!${process.execPath}`,
    `const json = ${JSON.stringify(json)};`,
    'if (process.argv.includes("--silent")) { process.stdout.write(json); }',
    'else { process.stdout.write("update 9.9.9 available (current: 0.43.1)\\n" + json); }',
  ].join('\n');
  fs.writeFileSync(bin, script, { mode: 0o755 });
  return bin;
}

test('ingestProfileGrants passes --silent so nono stdout is machine-clean JSON (R2.1)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nono-silent-'));
  try {
    const fakeNono = writeFakeNono(dir);
    const result = ingestProfileGrants('opencode-managed', { nonoBin: fakeNono });
    // With --silent passed, the fake emits ONLY JSON → parse succeeds →
    // 'available'. Without --silent (regression), the fake prepends a
    // banner line to stdout → JSON.parse fails → 'skipped'.
    assert.equal(result.assessment, 'available');
    assert.ok(result.grants && result.grants.filesystem, 'real-shape filesystem section parsed');
    assert.deepEqual(result.grants.filesystem.allow, ['/srv/app']);
    assert.deepEqual(result.grants.groups.include, ['node_runtime']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
