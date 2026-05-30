'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_COMMAND_TIMEOUT_MS = 600_000;

let smokeBinary;
let renderedMetadata;

function buildSmokeBinary() {
  if (smokeBinary) {
    return smokeBinary;
  }

  const expr = `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      fakeRtk = pkgs.writeShellApplication {
        name = "rtk";
        text = ''
          case "''\${1:-}" in
            --version)
              printf 'rtk 0.40.0\\n'
              ;;
            *)
              printf 'fake rtk\\n'
              ;;
          esac
        '';
      };
    in
      pkgs.callPackage ./scripts/rtk-opencode-smoke-test.nix { rtk = fakeRtk; }
  `;

  const outPath = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ).trim();
  smokeBinary = path.join(outPath, 'bin', 'rtk-opencode-smoke-test');
  return smokeBinary;
}

function getRenderedMetadata() {
  if (renderedMetadata) {
    return renderedMetadata;
  }

  const expr = `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
    in
      builtins.fromJSON hm.xdg.configFile.\${hm.programs.opencode-rtk.metadataPath}.text
  `;

  renderedMetadata = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ));
  return renderedMetadata;
}

function baseMetadata(overrides = {}) {
  return {
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
    ...overrides,
  };
}

function makeFixture(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-smoke-'));
  const configHome = path.join(tmpDir, 'config');
  const metadataPath = path.join(configHome, 'opencode/rtk/metadata.json');
  const pluginPath = path.join(configHome, 'opencode/plugins/rtk.ts');

  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.mkdirSync(path.dirname(pluginPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(baseMetadata(options.metadata), null, 2)}\n`);
  if (options.plugin !== 'missing') {
    fs.writeFileSync(pluginPath, 'export const name = "rtk"\n');
  }

  return { tmpDir, configHome, metadataPath, pluginPath };
}

function runSmoke(options = {}) {
  const fixture = makeFixture(options);
  const result = childProcess.spawnSync(buildSmokeBinary(), [], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      HOME: fixture.tmpDir,
      XDG_CONFIG_HOME: fixture.configHome,
      OPENCODE_RTK_SMOKE_METADATA: fixture.metadataPath,
      OPENCODE_RTK_EFFECTIVE: 'enabled',
      OPENCODE_RTK_USAGE_TAG: 'rtk:enabled',
      RTK_TELEMETRY_DISABLED: '1',
      ...(options.env ?? {}),
    },
    timeout: 120_000,
  });
  fs.rmSync(fixture.tmpDir, { recursive: true, force: true });
  return result;
}

function assertSmokeFailure(options, label) {
  const result = runSmoke(options);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`\\[smoke-test-failure: ${label}\\]`));
}

test('RTK smoke verifier accepts valid metadata, plugin, telemetry, and state', () => {
  const result = runSmoke();

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[smoke-test-ok\]/);
});

test('RTK smoke verifier accepts actual rendered Home Manager metadata', () => {
  const result = runSmoke({ metadata: getRenderedMetadata() });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[smoke-test-ok\]/);
});

test('RTK smoke verifier fails with a named label when plugin file is missing', () => {
  assertSmokeFailure({ plugin: 'missing' }, 'plugin_missing');
});

test('RTK smoke verifier fails with a named label when telemetry is not disabled', () => {
  assertSmokeFailure({ env: { RTK_TELEMETRY_DISABLED: '0' } }, 'telemetry_disabled_invalid');
});

test('RTK smoke verifier fails with a named label when usage tag does not match effective state', () => {
  assertSmokeFailure({ env: { OPENCODE_RTK_USAGE_TAG: 'rtk:disabled' } }, 'usage_tag_mismatch');
});

test('RTK smoke verifier fails with a named label when metadata source is wrong', () => {
  assertSmokeFailure({ metadata: { sourceOwner: 'npm', sourceRepo: 'rtk' } }, 'metadata_source_invalid');
});

test('RTK smoke verifier fails with a named label when metadata version is wrong', () => {
  assertSmokeFailure({ metadata: { packageVersion: '0.39.0' } }, 'metadata_version_invalid');
});
