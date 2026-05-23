'use strict';

/*
 * tests/rtk-opencode/validate.test.js — argument-parsing / failure-label
 * contract for `rtk-opencode-validate` (rtk-install spec, task 6.1).
 *
 * The validate script is the operator-facing Phase B handoff: after a
 * `darwin-rebuild switch` the operator runs it to (a) verify the live
 * metadata + plugin landed, (b) execute the rtk-opencode-smoke-test
 * against the running config, (c) drive a before/after
 * `opencode-cost-report` measurement comparing Bash-tool attribution,
 * and (d) snapshot the OpenCode session-DB mtime/size for the
 * non-mutation contract (Requirements 6.1, 6.7, 6.8).
 *
 * What this file tests:
 *
 *   - `--help` exits 0 and documents every required env override.
 *   - Unknown subcommand fails with the documented
 *     `[validate-failure: invalid_arguments]` label.
 *   - `--version` exits 0 (release identity for the operator).
 *   - The metadata-discovery contract: when metadata.json is missing
 *     under the discovered config root, the script fails with
 *     `[validate-failure: metadata_missing]` and names the expected
 *     path so the operator knows to `darwin-rebuild switch`.
 *   - The plugin-discovery contract: when metadata.json is present
 *     but the plugin file is absent, the script fails with
 *     `[validate-failure: plugin_missing]` and names the expected
 *     plugin path.
 *
 * What this file does NOT test:
 *
 *   - The end-to-end smoke run (would require a live `rtk` binary on
 *     PATH and a switched host); that path is exercised by
 *     `tests/rtk-opencode/smoke.test.js` against the smoke binary
 *     directly.
 *   - The `baseline` / `compare` subcommands' full lifecycle
 *     (would require a real opencode session DB and a non-empty
 *     opencode-cost-report run); we test argument parsing only.
 *
 * Modelled on the smoke verifier's test pattern in
 * `tests/rtk-opencode/smoke.test.js`: build the script via Nix,
 * exercise it against an mkdtemp'd fake $XDG_CONFIG_HOME, assert on
 * exit code and the `[validate-failure: <label>] <detail>` shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');

let validateBinary;

function buildValidateBinary() {
  if (validateBinary) {
    return validateBinary;
  }

  // Wire a fake `rtk` and a fake `opencode-cost-report` into the
  // derivation so the script's runtimeInputs resolve under sandboxed
  // test execution without depending on the real RTK / cost-report
  // closure. The fakes are only needed to satisfy `command -v` and
  // friends — these tests exercise argument parsing and discovery
  // contracts, not the live measurement loop.
  const expr = `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      fakeRtk = pkgs.writeShellApplication {
        name = "rtk";
        text = ''
          case "''\${1:-}" in
            --version) printf 'rtk 0.40.0\\n' ;;
            *) printf 'fake rtk\\n' ;;
          esac
        '';
      };
      fakeCostReport = pkgs.writeShellApplication {
        name = "opencode-cost-report";
        # When RTK_VALIDATE_TEST_FIXTURE is set, copy that JSON fixture
        # to the --output path so tests can exercise the bash_total jq
        # path with a hand-crafted DiagnosticReport shape. Without the
        # env var the stub prints a marker line (preserving the legacy
        # behaviour used by the arg-parsing / discovery tests, which
        # never reach run_cost_report).
        text = ''
          out=""
          while [ "$#" -gt 0 ]; do
            if [ "$1" = "--output" ]; then
              out="$2"
              shift 2
            elif [ "$1" = "--format" ]; then
              shift 2
            else
              shift
            fi
          done
          if [ -n "''\${RTK_VALIDATE_TEST_FIXTURE:-}" ] && [ -n "$out" ]; then
            cp "''\${RTK_VALIDATE_TEST_FIXTURE}" "$out"
          else
            printf 'fake opencode-cost-report\\n'
          fi
        '';
      };
      fakeSmoke = pkgs.writeShellApplication {
        name = "rtk-opencode-smoke-test";
        text = ''
          printf '[smoke-test-ok] fake smoke pass\\n' >&2
        '';
      };
    in
      pkgs.callPackage ./scripts/rtk-opencode-validate.nix {
        rtk = fakeRtk;
        opencode-cost-report = fakeCostReport;
        rtk-opencode-smoke-test = fakeSmoke;
      }
  `;

  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 180_000,
    },
  ).trim();
  validateBinary = path.join(outPath, 'bin', 'rtk-opencode-validate');
  return validateBinary;
}

function makeFixture({ writeMetadata = true, writePlugin = true } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-validate-'));
  const configHome = path.join(tmpDir, 'config');
  const metadataPath = path.join(configHome, 'opencode/rtk/metadata.json');
  const pluginPath = path.join(configHome, 'opencode/plugins/rtk.ts');

  if (writeMetadata) {
    fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fs.writeFileSync(
      metadataPath,
      JSON.stringify(
        {
          feature: 'rtk-install',
          packageName: 'rtk',
          packageVersion: '0.40.0',
          sourceOwner: 'rtk-ai',
          sourceRepo: 'rtk',
          sourceRev: 'v0.40.0',
          defaultEnabled: true,
          overrideEnv: 'OPENCODE_RTK',
          effectiveEnv: 'OPENCODE_RTK_EFFECTIVE',
          usageTagEnv: 'OPENCODE_RTK_USAGE_TAG',
          telemetryEnv: 'RTK_TELEMETRY_DISABLED',
          pluginPath: 'opencode/plugins/rtk.ts',
        },
        null,
        2,
      ) + '\n',
    );
  }
  if (writePlugin) {
    fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
    fs.writeFileSync(pluginPath, 'export const name = "rtk"\n');
  }

  return { tmpDir, configHome, metadataPath, pluginPath };
}

function runValidate(args, options = {}) {
  const fixture = makeFixture(options);
  const result = childProcess.spawnSync(buildValidateBinary(), args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: fixture.tmpDir,
      XDG_CONFIG_HOME: fixture.configHome,
      XDG_STATE_HOME: path.join(fixture.tmpDir, 'state'),
      ...(options.env ?? {}),
    },
    timeout: 60_000,
  });
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  return result;
}

test('rtk-opencode-validate --help exits 0 and documents every override env', () => {
  const result = runValidate(['--help']);

  assert.equal(result.status, 0, result.stderr);
  // --help routes to stdout per repo convention (cavemem, cost-report).
  const helpText = result.stdout + result.stderr;
  assert.match(helpText, /rtk-opencode-validate/);
  // The operator MUST be able to flip the smoke-step state from the help
  // alone (Phase B asks them to run the disabled-state path too).
  assert.match(helpText, /OPENCODE_RTK_EFFECTIVE/);
  assert.match(helpText, /OPENCODE_RTK_USAGE_TAG/);
  assert.match(helpText, /RTK_TELEMETRY_DISABLED/);
  // Subcommand documentation must mention the two cost-report driver
  // verbs so an operator new to the script doesn't have to grep the
  // source. `smoke` is the smoke-only short-circuit.
  assert.match(helpText, /baseline/);
  assert.match(helpText, /compare/);
  assert.match(helpText, /smoke/);
});

test('rtk-opencode-validate --version exits 0', () => {
  const result = runValidate(['--version']);
  assert.equal(result.status, 0, result.stderr);
});

test('rtk-opencode-validate fails with [invalid_arguments] on an unknown subcommand', () => {
  const result = runValidate(['totally-bogus-verb']);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[validate-failure: invalid_arguments\]/);
});

test('rtk-opencode-validate fails with [metadata_missing] when rendered metadata is absent', () => {
  // Operator forgot to `darwin-rebuild switch` after enabling RTK.
  // The script must fail BEFORE invoking the smoke binary and the
  // error must name the discovery path so the operator can act.
  const result = runValidate(['smoke'], { writeMetadata: false });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[validate-failure: metadata_missing\]/);
  assert.match(result.stderr, /opencode\/rtk\/metadata\.json/);
});

test('rtk-opencode-validate fails with [plugin_missing] when metadata is present but plugin is not', () => {
  // Operator partially switched (or someone removed the plugin file
  // by hand). The script names the expected plugin path so the
  // operator can re-render Home Manager.
  const result = runValidate(['smoke'], { writePlugin: false });
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[validate-failure: plugin_missing\]/);
  assert.match(result.stderr, /opencode\/plugins\/rtk\.ts/);
});

test('rtk-opencode-validate compare without a baseline fails with [baseline_missing]', () => {
  // `compare` needs a prior `baseline` run to diff against; running
  // it cold must surface a named failure rather than a noisy stack
  // trace from jq or sort.
  const result = runValidate(['compare']);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[validate-failure: baseline_missing\]/);
});

test('rtk-opencode-validate baseline + compare diffs Bash attribution via globalTotals', () => {
  // End-to-end exercise of the bash_total jq path. The stub
  // opencode-cost-report copies whatever JSON fixture
  // RTK_VALIDATE_TEST_FIXTURE points at to --output on each
  // invocation. We swap the fixture between baseline and compare
  // so the validator sees two different reports and the printed
  // delta must equal the arithmetic difference of the bash
  // totals.
  //
  // Fixture shape matches `scripts/opencode-cost-report.js`:
  //   - globalTotals.cost.toolOutputsByTool is a plain object
  //     populated by ReportAssembler (lines 3655-3658, 3742-3745).
  //   - Per-session toolOutputsByTool is a Map and serialises to
  //     `{}` (line 2581 onward) — placing data there would be a
  //     silent miss; deliberately empty here to prove the
  //     validator does NOT read the per-session path.
  //   - Tool key is lowercase (`bash`), matching the tool-name
  //     extraction at line 1327 (`data.name`).
  const fixture = makeFixture();
  const fixtureFile = path.join(fixture.tmpDir, 'cost-report.json');

  const baselineReport = {
    schemaVersion: 1,
    reportType: 'opencode-cost-diagnosis',
    globalTotals: {
      cost: {
        toolOutputsByTool: {
          bash: { cached: 1.25, uncached: 3.75 },
          edit: { cached: 0.5, uncached: 0.5 },
        },
      },
    },
    sessionCount: 0,
    byProject: {},
    sessions: [
      // Per-session map serialises to {} on the real report; we
      // populate it here to verify the validator does NOT read
      // from this path. If it did, baseline_bash would pick up
      // 999 + 999 = 1998 and the delta assertion below would
      // fail with a wildly wrong number.
      { cost: { toolOutputsByTool: { Bash: { cached: 999, uncached: 999 } } } },
    ],
    findings: [],
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(baselineReport));

  const baselineEnv = {
    PATH: process.env.PATH,
    HOME: fixture.tmpDir,
    XDG_CONFIG_HOME: fixture.configHome,
    XDG_STATE_HOME: path.join(fixture.tmpDir, 'state'),
    RTK_VALIDATE_TEST_FIXTURE: fixtureFile,
  };

  const baselineResult = childProcess.spawnSync(
    buildValidateBinary(),
    ['baseline'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: baselineEnv,
      timeout: 60_000,
    },
  );

  assert.equal(baselineResult.status, 0, baselineResult.stderr);
  // baseline bash total = 1.25 + 3.75 = 5
  assert.match(
    baselineResult.stderr,
    /bash total: \$5\b/,
    `expected baseline stderr to report bash total $5, got:\n${baselineResult.stderr}`,
  );

  // Swap to perturbed fixture; compare must read the NEW total
  // and emit the arithmetic delta against the persisted baseline.
  const perturbedReport = {
    schemaVersion: 1,
    reportType: 'opencode-cost-diagnosis',
    globalTotals: {
      cost: {
        toolOutputsByTool: {
          bash: { cached: 2, uncached: 5.5 },
        },
      },
    },
    sessionCount: 0,
    byProject: {},
    sessions: [],
    findings: [],
  };
  fs.writeFileSync(fixtureFile, JSON.stringify(perturbedReport));

  const compareResult = childProcess.spawnSync(
    buildValidateBinary(),
    ['compare'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: baselineEnv,
      timeout: 60_000,
    },
  );

  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });

  assert.equal(compareResult.status, 0, compareResult.stderr);
  assert.match(compareResult.stderr, /\[validate-ok\] compare/);
  // baseline=5, after=7.5, delta=2.5. All three lines must appear.
  assert.match(
    compareResult.stderr,
    /baseline:\s+\$5\b/,
    `expected compare stderr to echo baseline $5, got:\n${compareResult.stderr}`,
  );
  assert.match(
    compareResult.stderr,
    /after:\s+\$7\.5\b/,
    `expected compare stderr to echo after $7.5, got:\n${compareResult.stderr}`,
  );
  assert.match(
    compareResult.stderr,
    /delta:\s+\$2\.5\b/,
    `expected compare stderr to echo delta $2.5, got:\n${compareResult.stderr}`,
  );
});
