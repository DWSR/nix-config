'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const sandboxPath = path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix');
const fabroPath = path.join(repoRoot, 'configurations/fabro-vm/fabro.nix');

// The loader unit lives in sandbox.nix; read the module text so the
// assertions do not depend on a Linux builder or a full NixOS evaluation
// (the same source-level pattern loader.test.js uses for the script).
function readSandbox() {
  return fs.readFileSync(sandboxPath, 'utf8');
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

test('fabro.service is ordered after and wants the loader', () => {
  const fabro = fs.readFileSync(fabroPath, 'utf8');
  const after = fabro.match(/after = \[([^\]]*)\]/);
  const wants = fabro.match(/wants = \[([^\]]*)\]/);
  assert.notEqual(after, null, 'fabro.nix must declare the fabro.service after list');
  assert.notEqual(wants, null, 'fabro.nix must declare the fabro.service wants list');
  assert.match(after[1], /"fabro-sandbox-image-load\.service"/);
  assert.match(wants[1], /"fabro-sandbox-image-load\.service"/);
});

// The reconciler unit also lives in sandbox.nix. Extract its block (from the
// declaration to the next `systemd.services.` entry, or end of file) so the
// assertions are scoped to the reconciler and not the loader.
function reconcilerBlock() {
  const src = readSandbox();
  const start = src.indexOf('systemd.services."fabro-sandbox-env"');
  assert.notEqual(start, -1, 'sandbox.nix must declare the fabro-sandbox-env unit');
  const next = src.indexOf('systemd.services.', start + 1);
  return src.slice(start, next === -1 ? src.length : next);
}

// Pull one `key = [ ... ]` list out of a unit block. `[^\]]*` spans newlines
// and tolerates the one-item-per-line rendering the units use.
function serviceList(block, key) {
  const match = block.match(new RegExp(`${key} = \\[([^\\]]*)\\]`));
  assert.notEqual(match, null, `reconciler unit must declare a ${key} list`);
  return match[1];
}

test('sandbox.nix declares the reconciler unit as a fabro-gated oneshot', () => {
  const block = reconcilerBlock();
  assert.match(block, /Type = "oneshot"/);
  assert.match(block, /RemainAfterExit = true/);
  assert.match(block, /wantedBy = \[ "multi-user\.target" \]/);

  // Ordered after and hard-requiring both the Fabro API and the image loader:
  // the environments API is served by fabro.service and the declared digest
  // is recorded by the loader, so both must be up first.
  const after = serviceList(block, 'after');
  assert.match(after, /"fabro\.service"/);
  assert.match(after, /"fabro-sandbox-image-load\.service"/);

  const requires = serviceList(block, 'requires');
  assert.match(requires, /"fabro\.service"/);
  assert.match(requires, /"fabro-sandbox-image-load\.service"/);
});

test('reconciler unit consumes the sops fabro-env template as root', () => {
  const block = reconcilerBlock();
  // FABRO_DEV_TOKEN comes from the sops-rendered fabro-env file.
  assert.match(block, /EnvironmentFile = config\.sops\.templates\."fabro-env"\.path;/);
  // The digest is read at run time, so the unit only runs the reconcile script.
  assert.match(block, /ExecStart = .*reconcileScript/);
  // No `User =` override: the reconciler runs as root (the default).
  assert.doesNotMatch(block, /\bUser = /);
});
