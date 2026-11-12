'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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

// Extract the builder sync invocation so the contract can resolve it instead
// of trusting that the documented command text exists. The flake does not
// register the builder sync as an app, so the runbook documents the checked-in
// script through the pinned nixpkgs expression.
function builderSyncInvocation() {
  const text = linuxBuilderSection();
  const match = text.match(/nix shell --impure --expr '([\s\S]*?)'\s*\\\n\s*-c (\S+)/);
  assert.ok(
    match,
    'the Linux builder runbook must document the sync command as a ' +
      '`nix shell --impure --expr` invocation that ends in `-c <program>`',
  );
  return { expression: match[1], program: match[2] };
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
    'op://Infrastructure/mac-builder authorized keys/notesPlain',
    'op://Infrastructure/mac-builder Tailscale OAuth/Client Secret',
    'op://Infrastructure/Fabro Linux nix remote builder key/private key',
    'op://Infrastructure/Brandons Mac Linux nix remote builder key/private key',
  ]);
  assert.match(text, /fails closed/i, 'the empty .sops.yaml recipient list must be explained');
});

test('documents the bootstrap order and the builder sync commands', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'linux-builder-sync-from-1password',
    'Syncing the stores from 1Password',
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

test('the documented builder sync command resolves to the checked-in script', () => {
  const { expression, program } = builderSyncInvocation();
  assert.equal(
    program,
    'linux-builder-sync-from-1password',
    'the documented command must run the builder sync program',
  );
  assert.match(
    expression,
    /scripts\/linux-builder-sync-from-1password\.nix/,
    'the documented invocation must import the checked-in sync script',
  );
  assert.match(
    expression,
    /builtins\.getFlake/,
    'the documented invocation must resolve the flake inputs',
  );
  assert.match(
    expression,
    /allowUnfree = true/,
    'the documented invocation needs allowUnfree for the _1password-cli runtime input',
  );
  assert.doesNotMatch(
    readme,
    /nix run ['"]?\.#linux-builder-sync-from-1password/,
    'the flake does not register a linux-builder-sync-from-1password app, ' +
      'so the runbook must not document `nix run` for it',
  );

  // The script's derivation name is the program the documented -c runs; keep
  // the two in lockstep, then let Nix resolve the documented expression.
  const script = fs.readFileSync(
    path.join(repoRoot, 'scripts/linux-builder-sync-from-1password.nix'),
    'utf8',
  );
  assert.match(
    script,
    new RegExp(`name = "${program}";`),
    `scripts/linux-builder-sync-from-1password.nix must produce ${program}`,
  );

  const resolved = childProcess.execFileSync(
    'nix',
    ['eval', '--raw', '--impure', '--expr', `(${expression}).meta.mainProgram`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  ).trim();
  assert.equal(
    resolved,
    program,
    'the documented invocation must resolve to the builder sync program',
  );
});

test('documents the builder Tailscale credential, tag ownership, and SSH-only grants', () => {
  const text = linuxBuilderSection();
  assertContains(text, [
    'tag:nix-remote-builder',
    'auth_keys',
    'builder-tailscale-auth',
    '/run/secrets/builder-tailscale-oauth-secret',
    'linux-builder.tuxedo-musical.ts.net',
  ]);
  assert.match(text, /shared/i, 'the runbook must note the tag is shared with the mac builder');
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
