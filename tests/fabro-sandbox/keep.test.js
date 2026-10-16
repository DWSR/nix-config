'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const keepPath = path.join(repoRoot, 'scripts/fabro-sandbox-image-keep.nix');

// The keeper is a `writeShellApplication` whose `text` is the rendered shell
// body. Extract only that body so the assertions ignore the surrounding Nix
// and the file's header comments (a comment mentioning a registry must neither
// satisfy nor defeat a behavioural check).
function keepScriptText() {
  const source = fs.readFileSync(keepPath, 'utf8');
  const marker = "text = ''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'keeper must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = source.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "keeper text block must be terminated with '';");
  return { source, body: source.slice(bodyStart, end) };
}

test('keeper is a writeShellApplication with the podman/coreutils runtime', () => {
  const { source } = keepScriptText();
  assert.match(source, /pkgs\.writeShellApplication \{/);
  assert.match(source, /name = "fabro-sandbox-image-keep";/);
  assert.match(source, /pkgs\.podman/);
  assert.match(source, /pkgs\.coreutils/);
  // The image name is baked in at build time (like the loader/reconciler);
  // the unit passes the digest store path.
  assert.match(source, /\{ pkgs, name \}:/);
});

test('keeper reads the declared digest to form the immutable reference', () => {
  const { body } = keepScriptText();
  assert.match(body, /digest_file="\$1"/);
  assert.match(body, /ref="\$\{name\}@\$\(cat "\$digest_file"\)"/);
  // A missing digest file must fail the unit, not guess a reference.
  assert.match(body, /exit 1/);
});

test('keeper fails on a missing image rather than pulling it', () => {
  const { body } = keepScriptText();
  assert.match(body, /podman image exists "\$ref"/);
  assert.match(body, /--pull=never/);
});

test('keeper replaces any stale keeper and runs the container in the foreground', () => {
  const { body } = keepScriptText();
  assert.match(body, /podman rm --force --ignore fabro-sandbox-image-keep/);
  // `exec` keeps systemd as the direct supervisor and signals delivered
  // straight to `podman run`; `--rm` removes the container when the unit
  // stops.
  assert.match(
    body,
    /exec podman run --rm --name fabro-sandbox-image-keep --pull=never/,
  );
  assert.match(body, /"\$ref" \/bin\/bash -c "trap 'exit 0' TERM; sleep infinity & wait"/);
});

test('keeper never pushes to or contacts a registry', () => {
  const { body } = keepScriptText();
  for (const forbidden of ['push', 'skopeo', 'tls-verify', 'podman pull', 'docker pull']) {
    assert.equal(
      body.includes(forbidden),
      false,
      `keeper text must not contain ${forbidden}`,
    );
  }
});
