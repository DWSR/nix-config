'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const sandboxPath = path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix');
const fabroPath = path.join(repoRoot, 'configurations/fabro-vm/fabro.nix');

// The loader and reconciler units live in sandbox.nix; read the module text
// so the assertions do not depend on a Linux builder or a full NixOS
// evaluation (the same source-level pattern loader.test.js uses for the
// script).
function readSandbox() {
  return fs.readFileSync(sandboxPath, 'utf8');
}

// Isolate one `systemd.services."<name>"` attrset so shape assertions cannot
// be satisfied by a sibling unit that happens to share the same keys (the
// loader already declares Type/RemainAfterExit/wantedBy).
function serviceBlock(name) {
  const src = readSandbox();
  const marker = `systemd.services."${name}"`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `sandbox.nix must declare ${marker}`);
  const next = src.indexOf('systemd.services."', start + marker.length);
  return src.slice(start, next === -1 ? src.length : next);
}

test('sandbox.nix declares the loader unit as a podman-gated oneshot', () => {
  const src = readSandbox();
  assert.match(src, /systemd\.services\."fabro-sandbox-image-load"/);
  assert.match(src, /Type = "oneshot"/);
  assert.match(src, /RemainAfterExit = true/);
  assert.match(src, /wantedBy = \[ "multi-user\.target" \]/);
  assert.match(src, /RuntimeDirectory = "fabro-sandbox"/);
  // Ordered after and hard-requiring the podman API socket.
  assert.match(src, /after = \[ "podman\.socket" \]/);
  assert.match(src, /requires = \[ "podman\.socket" \]/);
});

test('loader ExecStart embeds the archive and digest store paths', () => {
  const src = readSandbox();
  const execStart = src.match(/ExecStart = "([^"]*)"/);
  assert.notEqual(execStart, null, 'sandbox.nix must declare an ExecStart for the loader');
  const line = execStart[1];
  assert.match(line, /\$\{lib\.getExe loadScript\}/);
  // Both store paths are interpolated so a contents change rewrites the unit.
  assert.match(line, /\$\{cfg\.archive\}/);
  assert.match(line, /\$\{cfg\.digest\}/);
});

test('sandbox.nix declares the reconciler unit as a oneshot ordered after fabro + loader', () => {
  const block = serviceBlock('fabro-sandbox-env');
  assert.match(block, /Type = "oneshot"/);
  assert.match(block, /RemainAfterExit = true/);
  assert.match(block, /wantedBy = \[ "multi-user\.target" \]/);
  // Ordered after and hard-requiring fabro.service and the loader: the
  // reconciler needs the persisted environment and the recorded digest.
  assert.match(
    block,
    /after = \[[^\]]*"fabro\.service"[^\]]*"fabro-sandbox-image-load\.service"[^\]]*\]/,
  );
  assert.match(
    block,
    /requires = \[[^\]]*"fabro\.service"[^\]]*"fabro-sandbox-image-load\.service"[^\]]*\]/,
  );
});

test('reconciler unit runs as root and consumes the sops fabro-env template', () => {
  const block = serviceBlock('fabro-sandbox-env');
  assert.match(block, /User = "root"/);
  assert.match(block, /EnvironmentFile = config\.sops\.templates\."fabro-env"\.path/);
  // Runs the reconciler script, whose image name is baked in at build time.
  assert.match(block, /ExecStart = "\$\{lib\.getExe reconcileScript\}"/);
});

test('fabro.service is ordered after and wants the loader', () => {
  const fabro = fs.readFileSync(fabroPath, 'utf8');
  const after = fabro.match(/after = \[([^\]]*)\]/);
  const wants = fabro.match(/wants = \[([^\]]*)\]/);
  assert.notEqual(after, null, 'fabro.nix must declare the fabro.service after list');
  assert.notEqual(wants, null, 'fabro.nix must declare the fabro.service wants list');
  assert.match(after[1], /"fabro-sandbox-image-load\.service"/);
  assert.match(wants[1], /"fabro-sandbox-image-load\.service"/);
});
