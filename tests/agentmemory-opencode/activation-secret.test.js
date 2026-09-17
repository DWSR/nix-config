'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '../..');
const reportNixPath = path.join(__dirname, 'personal-secret-validation.nix');
const activationProofNixPath = path.join(__dirname, 'missing-secret-activation.nix');
const activatorNixPath = path.join(repoRoot, 'scripts', 'mcp-secrets-activate.nix');
const activatorSource = fs.readFileSync(activatorNixPath, 'utf8');

function buildExpression(expression) {
  return execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expression],
    { cwd: repoRoot, encoding: 'utf8', timeout: 600_000 },
  ).trim().split('\n').at(-1);
}

function validationReportPath() {
  if (process.env.AGENTMEMORY_PERSONAL_SECRET_VALIDATION) {
    return process.env.AGENTMEMORY_PERSONAL_SECRET_VALIDATION;
  }
  return buildExpression(`let
    flake = builtins.getFlake ${JSON.stringify(`path:${repoRoot}`)};
    pkgs = import flake.inputs.nixpkgs {
      system = "aarch64-darwin";
      config.allowUnfree = true;
      overlays = [
        flake.outputs.overlays.unstable-packages
        flake.outputs.overlays.custom-packages
      ];
    };
  in import ${JSON.stringify(reportNixPath)} { inherit pkgs; self = flake; }`);
}

function activationProofPath() {
  if (process.env.AGENTMEMORY_MISSING_SECRET_ACTIVATION_PROOF) {
    return process.env.AGENTMEMORY_MISSING_SECRET_ACTIVATION_PROOF;
  }
  return buildExpression(`let
    flake = builtins.getFlake ${JSON.stringify(`path:${repoRoot}`)};
    pkgs = import flake.inputs.nixpkgs { system = "aarch64-darwin"; };
    activator = pkgs.callPackage ${JSON.stringify(activatorNixPath)} { };
  in import ${JSON.stringify(activationProofNixPath)} { inherit activator pkgs; }`);
}

test('personal evaluation renders the bearer secret contract without ciphertext', () => {
  const report = JSON.parse(fs.readFileSync(validationReportPath(), 'utf8'));

  for (const rendered of [report.normal, report.withoutCiphertext]) {
    assert.equal(rendered.activationUsesSecretBridge, true);
    assert.equal(rendered.bearerReference, 'agentmemory-bearer');
    assert.equal(rendered.keychainReference, 'op://Private/AgentMemory/Bearer');
    assert.equal(rendered.secretPath, '/run/secrets/agentmemory-bearer');
    assert.equal(rendered.validateSopsFiles, false);
  }
  assert.match(report.normal.sopsFile, /\/secrets\/mcp\.personal\.yaml$/);
  assert.match(
    report.withoutCiphertext.sopsFile,
    /\/tests\/agentmemory-opencode\/fixtures\/missing-agentmemory-bearer\.yaml$/,
  );
});

test('personal activation fails before mutation when the bearer secret is not provisioned', () => {
  const proof = fs.readFileSync(activationProofPath(), 'utf8');

  assert.match(proof, /^activation_status=1$/m);
  assert.match(proof, /\/run\/secrets\/agentmemory-bearer does not exist/);
  assert.doesNotMatch(proof, /add-generic-password|gh auth login/);
});

test('activation retries transient login-keychain failures', () => {
  assert.match(activatorSource, /write_keychain_entry\(\)/);
  assert.match(activatorSource, /while \[ "\$attempts" -lt 15 \]/);
  assert.match(activatorSource, /login keychain.*locked/i);
  assert.match(activatorSource, /login\.keychain-db/);
});
