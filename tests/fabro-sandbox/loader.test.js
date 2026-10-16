'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const loaderPath = path.join(repoRoot, 'scripts/fabro-sandbox-image-load.nix');

// The loader is a `writeShellApplication` whose `text` is the rendered shell
// body. Extract only that body so the assertions ignore the surrounding Nix
// and the file's header comments (a comment mentioning a registry must neither
// satisfy nor defeat a behavioural check).
function loadScriptText() {
  const source = fs.readFileSync(loaderPath, 'utf8');
  const marker = "text = ''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'loader must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = source.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "loader text block must be terminated with '';");
  return { source, body: source.slice(bodyStart, end) };
}

test('loader is a writeShellApplication with the podman/coreutils runtime', () => {
  const { source } = loadScriptText();
  assert.match(source, /pkgs\.writeShellApplication \{/);
  assert.match(source, /name = "fabro-sandbox-image-load";/);
  assert.match(source, /pkgs\.podman/);
  assert.match(source, /pkgs\.coreutils/);
  // The image name is baked in at build time (like the reconciler/smoke
  // scripts); the unit passes the archive and digest store paths.
  assert.match(source, /\{ pkgs, name \}:/);
});

test('loader loads the archive into the local podman store', () => {
  const { body } = loadScriptText();
  assert.match(body, /podman load -i "\$archive"/);
});

test('loader verifies the immutable digest reference and fails on it', () => {
  const { body } = loadScriptText();
  assert.match(body, /ref="\$\{name\}@\$digest"/);
  assert.match(body, /podman image exists "\$ref"/);
  // A failed reference check must exit non-zero (the switch then fails).
  assert.match(body, /exit 1/);
});

test('loader records the digest for the reconciler and smoke check', () => {
  const { body } = loadScriptText();
  assert.match(body, /\/run\/fabro-sandbox\/digest/);
  assert.match(body, /chmod 0644/);
});

test('loader never pushes to or contacts a registry', () => {
  const { body } = loadScriptText();
  for (const forbidden of ['push', 'skopeo', 'tls-verify', 'podman pull', 'docker pull']) {
    assert.equal(
      body.includes(forbidden),
      false,
      `loader text must not contain ${forbidden}`,
    );
  }
});
