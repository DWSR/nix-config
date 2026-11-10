'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const readmePath = path.join(repoRoot, 'secrets/README.md');
const designPath = path.join(
  repoRoot,
  '.kiro/specs/create-a-linux-nix-remote-builder-instance/design.md',
);
const readme = fs.readFileSync(readmePath, 'utf8');

// Slice the Linux builder runbook out of the shared secrets README so the
// contract stays scoped to the section the spec's task 5.2 owns.
function linuxBuilderSection() {
  const heading = '\n## Linux builder host store';
  const start = readme.indexOf(heading);
  assert.notEqual(
    start,
    -1,
    'secrets/README.md must contain a "## Linux builder host store" section',
  );
  const sectionStart = start + 1;
  const end = readme.indexOf('\n## ', sectionStart + heading.length);
  return end === -1 ? readme.slice(sectionStart) : readme.slice(sectionStart, end);
}

function assertContains(text, needles) {
  for (const needle of needles) {
    assert.ok(
      text.includes(needle),
      `secrets/README.md must mention ${JSON.stringify(needle)}`,
    );
  }
}

test('documents the Linux builder store layout, sources, and recipients', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'secrets/remote-builder.linux-builder.yaml',
    'builder-authorized-keys',
    'builder-tailscale-oauth-secret',
    'secrets/linux-builder-client.personal.yaml',
    'linux-builder-client-key',
    'secrets/fabro.fabro.yaml',
    '&host_linux_builder',
    '&host_personal',
    'op://Private/sops-age-key-linux-builder/notesPlain',
    'op://Infrastructure/linux-builder authorized keys/notesPlain',
    'op://Infrastructure/linux-builder Tailscale OAuth/Client Secret',
    'op://Infrastructure/Fabro Linux nix remote builder key/private key',
    'op://Infrastructure/Brandons Mac Linux nix remote builder key/private key',
  ]);
  assert.match(text, /fails closed/i, 'the empty .sops.yaml recipient list must be explained');
});

test('documents the bootstrap order and the builder sync commands', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    "nix run '.#linux-builder-sync-from-1password'",
    "nix run '.#fabro-sync-from-1password'",
    'linux-builder-deploy',
    '/var/lib/sops-nix/key.txt',
    'op signin',
  ]);
  assert.match(
    text,
    /age key[\s\S]{0,4000}linux-builder-deploy/i,
    'the builder age key must be installed in the guest before the first deploy',
  );
  assert.match(text, /exit code/i, 'sync exit codes must be documented');
  assert.match(
    text,
    /(never|does not) (mints?|generates?|rotates?)/i,
    'the sync command must be documented as never minting or generating values',
  );
});

test('documents the builder Tailscale credential, tag ownership, and SSH-only grants', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'tag:linux-nix-remote-builder',
    'tagOwners',
    'autogroup:admin',
    'tcp:22',
    'tag:fabro',
    'auth_keys',
    'builder-tailscale-auth',
    '/run/secrets/builder-tailscale-oauth-secret',
    'linux-builder.tuxedo-musical.ts.net',
    'TailscaleIPs',
  ]);
  assert.match(text, /admin console/i);
  assert.match(
    text,
    /(not|outside)[^.\n]*repository/i,
    'tailnet ACL changes must be described as external, not repository configuration',
  );
});

test('documents runtime consumption and secret-safe verification', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    '/run/secrets/builder-authorized-keys',
    '/home/builder/.ssh/authorized_keys',
    '/run/secrets/linux-builder-client-key',
    'builder-authorized-keys.service',
    'sops -d --extract',
    'ssh-keygen -y',
    'systemctl is-active',
    'tailscale status --json',
  ]);
});

test('documents host-key pin capture and verification', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'certificates/linux-builder/ssh_host_ed25519_key.pub',
    '/var/lib/ssh/ssh_host_ed25519_key',
    'ssh-keygen -lf',
  ]);
  assert.match(text, /private host key/i);
  assert.match(
    text,
    /(never|not)[^.\n]*commit[^.\n]*private/i,
    'the runbook must forbid committing the private host key',
  );
  assert.match(
    text,
    /(hard failure|fails closed)/i,
    'a host-key pin mismatch must be documented as a hard failure',
  );
});

test('documents the post-provisioning live acceptance sequence', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'lima-vmctl shell fabro',
    '--no-link --print-out-paths',
    'aarch64-linux',
    'aarch64-darwin',
    'x86_64-linux',
    'lima-vmctl stop linux-builder',
    'max-jobs',
  ]);
  assert.match(text, /test -e/, 'the acceptance check must confirm the output on the builder');
  assert.match(
    text,
    /no local (build|fallback)/i,
    "Fabro's no-local-fallback behavior must be documented",
  );
});

test('points operators at the design Operator Provisioning section', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    '.kiro/specs/create-a-linux-nix-remote-builder-instance/design.md',
    '## Operator Provisioning',
  ]);
  const design = fs.readFileSync(designPath, 'utf8');
  assert.match(design, /^## Operator Provisioning$/m);
});

test('records no private key or credential values', () => {
  assert.doesNotMatch(readme, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  assert.doesNotMatch(readme, /AGE-SECRET-KEY-1[0-9A-Za-z]{20,}/);
  assert.doesNotMatch(readme, /tskey-[A-Za-z0-9]{10,}/);
});
