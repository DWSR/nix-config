'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const reconcilerPath = path.join(repoRoot, 'scripts/fabro-sandbox-env-reconcile.nix');

// The reconciler is a `writeShellApplication` whose `text` is the rendered
// shell body. Extract only that body so the assertions ignore the surrounding
// Nix and the file's header comments (a comment mentioning a status must
// neither satisfy nor defeat a behavioural check).
function loadScriptText() {
  const source = fs.readFileSync(reconcilerPath, 'utf8');
  const marker = "text = ''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'reconciler must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = source.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "reconciler text block must be terminated with '';");
  return { source, body: source.slice(bodyStart, end) };
}

test('reconciler is a writeShellApplication with the curl/jq/coreutils runtime', () => {
  const { source } = loadScriptText();
  assert.match(source, /pkgs\.writeShellApplication \{/);
  assert.match(source, /name = "fabro-sandbox-env-reconcile";/);
  assert.match(source, /pkgs\.curl/);
  assert.match(source, /pkgs\.jq/);
  assert.match(source, /pkgs\.coreutils/);
  // The image name is baked in at build time; the unit runs the script.
  assert.match(source, /\{ pkgs, name \}:/);
});

test('reconciler derives the declared reference from the loader digest file', () => {
  const { body } = loadScriptText();
  assert.match(body, /ref="\$\{name\}@\$\(cat \/run\/fabro-sandbox\/digest\)"/);
});

test('reconciler GETs the default environment with the dev token', () => {
  const { body } = loadScriptText();
  assert.match(body, /-X GET/);
  assert.match(body, /\/api\/v1\/environments\/default/);
  assert.match(body, /Authorization: Bearer \$FABRO_DEV_TOKEN/);
});

test('reconciler reports a missing environment as declared/persisted=<missing>', () => {
  const { body } = loadScriptText();
  assert.match(body, /declared=\$ref persisted=<missing>/);
});

test('reconciler is idempotent when the persisted image already matches', () => {
  const { body } = loadScriptText();
  // Reads both `.image.docker` and the revision from the GET body.
  assert.match(body, /jq -r '\.image\.docker'/);
  assert.match(body, /jq -c '\.revision'/);
  // Compares the persisted image to the declared reference and exits 0.
  assert.match(body, /\[ "\$persisted" = "\$ref" \]/);
  assert.match(body, /exit 0/);
});

test('reconciler PUTs the digest reference with an If-Match precondition', () => {
  const { body } = loadScriptText();
  assert.match(body, /-X PUT/);
  assert.match(body, /If-Match: \$revision/);
  assert.match(body, /del\(\.id, \.revision\) \| \.image\.docker = \$ref/);
  // Updates the existing record; it must never create a duplicate.
  assert.equal(/\bPOST\b/.test(body), false, 'reconciler must not POST (no duplicate create)');
});

test('reconciler names the declared and persisted references on failure', () => {
  const { body } = loadScriptText();
  assert.match(body, /declared=\$ref persisted=\$persisted/);
  // Any PUT status other than 200 reports the HTTP status and fails.
  assert.match(body, /\[ "\$put_status" != "200" \]/);
  assert.match(body, /HTTP \$put_status/);
});
