'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function agentMode(relativePath) {
  const match = read(relativePath).match(/^mode:\s*(\S+)$/m);
  assert.ok(match, `${relativePath} must declare a mode`);
  return match[1];
}

test('memory-sync agents support direct and delegated invocation', () => {
  assert.equal(agentMode('home-manager/common/agents/vault-synthesizer.md'), 'all');
  assert.equal(agentMode('home-manager/common/agents/vault-curator.md'), 'all');
});

test('an invalid synthesizer report fails before curator or marker mutation', () => {
  const source = read('scripts/memory-sync.nix');
  const guardStart = source.indexOf('if ! parse_synth_report; then');
  const guardEnd = source.indexOf('\n      fi\n\n      rm -f "$SYNTH_CAPTURE"', guardStart);
  const curatorStart = source.indexOf('# --- Curator invocation', guardStart);
  const markerWrite = source.indexOf('write_marker_atomic "$NOW"', guardStart);

  assert.notEqual(guardStart, -1, 'structured-report failure guard must exist');
  assert.notEqual(guardEnd, -1, 'structured-report failure guard must be bounded');
  assert.notEqual(curatorStart, -1, 'curator stage must follow the guard');
  assert.notEqual(markerWrite, -1, 'marker write must follow the guard');
  assert.ok(guardEnd < curatorStart, 'report validation must precede curator invocation');
  assert.ok(guardEnd < markerWrite, 'report validation must precede marker mutation');

  const guard = source.slice(guardStart, guardEnd);
  assert.match(guard, /EXIT_CODE=1/);
  assert.match(guard, /MARKER_AFTER="<unchanged>"/);
  assert.match(guard, /log_footer/);
  assert.match(guard, /exit 1/);
  assert.doesNotMatch(guard, /write_marker_atomic/);
});

test('parse_synth_report returns failure when no report is found', () => {
  const source = read('scripts/memory-sync.nix');
  assert.match(
    source,
    /if \[ -z "\$report" \]; then\s+SYNTH_SUMMARY="\(parse failed\)"\s+return 1\s+fi/,
  );
});
