'use strict';

/*
 * validate.test.js — profile-validation + launch-contract verifier behaviour
 * for the opencode-nono-sandbox spec (Task 7.3). Exercises
 * `scripts/opencode-nono-validate.nix` (the `opencode-nono-validate`
 * writeShellApplication under test) end-to-end via `spawnSync` and asserts the
 * `[validate-failure: <label>]` / `[validate-ok]` contract (R6.2) for the happy
 * path plus every distinct failure label the script emits:
 *
 *   1. PASS              real three-profile catalog + real launcher → exit 0,
 *                        [validate-ok]                                   R6.2
 *   2. profile-invalid   a profile that fails `nono profile validate --strict`
 *                        (unknown group / malformed JSON) → exit 1         R6.2
 *   3. launch-contract   launcher with `nono run` but no `--allow-cwd`     R6.2
 *   4. grant-check-missing launcher with `profile show` + `nono run
 *                        --allow-cwd` but no `--json` grant check          R6.2
 *   5. launcher-missing  OPENCODE_NONO_VALIDATE_LAUNCHER → nonexistent path R6.2
 *   6. profile-runtime-parse a single FILE in a directory-only filesystem key
 *                        (allow/read/write) → `nono run --dry-run` aborts with
 *                        "is not a directory" though `nono profile validate`
 *                        passes (regression guard for the CFUserTextEncoding
 *                        bug); the same file under read_file passes the gate
 *
 * Requirements: 6.2.
 * Design: "Validation & Operator Domain → Profile Validation"; "Error Handling
 * → Error Categories and Responses → Validation (R6.2, 7.5)".
 *
 * The validate script and the PASS-case real launcher are built once via
 * `nix build --impure --expr` (the resolver.test.js flake/overlay preamble) and
 * cached across tests; the three real profiles are rendered from the committed
 * host config via `nix eval --raw` (the hm-render.test.js pattern). `nix`
 * works inside the `opencode-nono-tests` flake-check sandbox (macOS builds
 * aren't fully isolated) and `nono profile validate`/`profile schema` run
 * OFFLINE, so the in-sandbox real-nono run needs no network. Assertions key on
 * `result.status` + a `[validate-failure: <label>]` / `[validate-ok]` regex —
 * NOT on nono's banner text (an "update available" banner leaks onto stderr
 * but does not change the labeled contract).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const NIX_BUILD_TIMEOUT_MS = 600_000;
const NIX_EVAL_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 120_000;
const SYSTEM = 'aarch64-darwin';
const HOST = 'Brandons-MacBook-Pro';

// The committed catalog renders these three base profiles (R6.2 happy path).
const PROFILE_NAMES = Object.freeze(['opencode-managed', 'opencode-audit', 'opencode-review']);

// Standard flake/overlay preamble so `pkgs.nono` and `callPackage` resolve the
// same way the host build does (mirrors resolver.test.js).
function pkgsPreamble() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = "${SYSTEM}";
        overlays = [
          flake.outputs.overlays.unstable-packages
          flake.outputs.overlays.custom-packages
        ];
      };
    in
  `;
}

const VALIDATE_EXPR = `${pkgsPreamble()}
  pkgs.callPackage ${repoRoot}/scripts/opencode-nono-validate.nix { }
`;

// The REAL launcher (callPackage scripts/opencode-nono-launcher.nix) with the
// four stub seams substituted. Its rendered script text satisfies the full
// launch contract, so the PASS case keys on it.
const LAUNCHER_EXPR = `${pkgsPreamble()}
  pkgs.callPackage ${repoRoot}/scripts/opencode-nono-launcher.nix {
    basePackage = pkgs.writeShellScriptBin "opencode" "echo stub";
    preflightScript = "true";
    lspPath = "/dummy/lsp/bin";
    nono = pkgs.nono;
  }
`;

function nixBuildExpr(expr) {
  return childProcess
    .execFileSync('nix', ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_BUILD_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    })
    .trim()
    .split('\n')
    .pop();
}

// Read a rendered profile's JSON text straight off the committed host config
// (xdg.configFile), so the PASS case validates the REAL catalog the host ships.
function renderProfileText(name) {
  const expr = `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = flake.darwinConfigurations."${HOST}".config.home-manager.users.brandonmcnama;
    in
    hm.xdg.configFile."nono/profiles/${name}.json".text
  `;
  return childProcess.execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expr], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NIX_EVAL_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });
}

// One-time-built, cached artifacts (the slow first build is amortized).
const cache = {};

function validateBin() {
  if (!cache.validate) {
    cache.validate = path.join(nixBuildExpr(VALIDATE_EXPR), 'bin/opencode-nono-validate');
  }
  return cache.validate;
}

function realLauncherPath() {
  if (!cache.launcher) {
    cache.launcher = path.join(nixBuildExpr(LAUNCHER_EXPR), 'bin/opencode');
  }
  return cache.launcher;
}

// A temp profiles/ dir holding the REAL rendered three-profile catalog. Built
// once and reused by every test that needs a valid catalog (so the launcher /
// launch-contract cases don't trip the profile checks first).
function realProfilesDir() {
  if (!cache.profilesDir) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-profiles-'));
    for (const name of PROFILE_NAMES) {
      fs.writeFileSync(path.join(dir, `${name}.json`), renderProfileText(name));
    }
    cache.profilesDir = dir;
  }
  return cache.profilesDir;
}

// Run the built validate binary with a controlled env. OPENCODE_NONO_VALIDATE*
// and XDG_* keys are stripped from the inherited env first so an ambient var or
// the flake-check sandbox's XDG dirs cannot leak into a scenario.
function runValidate(env = {}) {
  const cleaned = { ...process.env };
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith('OPENCODE_NONO_VALIDATE') || key.startsWith('XDG_')) {
      delete cleaned[key];
    }
  }
  return childProcess.spawnSync(validateBin(), [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...cleaned, ...env },
    timeout: RUN_TIMEOUT_MS,
  });
}

// Write a stub launcher script to a fresh temp dir and return its path. Stubs
// carry only the launcher TEXT the script greps; they are never executed.
function writeStubLauncher(slug, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opencode-nono-validate-${slug}-`));
  scratchDirs.push(dir);
  const file = path.join(dir, 'opencode');
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

const scratchDirs = [];

test.after(() => {
  if (cache.profilesDir) {
    fs.rmSync(cache.profilesDir, { recursive: true, force: true });
  }
  for (const dir of scratchDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- Case 1: PASS — real catalog + real launcher → [validate-ok] ----------
test('valid catalog and a contract-complete launcher pass with [validate-ok] (R6.2)', () => {
  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: realProfilesDir(),
    OPENCODE_NONO_VALIDATE_LAUNCHER: realLauncherPath(),
  });
  const out = `${result.stderr}\n${result.stdout}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /\[validate-ok\]/);
  assert.doesNotMatch(out, /\[validate-failure:/);
});

// --- Case 2a: broken profile (unknown group) → profile-invalid ------------
test('a profile with an unknown group fails [validate-failure: profile-invalid] (R6.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-badgroup-'));
  scratchDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'opencode-managed.json'),
    JSON.stringify({
      meta: { name: 'opencode-managed', version: '0.1.0', description: 'x' },
      extends: ['default'],
      groups: { include: ['this_group_does_not_exist'] },
    }),
  );

  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: dir,
    OPENCODE_NONO_VALIDATE_LAUNCHER: realLauncherPath(),
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: profile-invalid\]/);
});

// --- Case 2b: broken profile (malformed JSON) → profile-invalid -----------
test('a malformed-JSON profile fails [validate-failure: profile-invalid] (R6.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-badjson-'));
  scratchDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'opencode-managed.json'), 'not json');

  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: dir,
    OPENCODE_NONO_VALIDATE_LAUNCHER: realLauncherPath(),
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: profile-invalid\]/);
});

// --- Case 3: launcher missing --allow-cwd → launch-contract ---------------
// `nono run` + both profile names are present so the missing flag is the only
// contract gap, isolating the launch-contract label.
test('a launcher missing --allow-cwd fails [validate-failure: launch-contract] (R6.2)', () => {
  const launcher = writeStubLauncher(
    'noallowcwd',
    '#!/bin/sh\nnono run opencode-managed opencode-audit\n',
  );
  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: realProfilesDir(),
    OPENCODE_NONO_VALIDATE_LAUNCHER: launcher,
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: launch-contract\]/);
});

// --- Case 4: launcher missing the grant check → grant-check-missing -------
// `profile show` precedes a complete `nono run --allow-cwd` with both profile
// names (so checks 3a-3c pass), but the grant check omits `--json` — the
// grant-check-missing branch.
test('a launcher missing the --json grant check fails [validate-failure: grant-check-missing] (R6.2)', () => {
  const launcher = writeStubLauncher(
    'nogrant',
    '#!/bin/sh\n'
      + 'nono profile show opencode-managed opencode-audit\n'
      + 'nono run --profile opencode-managed --allow-cwd -- opencode\n',
  );
  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: realProfilesDir(),
    OPENCODE_NONO_VALIDATE_LAUNCHER: launcher,
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: grant-check-missing\]/);
});

// --- Case 5: launcher path does not exist → launcher-missing --------------
test('a nonexistent launcher path fails [validate-failure: launcher-missing] (R6.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-nolauncher-'));
  scratchDirs.push(dir);
  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: realProfilesDir(),
    OPENCODE_NONO_VALIDATE_LAUNCHER: path.join(dir, 'does-not-exist'),
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: launcher-missing\]/);
});

// --- Case 6: a single FILE in filesystem.allow → profile-runtime-parse -----
// Regression guard for the CFUserTextEncoding bug. `nono profile validate`
// (Check 1) is schema-only and passes a file-in-allow profile, so this reaches
// Check 1b's `nono run --dry-run`, which aborts with "is not a directory".
// Two fixture requirements:
//   - the probe file MUST exist on disk (nono only rejects a directory-only
//     grant for a path that stats as a regular file; a nonexistent path
//     dry-runs clean), and
//   - `extends: []` (NOT the base "default") so the profile pulls no
//     system_read_macos /nix grant — otherwise, inside this nix build
//     sandbox, nono fails sandbox init on a /nix state-root overlap (the
//     gate's tolerant skip) before it ever reaches the single-file check.
test('a single file in filesystem.allow fails [validate-failure: profile-runtime-parse] (R6.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-fileinallow-'));
  scratchDirs.push(dir);
  const probeFile = path.join(dir, 'single-file');
  fs.writeFileSync(probeFile, '');
  fs.writeFileSync(
    path.join(dir, 'opencode-managed.json'),
    JSON.stringify({
      meta: { name: 'opencode-managed', version: '0.1.0', description: 'x' },
      extends: [],
      filesystem: { allow: [probeFile] },
    }),
  );

  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: dir,
    OPENCODE_NONO_VALIDATE_LAUNCHER: realLauncherPath(),
  });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /\[validate-failure: profile-runtime-parse\]/);
});

// --- Case 7: the SAME file under read_file passes the runtime-parse gate ---
// Non-vacuity in the correct direction: the gate rejects a single file only
// in a directory-only key, not in the proper single-file key. Same `extends:
// []` minimal profile as Case 6 (so nono sandbox init succeeds here); the
// one-profile catalog + the real launcher → schema, runtime-parse, and launch
// contract all pass → [validate-ok].
test('a single file under filesystem.read_file passes the runtime-parse gate with [validate-ok] (R6.2)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-validate-fileok-'));
  scratchDirs.push(dir);
  const probeFile = path.join(dir, 'single-file');
  fs.writeFileSync(probeFile, '');
  fs.writeFileSync(
    path.join(dir, 'opencode-managed.json'),
    JSON.stringify({
      meta: { name: 'opencode-managed', version: '0.1.0', description: 'x' },
      extends: [],
      filesystem: { read_file: [probeFile] },
    }),
  );

  const result = runValidate({
    OPENCODE_NONO_VALIDATE_PROFILES_DIR: dir,
    OPENCODE_NONO_VALIDATE_LAUNCHER: realLauncherPath(),
  });
  const out = `${result.stderr}\n${result.stdout}`;
  assert.equal(result.status, 0, out);
  assert.match(out, /\[validate-ok\]/);
  assert.doesNotMatch(out, /\[validate-failure:/);
});
