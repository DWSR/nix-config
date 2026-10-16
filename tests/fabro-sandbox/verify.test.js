'use strict';

/*
 * tests/fabro-sandbox/verify.test.js — subcommand contract for
 * `fabro-sandbox-verify` (nix-built-container-for-default-fabro-environmen
 * spec, task 7.5; Requirements 2.1, 3.1, 4.2, 6.3, 6.4).
 *
 * Task 7.5 is the end-to-end verification stage: build the image twice and
 * confirm the digest is unchanged (2.1), confirm the loader recorded the digest
 * and the reconciler pointed Fabro's `default` environment at the digest
 * reference (3.1, 4.2), and run the tools/store/daemon smoke check (6.3, 6.4).
 * `scripts/fabro-sandbox-verify.nix` packages that operator runbook as a
 * single executable so the checks are reproducible instead of ad-hoc shell.
 *
 * What this file tests (behaviourally, by building the script with fakes for
 * the live host tools and driving each subcommand):
 *
 *   - `--help` exits 0 and documents every subcommand + env override.
 *   - `--version` exits 0 (release identity).
 *   - An unknown subcommand fails with `[verify-failure: invalid_arguments]`.
 *   - `reproducibility` passes when the digest file matches the archive's
 *     index.json and the derivation rebuilds bit-identically, and fails with
 *     `digest_mismatch` / `not_reproducible` otherwise.
 *   - `wiring` passes when the recorded digest resolves to the persisted
 *     `default` environment reference, and fails with `digest_missing`,
 *     `token_missing`, and `reference_mismatch` on the corresponding faults.
 *   - `smoke` fails with `smoke_failed` when the smoke script exits non-zero.
 *   - `all` runs reproducibility + wiring + smoke in order.
 *
 * What this file does NOT test:
 *
 *   - The real `podman load`/`nix store ping`/Fabro API round trips; those
 *     require a switched guest and are exercised by `fabro-sandbox-smoke`
 *     itself plus the operator's `fabro-sandbox-verify all` run.
 *
 * The fakes are injected through the script's callPackage arguments (nix,
 * curl) and env overrides (`FABRO_SANDBOX_ARCHIVE`,
 * `FABRO_SANDBOX_DIGEST_PATH`, `FABRO_SANDBOX_DIGEST_FILE`,
 * `FABRO_SANDBOX_SMOKE_BIN`, and the `FABRO_VERIFY_FAKE_*` knobs the fakes
 * read), so the assertions exercise the real script logic without a live host.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

const IMAGE_NAME = 'localhost/fabro-sandbox';
const MATCHING_DIGEST =
  'sha256:0000000000000000000000000000000000000000000000000000000000000000';
const OTHER_DIGEST =
  'sha256:1111111111111111111111111111111111111111111111111111111111111111';

let verifyBinary;

function buildVerifyBinary() {
  if (verifyBinary) {
    return verifyBinary;
  }

  // Build the verifier against fakes for the live host tools so the test
  // exercises the script's argument parsing, digest comparison, API
  // comparison, and failure labels without podman, the Fabro API, or a
  // switched guest. `gnutar`, `jq`, and `coreutils` stay real (the script
  // reads a real tar + JSON), while `nix` and `curl` are scripted.
  const expr = `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };

      # Scripted nix-store: --query --deriver reports a stable .drv and
      # --realise exits 0 unless --check is requested and the test flips
      # FABRO_VERIFY_FAKE_CHECK_EXIT to model a non-reproducible build.
      fakeNix = pkgs.writeShellApplication {
        name = "nix-store";
        text = ''
          case "''\${1:-}" in
            --query)
              printf '%s\\n' "/nix/store/fake-sandbox-archive.drv"
              ;;
            --realise)
              for arg in "$@"; do
                if [ "$arg" = "--check" ]; then
                  exit "''\${FABRO_VERIFY_FAKE_CHECK_EXIT:-0}"
                fi
              done
              exit 0
              ;;
          esac
          exit 0
        '';
      };

      # Scripted curl: writes FABRO_VERIFY_FAKE_CURL_BODY to the -o target and
      # prints FABRO_VERIFY_FAKE_CURL_STATUS as the HTTP status.
      fakeCurl = pkgs.writeShellApplication {
        name = "curl";
        text = ''
          out=""
          while [ "$#" -gt 0 ]; do
            case "$1" in
              -o) out="$2"; shift 2 ;;
              -w) shift 2 ;;
              -H) shift 2 ;;
              *) shift ;;
            esac
          done
          if [ -n "''\${FABRO_VERIFY_FAKE_CURL_BODY:-}" ] && [ -n "$out" ]; then
            cp "''\${FABRO_VERIFY_FAKE_CURL_BODY}" "$out"
          fi
          printf '%s' "''\${FABRO_VERIFY_FAKE_CURL_STATUS:-200}"
          exit "''\${FABRO_VERIFY_FAKE_CURL_EXIT:-0}"
        '';
      };

      fakeSmoke = pkgs.writeShellApplication {
        name = "fabro-sandbox-smoke";
        text = ''
          exit 0
        '';
      };

      # A real single-entry OCI index tar so the script's tar -xOf / jq
      # digest extraction runs for real.
      fakeArchive = pkgs.runCommand "fake-sandbox-archive.tar" {
        nativeBuildInputs = [ pkgs.gnutar ];
      } ''
        mkdir -p tree
        printf '%s' '{"schemaVersion":2,"manifests":[{"digest":"${MATCHING_DIGEST}"}]}' > tree/index.json
        ( cd tree && tar -cf "$out" index.json )
      '';

      fakeDigest = pkgs.writeText "fake-sandbox-digest" "${MATCHING_DIGEST}";
    in
    pkgs.callPackage ./scripts/fabro-sandbox-verify.nix {
      name = "${IMAGE_NAME}";
      archive = fakeArchive;
      digest = fakeDigest;
      nix = fakeNix;
      curl = fakeCurl;
      smoke = fakeSmoke;
    }
  `;

  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 300_000,
    },
  ).trim();
  verifyBinary = path.join(outPath, 'bin', 'fabro-sandbox-verify');
  return verifyBinary;
}

function runVerify(args, env = {}) {
  return childProcess.spawnSync(buildVerifyBinary(), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: os.tmpdir(),
      ...env,
    },
    timeout: 60_000,
  });
}

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-sandbox-verify-'));
}

function writeFile(dir, name, contents) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents);
  return file;
}

function writeExecutable(dir, name, contents) {
  const file = writeFile(dir, name, contents);
  fs.chmodSync(file, 0o755);
  return file;
}

// The recorded digest file the loader writes and the reconciler reads.
function digestFile(dir, digest = MATCHING_DIGEST) {
  return writeFile(dir, 'digest', `${digest}\n`);
}

// The persisted `default` environment JSON the environments API returns.
function environmentBody(dir, docker) {
  return writeFile(
    dir,
    'environment.json',
    `${JSON.stringify({ id: 'default', revision: '1', image: { docker } })}\n`,
  );
}

test('fabro-sandbox-verify --help exits 0 and documents the subcommands and overrides', () => {
  const result = runVerify(['--help']);

  assert.equal(result.status, 0, result.stderr);
  const helpText = result.stdout + result.stderr;
  for (const subcommand of ['reproducibility', 'wiring', 'smoke', 'all']) {
    assert.match(helpText, new RegExp(subcommand), `help must document ${subcommand}`);
  }
  // The operator must be able to retarget every host-specific input from the
  // help alone (the guest's store paths and API base).
  for (const variable of [
    'FABRO_SANDBOX_ARCHIVE',
    'FABRO_SANDBOX_DIGEST_PATH',
    'FABRO_SANDBOX_DIGEST_FILE',
    'FABRO_API_BASE',
    'FABRO_DEV_TOKEN',
    'FABRO_SANDBOX_SMOKE_BIN',
  ]) {
    assert.match(helpText, new RegExp(variable), `help must document ${variable}`);
  }
});

test('fabro-sandbox-verify --version exits 0', () => {
  const result = runVerify(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /fabro-sandbox-verify \d+\.\d+\.\d+/);
});

test('fabro-sandbox-verify fails with invalid_arguments on an unknown subcommand', () => {
  const result = runVerify(['totally-bogus-verb']);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[verify-failure: invalid_arguments\]/);
});

test('reproducibility passes when the digest matches and the archive rebuilds identically', () => {
  // The baked archive and digest fixtures agree, and the scripted nix-store
  // rebuild (--check) exits 0, so the check passes without any overrides.
  const result = runVerify(['reproducibility']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\[reproducibility\]/);
});

test('reproducibility fails with digest_mismatch when the declared digest differs', () => {
  const dir = makeTempDir();
  try {
    const mismatched = writeFile(dir, 'digest-mismatch', `${OTHER_DIGEST}\n`);
    const result = runVerify(['reproducibility'], {
      FABRO_SANDBOX_DIGEST_PATH: mismatched,
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[verify-failure: digest_mismatch\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reproducibility fails with not_reproducible when the rebuild differs', () => {
  const result = runVerify(['reproducibility'], {
    FABRO_VERIFY_FAKE_CHECK_EXIT: '1',
  });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[verify-failure: not_reproducible\]/);
});

test('wiring passes when the default environment references the recorded digest', () => {
  const dir = makeTempDir();
  try {
    const result = runVerify(['wiring'], {
      FABRO_SANDBOX_DIGEST_FILE: digestFile(dir),
      FABRO_DEV_TOKEN: 'test-token',
      FABRO_VERIFY_FAKE_CURL_BODY: environmentBody(
        dir,
        `${IMAGE_NAME}@${MATCHING_DIGEST}`,
      ),
      FABRO_VERIFY_FAKE_CURL_STATUS: '200',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[wiring\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring fails with reference_mismatch when the persisted reference differs', () => {
  const dir = makeTempDir();
  try {
    const result = runVerify(['wiring'], {
      FABRO_SANDBOX_DIGEST_FILE: digestFile(dir),
      FABRO_DEV_TOKEN: 'test-token',
      FABRO_VERIFY_FAKE_CURL_BODY: environmentBody(
        dir,
        `${IMAGE_NAME}@${OTHER_DIGEST}`,
      ),
      FABRO_VERIFY_FAKE_CURL_STATUS: '200',
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[verify-failure: reference_mismatch\]/);
    assert.match(result.stderr, /declared=/);
    assert.match(result.stderr, /persisted=/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring fails with digest_missing when the loader recorded no digest', () => {
  const dir = makeTempDir();
  try {
    const result = runVerify(['wiring'], {
      FABRO_SANDBOX_DIGEST_FILE: path.join(dir, 'absent-digest'),
      FABRO_DEV_TOKEN: 'test-token',
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[verify-failure: digest_missing\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('wiring fails with token_missing when FABRO_DEV_TOKEN is unset', () => {
  const dir = makeTempDir();
  try {
    const result = runVerify(['wiring'], {
      FABRO_SANDBOX_DIGEST_FILE: digestFile(dir),
    });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[verify-failure: token_missing\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke passes when the smoke script succeeds', () => {
  const dir = makeTempDir();
  try {
    const smoke = writeExecutable(dir, 'smoke-pass', '#!/bin/sh\nexit 0\n');
    const result = runVerify(['smoke'], { FABRO_SANDBOX_SMOKE_BIN: smoke });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[smoke\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke fails with smoke_failed when the smoke script exits non-zero', () => {
  const dir = makeTempDir();
  try {
    const smoke = writeExecutable(dir, 'smoke-fail', '#!/bin/sh\nexit 1\n');
    const result = runVerify(['smoke'], { FABRO_SANDBOX_SMOKE_BIN: smoke });
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /\[verify-failure: smoke_failed\]/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('all runs reproducibility, wiring, and smoke', () => {
  const dir = makeTempDir();
  try {
    const result = runVerify(['all'], {
      FABRO_SANDBOX_DIGEST_FILE: digestFile(dir),
      FABRO_DEV_TOKEN: 'test-token',
      FABRO_VERIFY_FAKE_CURL_BODY: environmentBody(
        dir,
        `${IMAGE_NAME}@${MATCHING_DIGEST}`,
      ),
      FABRO_VERIFY_FAKE_CURL_STATUS: '200',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /\[reproducibility\]/);
    assert.match(result.stdout, /\[wiring\]/);
    assert.match(result.stdout, /\[smoke\]/);
    assert.match(result.stdout, /all checks passed/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the guest installs the verifier in environment.systemPackages', () => {
  const src = fs.readFileSync(
    path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix'),
    'utf8',
  );
  assert.match(src, /scripts\/fabro-sandbox-verify\.nix/);
  const block = src.match(/environment\.systemPackages = \[([\s\S]*?)\]/);
  assert.notEqual(block, null, 'sandbox.nix must set environment.systemPackages');
  assert.match(block[1], /\bverifyScript\b/);
  assert.match(block[1], /\bsmokeScript\b/);
});
