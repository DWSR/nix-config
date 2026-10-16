'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const reconcilePath = path.join(repoRoot, 'scripts/fabro-sandbox-env-reconcile.nix');

// The reconciler is a `writeShellApplication` whose `text` is the rendered
// shell body. Extract only that body so the behavioural assertions ignore the
// surrounding Nix and the file's header comments (a comment mentioning a
// request must neither satisfy nor defeat a behavioural check).
function reconcileSource() {
  return fs.readFileSync(reconcilePath, 'utf8');
}

function reconcileText() {
  const source = reconcileSource();
  const marker = "text = ''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'reconciler must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = source.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "reconciler text block must be terminated with '';");
  return source.slice(bodyStart, end);
}

test('reconciler is a writeShellApplication with the curl/jq/coreutils runtime', () => {
  const source = reconcileSource();
  assert.match(source, /pkgs\.writeShellApplication \{/);
  assert.match(source, /name = "fabro-sandbox-env-reconcile";/);
  assert.match(source, /pkgs\.curl/);
  assert.match(source, /pkgs\.jq/);
  assert.match(source, /pkgs\.coreutils/);
  // The image name is baked in at build time (like the loader/smoke scripts).
  assert.match(source, /\{ pkgs, name \}:/);
});

test('reconciler forms the declared reference from the name and recorded digest', () => {
  const text = reconcileText();
  assert.match(text, /ref="\$\{name\}@/);
  assert.match(text, /\/run\/fabro-sandbox\/digest/);
  // The digest is read at run time (the unit does not embed its value).
  assert.match(text, /cat "\$digest_file"/);
});

test('reconciler GETs the default environment with the dev token', () => {
  const text = reconcileText();
  assert.match(text, /\/environments\/default/);
  assert.match(text, /Authorization: Bearer \$FABRO_DEV_TOKEN/);
});

test('reconciler reports declared/persisted when the environment is missing', () => {
  const text = reconcileText();
  assert.match(text, /declared=\$ref persisted=<missing>/);
  // A 404 is reported, not repaired (it must not attempt a create).
  assert.match(text, /"404"/);
});

test('reconciler reads the revision and the persisted image reference', () => {
  const text = reconcileText();
  assert.match(text, /\.revision/);
  assert.match(text, /\.image\.docker/);
});

test('reconciler is idempotent when the persisted reference already matches', () => {
  const text = reconcileText();
  assert.match(text, /"\$persisted" = "\$ref"/);
  assert.match(text, /exit 0/);
});

test('reconciler PUTs with the quoted If-Match revision', () => {
  const text = reconcileText();
  assert.match(text, /-X PUT/);
  assert.match(text, /If-Match: \\"\$revision\\"/);
});

test('reconciler builds the replace body from the persisted environment', () => {
  const text = reconcileText();
  assert.match(text, /del\(\.id, \.revision\) \| \.image\.docker = \$ref/);
});

test('reconciler reports both references and the HTTP status on failure', () => {
  const text = reconcileText();
  assert.match(text, /declared=\$ref persisted=\$persisted/);
  assert.match(text, /HTTP \$(put_)?status/);
});
