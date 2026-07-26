'use strict';

/*
 * resolver.test.js — state-resolver behaviour assertions for the
 * opencode-nono-sandbox spec (Task 7.2). Builds stub launcher variants from
 * `scripts/opencode-nono-launcher.nix` (the resolver under test) via
 * `nix build --impure --expr`, then runs each variant's `bin/opencode`
 * under controlled env to enumerate EVERY state-resolver branch:
 *
 *   1.  default disabled (host-default reason, no nono exec)        R1.5/R3.1
 *   2.  OPENCODE_NONO=disabled (override reason)                    R3.2
 *   3.  OPENCODE_NONO=audit (exec nono run --profile opencode-audit) R3.2
 *   4.  OPENCODE_NONO=enforced (--profile opencode-managed)         R3.2
 *   5.  OPENCODE_NONO_PROFILE override (explicit profile name)      R3.2
 *   6.  invalid override (exit 1, accepted-values stderr)          R3.3
 *   7.  missing-nono fail-closed (exit 1, no opencode launch)       R1.4
 *   8.  rollback under enforced host default                       R3.4
 *   9.  grant-check missing-grant (exit 1, names the grant)        R4.4
 *   10. freshness-marker absent (warn, exit 0, still execs)        R3.5
 *
 * Requirements: 1.4, 1.5, 3.2, 3.3, 3.4, 3.5, 4.4.
 * Design: "State Resolver / Outer Launcher" (State Resolver, State Management,
 * Env Contract table).
 *
 * The stub `basePackage` and stub `nono` print recognizable marker lines
 * (`OPENCODE eff=… args=…` / `NONO args=…`) instead of really launching
 * opencode or really sandboxing, so the assertions key on exec SHAPE and the
 * exported env contract — not real sandbox behaviour. `nix build` works inside
 * the `opencode-nono-tests` flake-check sandbox (macOS builds aren't fully
 * isolated); the first build is slow, so the four stub variants are built once
 * and cached across scenarios.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const NIX_BUILD_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 120_000;
const SYSTEM = 'aarch64-darwin';

// Stub basePackage: a `bin/opencode` that echoes the exported env contract and
// its argv. Lets every disabled-path / exec-shape assertion key on one line.
// Body is a Nix `''…''` indented string: `"` is literal, `\n` stays a literal
// backslash-n for printf, and shell `$VAR` must be written `''${VAR}` so Nix
// does not try to interpolate it.
const BASE_PACKAGE_EXPR = `pkgs.writeShellScriptBin "opencode" ''
  printf "OPENCODE eff=%s prof=%s reason=%s tag=%s args=%s\\n" \\
    "''\${OPENCODE_NONO_EFFECTIVE}" "''\${OPENCODE_NONO_PROFILE_EFFECTIVE}" \\
    "''\${OPENCODE_NONO_DISABLE_REASON}" "''\${OPENCODE_NONO_USAGE_TAG}" "''\${*}"
''`;

// Stub nono whose `profile show … --json --silent` prints controlled JSON on
// stdout and whose `run …` prints a recognizable `NONO args=…` line (so the
// exec'd shape is observable WITHOUT really sandboxing). The grant-check JSON
// is parameterized so the ok / missing-grant variants share one builder. The
// JSON is single-quoted inside the shell body so its `"`/`$` are inert.
function nonoStubExpr(grantJson) {
  return `pkgs.writeShellScriptBin "nono" ''
    if [ "''\${1}" = "profile" ] && [ "''\${2}" = "show" ]; then
      printf '%s\\n' '${grantJson}'
      exit 0
    fi
    if [ "''\${1}" = "run" ]; then
      printf "NONO args=%s no-save-prompt=%s\\n" "''\${*}" "''\${NONO_NO_SAVE_PROMPT:-}"
      exit 0
    fi
    printf "NONO unexpected args=%s\\n" "''\${*}" >&2
    exit 2
  ''`;
}

const OK_GRANT_JSON = JSON.stringify({
  network: { block: false, open_port: [8080], allow_domain: [] },
});
const MISSING_GRANT_JSON = JSON.stringify({
  network: { block: false, open_port: [], allow_domain: [] },
});

// Build the launcher with the four stub seams substituted. `defaultState` and
// the nono/grant variations are the only knobs the scenarios need.
function launcherExpr({ defaultState, nonoExpr, grantJson }) {
  const nono = nonoExpr !== undefined ? nonoExpr : nonoStubExpr(grantJson);
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
    pkgs.callPackage ${repoRoot}/scripts/opencode-nono-launcher.nix {
      basePackage = ${BASE_PACKAGE_EXPR};
      preflightScript = "true";
      lspPath = "/dummy/lsp/bin";
      nono = ${nono};
      defaultState = "${defaultState}";
    }
  `;
}

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

// One-time-built, cached stub launcher variants.
const variantExprs = Object.freeze({
  okComplete: launcherExpr({ defaultState: 'disabled', grantJson: OK_GRANT_JSON }),
  defaultAudit: launcherExpr({ defaultState: 'audit', grantJson: OK_GRANT_JSON }),
  defaultEnforced: launcherExpr({ defaultState: 'enforced', grantJson: OK_GRANT_JSON }),
  noNono: launcherExpr({
    defaultState: 'disabled',
    nonoExpr: `pkgs.runCommand "no-nono" {} "mkdir -p $out"`,
  }),
  grantMissing: launcherExpr({ defaultState: 'enforced', grantJson: MISSING_GRANT_JSON }),
});

const variantCache = {};

function launcherBin(variant) {
  if (!variantCache[variant]) {
    const outPath = nixBuildExpr(variantExprs[variant]);
    variantCache[variant] = path.join(outPath, 'bin/opencode');
  }
  return variantCache[variant];
}

// Run a built stub launcher with a controlled env. `env` is merged over a
// CLEANED process.env: OPENCODE_NONO*, NONO_NO_SAVE_PROMPT, and XDG_* keys are
// stripped first so an ambient launcher var or the flake-check sandbox's XDG
// dirs cannot leak into a scenario that means to leave them unset.
function runLauncher(variant, env = {}) {
  const cleaned = { ...process.env };
  for (const key of Object.keys(cleaned)) {
    if (key.startsWith('OPENCODE_NONO') || key.startsWith('XDG_') || key === 'NONO_NO_SAVE_PROMPT') {
      delete cleaned[key];
    }
  }
  return childProcess.spawnSync(launcherBin(variant), ['arg1', 'arg2'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...cleaned, ...env },
    timeout: RUN_TIMEOUT_MS,
  });
}

// --- Branch 1: default disabled -----------------------------------------
// (okComplete, no env) → host-default reason, bare opencode, NO nono run.
test('default disabled resolves host-default and execs bare opencode (R1.5/R3.1)', () => {
  const result = runLauncher('okComplete', {});
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /OPENCODE eff=disabled prof= reason=host-default tag=nono:disabled/);
  assert.match(result.stdout, /args=arg1 arg2/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
});

// --- Branch 2: OPENCODE_NONO=disabled override ---------------------------
test('OPENCODE_NONO=disabled resolves the override reason, not host-default (R3.2)', () => {
  const result = runLauncher('okComplete', { OPENCODE_NONO: 'disabled' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /OPENCODE eff=disabled prof= reason=override tag=nono:disabled/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
});

// --- Branch 3: OPENCODE_NONO=audit ---------------------------------------
test('OPENCODE_NONO=audit execs nono run with the audit default profile (R3.2)', () => {
  const result = runLauncher('okComplete', { OPENCODE_NONO: 'audit' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  // The stub nono echoes its argv and no-save-prompt env, making both parts of
  // the noninteractive launch contract observable.
  assert.match(result.stdout, /NONO args=run --profile opencode-audit --allow-cwd -- .*opencode arg1 arg2/);
  assert.match(result.stdout, /no-save-prompt=1/);
  assert.doesNotMatch(result.stdout, /OPENCODE eff=/); // bare opencode never ran
});

// --- Branch 4: OPENCODE_NONO=enforced ------------------------------------
test('OPENCODE_NONO=enforced execs nono run with the managed default profile (R3.2)', () => {
  const result = runLauncher('okComplete', { OPENCODE_NONO: 'enforced' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /NONO args=run --profile opencode-managed --allow-cwd -- .*opencode arg1 arg2/);
});

// --- Branch 5: OPENCODE_NONO_PROFILE explicit override -------------------
test('OPENCODE_NONO_PROFILE overrides the effective profile name (R3.2)', () => {
  const result = runLauncher('okComplete', {
    OPENCODE_NONO: 'enforced',
    OPENCODE_NONO_PROFILE: 'opencode-review',
  });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /NONO args=run --profile opencode-review --allow-cwd -- /);
  assert.doesNotMatch(result.stdout, /opencode-managed/);
});

// --- Branch 6: invalid override ------------------------------------------
test('invalid OPENCODE_NONO override exits 1 listing the accepted values (R3.3)', () => {
  const result = runLauncher('okComplete', { OPENCODE_NONO: 'bogus' });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /invalid OPENCODE_NONO value: bogus/);
  assert.match(result.stderr, /disabled, audit, (?:or )?enforced/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
  assert.doesNotMatch(result.stdout, /OPENCODE eff=/);
});

// --- Branch 7: missing-nono fail-closed ----------------------------------
test('audit with a missing nono binary fails closed (exit 1, no launch) (R1.4)', () => {
  const result = runLauncher('noNono', { OPENCODE_NONO: 'audit' });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /nono/);
  assert.match(result.stderr, /Refusing to launch OpenCode unsandboxed/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
  assert.doesNotMatch(result.stdout, /OPENCODE eff=/);
});

// --- Branch 8: rollback under enforced host default ----------------------
test('OPENCODE_NONO=disabled rolls back even when the host default is enforced (R3.4)', () => {
  const result = runLauncher('defaultEnforced', { OPENCODE_NONO: 'disabled' });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /OPENCODE eff=disabled prof= reason=override tag=nono:disabled/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
});

// --- Branch 9: grant-check missing-grant ---------------------------------
test('enforced with a profile missing the open_port/8080 grant exits 1 (R4.4)', () => {
  const result = runLauncher('grantMissing', { OPENCODE_NONO: 'enforced' });
  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stderr, /open_port/);
  assert.match(result.stderr, /8080/);
  assert.match(result.stderr, /missing a required grant/);
  assert.doesNotMatch(result.stdout, /NONO args=run/);
});

// --- Branch 10: freshness-marker absent → warn, never block --------------
test('enforced with an absent freshness marker warns but still execs (exit 0) (R3.5)', () => {
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-state-'));
  const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-nono-config-'));
  try {
    // Provide metadata.json with a profileVersion but NO last-report.json under
    // the isolated XDG_STATE_HOME, so the marker is absent → warn, never block.
    const metadataDir = path.join(configHome, 'opencode/opencode-nono');
    fs.mkdirSync(metadataDir, { recursive: true });
    fs.writeFileSync(path.join(metadataDir, 'metadata.json'), JSON.stringify({ profileVersion: '0.1.0' }));

    const result = runLauncher('okComplete', {
      OPENCODE_NONO: 'enforced',
      XDG_STATE_HOME: stateHome,
      XDG_CONFIG_HOME: configHome,
    });

    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    assert.match(result.stderr, /WARNING: opencode-nono strict enforcement/);
    assert.match(result.stderr, /no compatibility report found/);
    // Freshness never blocks: it still execs nono run.
    assert.match(result.stdout, /NONO args=run --profile opencode-managed --allow-cwd -- /);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
    fs.rmSync(configHome, { recursive: true, force: true });
  }
});
