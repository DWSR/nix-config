'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const smokePath = path.join(repoRoot, 'scripts/fabro-sandbox-smoke.nix');
const sandboxPath = path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix');

// The smoke check is a `writeShellApplication` whose `text` is the rendered
// shell body. Extract only that body so the probe assertions ignore the
// surrounding Nix and the file's header comments (a comment mentioning a probe
// must neither satisfy nor defeat a behavioural check), matching the pattern
// loader.test.js and reconciler.test.js use for their scripts.
function smokeSource() {
  return fs.readFileSync(smokePath, 'utf8');
}

function smokeText() {
  const source = smokeSource();
  const marker = "text = ''";
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, 'smoke script must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = source.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "smoke text block must be terminated with '';");
  return source.slice(bodyStart, end);
}

test('smoke script is a writeShellApplication with the podman/coreutils runtime', () => {
  const source = smokeSource();
  assert.match(source, /pkgs\.writeShellApplication \{/);
  assert.match(source, /name = "fabro-sandbox-smoke";/);
  assert.match(source, /pkgs\.podman/);
  assert.match(source, /pkgs\.coreutils/);
  // The image name is baked in at build time (like the loader/reconciler).
  assert.match(source, /\{ pkgs, name \}:/);
});

test('smoke script defaults the reference to the recorded image digest', () => {
  const text = smokeText();
  assert.match(text, /\/run\/fabro-sandbox\/digest/);
  assert.match(text, /ref="\$\{name\}@\$/);
});

test('smoke script runs the tools, store, and daemon probes in the image', () => {
  const text = smokeText();
  // Requirement 6.3: the image's tools run inside a container from the image.
  // `setsid` is included because the Fabro sandbox driver refuses to run a
  // command node without it (exit 127 before the script starts).
  assert.match(text, /bash --version; git --version; command -v nix; command -v setsid/);
  // Requirement 6.4: the container reaches the host store and daemon.
  assert.match(text, /test -e \/nix\/store; ls \/nix\/store/);
  assert.match(text, /nix store ping/);
  // Each probe runs in a fresh container from the digest reference.
  assert.match(text, /podman run --rm "\$ref" \/bin\/bash -c/);
});

test('smoke script banners each step and names the failed step', () => {
  const text = smokeText();
  // Requirement 6.5: a step banner precedes each probe and a failure names the
  // step and exits non-zero.
  assert.match(text, /fabro-sandbox-smoke: \[%s\]/);
  assert.match(text, /step %s failed/);
  assert.match(text, /exit 1/);
});

test('the guest installs the smoke script in environment.systemPackages', () => {
  const src = fs.readFileSync(sandboxPath, 'utf8');
  assert.match(src, /scripts\/fabro-sandbox-smoke\.nix/);
  const block = src.match(/environment\.systemPackages = \[([\s\S]*?)\]/);
  assert.notEqual(block, null, 'sandbox.nix must set environment.systemPackages');
  assert.match(block[1], /\bsmokeScript\b/);
  // The task 7.5 verifier rides alongside it; both are guest-installed tools.
  assert.match(block[1], /\bverifyScript\b/);
});
