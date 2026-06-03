/*
 * redactor.test.js — unit test for the secret redactor (Task 2.3,
 * Requirement 1.7).
 *
 * Observable completion (task 2.3): feed secret-bearing strings and
 * assert ALL are masked AND that the secret LITERAL is absent from the
 * output, while ordinary non-secret strings (paths, flags, credential-
 * free URLs) survive essentially intact.
 *
 * 2.3 delivers ONLY the exported `redact()` function in
 * scripts/opencode-nono-audit.js. Wiring redaction into runAudit /
 * serialization ("on by default") is the Reporter's job (task 5.1) and
 * is intentionally NOT exercised here.
 *
 * Fake-secret convention: every secret literal below is obviously
 * synthetic (FAKE / 000…) so this fixture never embeds a real
 * credential, mirroring the fixture style used by make-fixtures.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { redact } = require('../../../scripts/opencode-nono-audit.js');

// A single consistent mask token is used by the implementation; we
// assert on "secret literal is gone" rather than on the exact token so
// the test does not over-couple to the chosen sentinel. We still assert
// SOME masking occurred (output differs from input) for positive cases.

test('redact masks userinfo credentials embedded in a URL', () => {
  const secret = 'FAKE_SECRET_PW';
  const input = `https://user:${secret}@example.invalid/x`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `password literal must be masked: ${out}`);
  // host/scheme/path structure preserved for usefulness.
  assert.ok(out.includes('example.invalid'), `host preserved: ${out}`);
  assert.ok(out.startsWith('https://'), `scheme preserved: ${out}`);
});

test('redact masks a KEY=VALUE env secret but keeps the KEY', () => {
  const secret = 'ghp_FAKE000000000000000000000000000000';
  const input = `TOKEN=${secret}`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `token body must be masked: ${out}`);
  assert.ok(/^TOKEN=/.test(out), `TOKEN key must remain: ${out}`);
});

test('redact masks a Bearer GitHub token inside a command string', () => {
  const secret = 'ghp_FAKE000000000000000000000000000000';
  const input = `curl -H 'Authorization: Bearer ${secret}' https://example.invalid`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `bearer token must be masked: ${out}`);
  // surrounding command structure preserved.
  assert.ok(out.includes('curl'), `command preserved: ${out}`);
});

test('redact masks an OpenAI sk- token embedded in a command', () => {
  const secret = 'sk-FAKE0000000000000000000000000000000000000000000000';
  const input = `export OPENAI=${secret} && run`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `sk- token must be masked: ${out}`);
});

test('redact masks an AWS access key id embedded in a command', () => {
  const secret = 'AKIAFAKE0000000000AB';
  const input = `aws --access-key ${secret} s3 ls`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `AWS key must be masked: ${out}`);
});

test('redact masks a token/api_key/access_token query parameter value', () => {
  const secret = 'FAKEKEY123456789012345678901234567890';
  const input = `https://example.invalid/v1?api_key=${secret}&page=1`;
  const out = redact(input);
  assert.ok(!out.includes(secret), `api_key value must be masked: ${out}`);
  // non-secret query structure preserved.
  assert.ok(out.includes('page=1'), `non-secret param preserved: ${out}`);
  assert.ok(out.includes('api_key='), `api_key key preserved: ${out}`);
});

// ── NEGATIVE cases: must NOT be over-masked ─────────────────────────

test('redact leaves a non-secret KEY=VALUE intact', () => {
  assert.equal(redact('PATH=/usr/bin'), 'PATH=/usr/bin');
  assert.equal(redact('HOME=/Users/x'), 'HOME=/Users/x');
  assert.equal(redact('FORMAT=json'), 'FORMAT=json');
});

test('redact leaves an ordinary flag intact', () => {
  assert.equal(redact('--format json'), '--format json');
});

test('redact leaves a credential-free URL intact', () => {
  const url = 'https://example.invalid/docs';
  assert.equal(redact(url), url);
});

test('redact leaves an ordinary file path intact', () => {
  const p = '/Users/x/src/index.js';
  assert.equal(redact(p), p);
});

// ── NEGATIVE regression: long secret-free strings must survive ──────
// Guards the over-masking class (finding 1): the prior HIGH_ENTROPY_BLOB
// rule masked any whitespace-free run ≥32 chars over the [A-Za-z0-9+/_-]
// alphabet, destroying legitimate paths / URLs / SHAs that are exactly
// the `paths`/`endpoints` fields the report exists to surface
// (design.md:248,250). These are the four concrete finding-1 inputs.

test('redact leaves the audit script\'s own long absolute path intact', () => {
  const p =
    '/Users/brandonmcnama/src/github.com/DWSR/nix-config/scripts/opencode-nono-audit.js';
  assert.equal(redact(p), p);
});

test('redact leaves a long clean API endpoint URL intact', () => {
  const url = 'https://api.github.com/repos/DWSR/nix-config/commits';
  assert.equal(redact(url), url);
});

test('redact leaves a Nix store path intact', () => {
  const p = '/nix/store/abcdefghijklmnopqrstuvwxyz012345-nodejs-22.21.1';
  assert.equal(redact(p), p);
});

test('redact leaves a "commit <40-char SHA>" string intact', () => {
  const s = 'commit 5f3a9b2c8d1e4f6a7b0c9d8e2f1a3b4c5d6e7f80';
  assert.equal(redact(s), s);
});

// ── Idempotency ─────────────────────────────────────────────────────

test('redact is idempotent: redact(redact(s)) === redact(s)', () => {
  const samples = [
    'https://user:FAKE_SECRET_PW@example.invalid/x',
    'TOKEN=ghp_FAKE000000000000000000000000000000',
    "curl -H 'Authorization: Bearer ghp_FAKE000000000000000000000000000000'",
    'https://example.invalid/v1?api_key=FAKEKEY123456789012345678901234567890',
    'PATH=/usr/bin',
    '/Users/x/src/index.js',
  ];
  for (const s of samples) {
    const once = redact(s);
    assert.equal(redact(once), once, `not idempotent for: ${s}`);
  }
});

test('redact on an already-clean string returns it unchanged', () => {
  const clean = 'echo hello world';
  assert.equal(redact(clean), clean);
});

// ── Defensive on bad input ──────────────────────────────────────────

test('redact does not throw on non-string / empty / undefined input', () => {
  assert.doesNotThrow(() => redact(undefined));
  assert.doesNotThrow(() => redact(null));
  assert.doesNotThrow(() => redact(123));
  assert.doesNotThrow(() => redact({}));
  assert.doesNotThrow(() => redact(''));
  assert.equal(redact(''), '');
});
