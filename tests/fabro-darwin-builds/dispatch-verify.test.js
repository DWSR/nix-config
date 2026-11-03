'use strict';

// Behaviour tests for `scripts/fabro-darwin-dispatch-verify.nix`
// (mac-builder-for-fabro-nix-darwin-builds, task 5.6; design "Testing Strategy
// → Integration and manual verification"; requirements 1.4, 1.5, 3.1, 3.2,
// 6.6, 8.6).
//
// Task 5.6 captures the live dispatch observations: the builder joined the
// tailnet under its own tag from the OAuth credential, the guest rendered one
// `0600` machines line and restarted its daemon, `aarch64-linux` builds still
// run locally, and the smoke's store path resolves inside a sandbox. Those
// observations need the two live hosts, so this suite drives the harness that
// performs them against fakes for the host tools: it proves the harness fails
// with the observation's own label instead of reporting a false pass.
//
// The fakes are injected through the script's callPackage arguments and read
// their state from environment variables, so the assertions exercise the real
// argument parsing, tailnet/machines/timestamp comparison, local-build check,
// and sandbox-resolution step without a builder, a switched guest, or podman.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_TIMEOUT_MS = 600_000;
const RUN_TIMEOUT_MS = 60_000;

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-darwin-dispatch-verify-'));
const paths = {
  machines: path.join(workspace, 'machines'),
  digest: path.join(workspace, 'digest'),
  storePath: path.join(workspace, 'store-output'),
  localBuild: path.join(workspace, 'local-build-output'),
  podmanLog: path.join(workspace, 'podman.log'),
  tailscaleJson: path.join(workspace, 'tailscale.json'),
  tailscaleAfter: path.join(workspace, 'tailscale-after.json'),
  authLog: path.join(workspace, 'tailscale-auth.err.log'),
  credential: path.join(workspace, 'builder-tailscale-oauth-secret'),
  statOutput: path.join(workspace, 'stat-output'),
  rendererActive: path.join(workspace, 'renderer-active'),
  daemonActive: path.join(workspace, 'daemon-active'),
  daemonMono: path.join(workspace, 'daemon-mono'),
  rendererMono: path.join(workspace, 'renderer-mono'),
};

const HOST = 'mac-builder.tuxedo-musical.ts.net';
const BUILDER_NAME = 'mac-builder';
const TAG = 'tag:mac-builder';
// The line `mac-builder-tailscale-auth` writes immediately before its
// credential-driven `tailscale up` (scripts/mac-builder-tailscale-auth.nix).
const JOIN_MARKER =
  `mac-builder-tailscale-auth: BackendState='NeedsLogin'; ` +
  `joining the tailnet as ${BUILDER_NAME} (${TAG})`;
const MACHINES_LINE =
  `ssh-ng://nix-builder@${HOST} aarch64-darwin ` +
  '/run/secrets/build-client-key 4 2 - - AAAAHOSTKEY';
const IMAGE = 'localhost/fabro-sandbox';
const DEFAULT_REF = `${IMAGE}@sha256:defaultdigest`;
const EXPLICIT_REF = 'localhost/fabro-sandbox@sha256:explicit';

let cachedVerifyBin = null;

function buildVerifyBin() {
  if (cachedVerifyBin) return cachedVerifyBin;

  // Fake host tools. Every knob is an environment variable the test sets per
  // case, so one build covers all pass and failure paths.
  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };

  fakeTailscale = pkgs.writeShellScriptBin "tailscale" ''
    case "''\${1:-}" in
      logout)
        if [ -n "''\${STUB_TAILSCALE_LOGOUT_FAIL:-}" ]; then
          echo "logout failed" >&2
          exit 1
        fi
        # A successful logout drives the fake daemon: append the join line the
        # real wrapper writes and move the node to its post-rejoin state.
        if [ -n "''\${STUB_TAILSCALE_AFTER_JSON:-}" ]; then
          printf '%s\\n' "$STUB_TAILSCALE_JOIN_MARKER" >> "$STUB_TAILSCALE_AUTH_LOG"
          cp "$STUB_TAILSCALE_AFTER_JSON" "$STUB_TAILSCALE_JSON"
        fi
        exit 0
        ;;
      status)
        if [ -n "''\${STUB_TAILSCALE_FAIL:-}" ]; then
          exit 1
        fi
        cat "$STUB_TAILSCALE_JSON"
        ;;
      *)
        echo "unsupported tailscale invocation: $*" >&2
        exit 2
        ;;
    esac
  '';

  fakeLaunchctl = pkgs.writeShellScriptBin "launchctl" ''
    if [ -n "$STUB_LAUNCHCTL_FAIL" ]; then
      echo "Could not find service" >&2
      exit 113
    fi
    echo "system/org.nixos.mac-builder-tailscale-auth = { active count = 1 }"
  '';

  fakeSystemctl = pkgs.writeShellScriptBin "systemctl" ''
    case "$1" in
      is-active)
        case "$2" in
          fabro-darwin-builders.service) cat "$STUB_RENDERER_ACTIVE" ;;
          nix-daemon.service) cat "$STUB_DAEMON_ACTIVE" ;;
          *) echo inactive ;;
        esac
        ;;
      show)
        case "$3" in
          ActiveEnterTimestampMonotonic) cat "$STUB_DAEMON_MONO" ;;
          ExecMainExitTimestampMonotonic) cat "$STUB_RENDERER_MONO" ;;
          *) echo 0 ;;
        esac
        ;;
      *)
        echo "unsupported systemctl invocation: $*" >&2
        exit 2
        ;;
    esac
  '';

  fakeStat = pkgs.writeShellScriptBin "stat" ''
    cat "$STUB_STAT_OUTPUT"
  '';

  fakeNix = pkgs.writeShellScriptBin "nix" ''
    if [ -n "$STUB_NIX_FAIL" ]; then
      echo "error: platform mismatch" >&2
      exit 1
    fi
    printf '%s\\n' "$STUB_LOCAL_BUILD_PATH"
  '';

  fakePodman = pkgs.writeShellScriptBin "podman" ''
    printf '%s\\n' "$*" >> "$STUB_PODMAN_LOG"
    if [ -n "$STUB_PODMAN_FAIL" ]; then
      exit 1
    fi
    exit 0
  '';

  fakeSmoke = pkgs.writeShellScriptBin "fabro-darwin-build-smoke" ''
    if [ -n "$STUB_SMOKE_FAIL" ]; then
      echo "fabro-darwin-build-smoke: [build] podman run failed for image reference: $STUB_SMOKE_REF" >&2
      exit 1
    fi
    echo "fabro-darwin-build-smoke: [preflight] checking build-session material"
    if [ -n "$STUB_SMOKE_STORE_PATH" ]; then
      echo "fabro-darwin-build-smoke: store path: $STUB_SMOKE_STORE_PATH"
    fi
    echo "fabro-darwin-build-smoke: all steps passed (ref=$STUB_SMOKE_REF)"
  '';
in
pkgs.callPackage ${repoRoot}/scripts/fabro-darwin-dispatch-verify.nix {
  tailscale = "\${fakeTailscale}/bin/tailscale";
  launchctl = "\${fakeLaunchctl}/bin/launchctl";
  systemctl = "\${fakeSystemctl}/bin/systemctl";
  stat = "\${fakeStat}/bin/stat";
  nix = "\${fakeNix}/bin/nix";
  podman = "\${fakePodman}/bin/podman";
  smoke = "\${fakeSmoke}/bin/fabro-darwin-build-smoke";
  machinesFile = ${JSON.stringify(paths.machines)};
  digestFile = ${JSON.stringify(paths.digest)};
  hostName = ${JSON.stringify(HOST)};
  builderName = ${JSON.stringify(BUILDER_NAME)};
  credentialFile = ${JSON.stringify(paths.credential)};
  authLog = ${JSON.stringify(paths.authLog)};
  reauthTimeout = 0;
  imageName = ${JSON.stringify(IMAGE)};
  localSystem = "aarch64-linux";
}
`;

  const out = childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim().split('\n').pop();

  cachedVerifyBin = path.join(out, 'bin', 'fabro-darwin-dispatch-verify');
  return cachedVerifyBin;
}

function resetWorkspace() {
  fs.writeFileSync(paths.machines, `${MACHINES_LINE}\n`);
  fs.writeFileSync(paths.digest, 'sha256:defaultdigest\n');
  fs.writeFileSync(paths.storePath, 'ok\n');
  fs.writeFileSync(paths.localBuild, 'ok\n');
  fs.writeFileSync(paths.statOutput, '600 root root\n');
  fs.writeFileSync(paths.rendererActive, 'active\n');
  fs.writeFileSync(paths.daemonActive, 'active\n');
  fs.writeFileSync(paths.daemonMono, '900000\n');
  fs.writeFileSync(paths.rendererMono, '800000\n');
  fs.writeFileSync(
    paths.tailscaleJson,
    `${JSON.stringify({ BackendState: 'Running', Self: { Tags: [TAG] } })}\n`,
  );
  fs.writeFileSync(
    paths.tailscaleAfter,
    `${JSON.stringify({ BackendState: 'Running', Self: { Tags: [TAG] } })}\n`,
  );
  // Existing log content, plus the root-only credential fixture. The value is a
  // fixture, never a real credential, and the verifier must not read it.
  fs.writeFileSync(
    paths.authLog,
    'mac-builder-tailscale-auth: tailnet is running as mac-builder\n',
  );
  fs.writeFileSync(paths.credential, 'stub-oauth-credential\n');
  fs.rmSync(paths.podmanLog, { force: true });
}

function baseEnv() {
  return {
    STUB_TAILSCALE_JSON: paths.tailscaleJson,
    STUB_TAILSCALE_AFTER_JSON: paths.tailscaleAfter,
    STUB_TAILSCALE_AUTH_LOG: paths.authLog,
    STUB_TAILSCALE_JOIN_MARKER: JOIN_MARKER,
    STUB_RENDERER_ACTIVE: paths.rendererActive,
    STUB_DAEMON_ACTIVE: paths.daemonActive,
    STUB_DAEMON_MONO: paths.daemonMono,
    STUB_RENDERER_MONO: paths.rendererMono,
    STUB_STAT_OUTPUT: paths.statOutput,
    STUB_LOCAL_BUILD_PATH: paths.localBuild,
    STUB_PODMAN_LOG: paths.podmanLog,
    STUB_SMOKE_STORE_PATH: paths.storePath,
    STUB_SMOKE_REF: DEFAULT_REF,
  };
}

function runVerify(args = [], env = {}) {
  assert.ok(fs.existsSync(buildVerifyBin()), 'the verify binary must be built');
  return childProcess.spawnSync(buildVerifyBin(), args, {
    encoding: 'utf8',
    timeout: RUN_TIMEOUT_MS,
    env: { ...process.env, ...baseEnv(), ...env },
  });
}

function output(result) {
  return `${result.stdout}\n${result.stderr}`;
}

function podmanCalls() {
  if (!fs.existsSync(paths.podmanLog)) return [];
  return fs
    .readFileSync(paths.podmanLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectFailure(result, label) {
  assert.notEqual(result.status, 0, output(result));
  assert.match(output(result), new RegExp(`\\[verify-failure: ${label}\\]`), output(result));
}

test.beforeEach(resetWorkspace);

// --- CLI contract ---------------------------------------------------------

test('--help documents every subcommand and override', () => {
  const result = runVerify(['--help']);

  assert.equal(result.status, 0, output(result));
  for (const subcommand of ['builder', 'guest', 'smoke', 'all']) {
    assert.match(result.stdout, new RegExp(`\\b${subcommand}\\b`), `missing ${subcommand}`);
  }
  for (const override of [
    'FABRO_DARWIN_VERIFY_TAILSCALE',
    'FABRO_DARWIN_VERIFY_LAUNCHCTL',
    'FABRO_DARWIN_VERIFY_SYSTEMCTL',
    'FABRO_DARWIN_VERIFY_NIX',
    'FABRO_DARWIN_VERIFY_PODMAN',
    'FABRO_DARWIN_VERIFY_SMOKE',
    'FABRO_DARWIN_VERIFY_MACHINES',
    'FABRO_DARWIN_VERIFY_DIGEST',
    'FABRO_DARWIN_VERIFY_IMAGE',
    'FABRO_DARWIN_VERIFY_CREDENTIAL',
    'FABRO_DARWIN_VERIFY_AUTH_LOG',
    'FABRO_DARWIN_VERIFY_BUILDER_NAME',
    'FABRO_DARWIN_VERIFY_REAUTH_TIMEOUT',
  ]) {
    assert.ok(result.stdout.includes(override), `the help must document ${override}`);
  }
});

test('--version prints the release identity', () => {
  const result = runVerify(['--version']);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /^fabro-darwin-dispatch-verify \d+\.\d+\.\d+$/m);
});

test('an unknown subcommand fails with invalid_arguments', () => {
  const result = runVerify(['builder-host']);

  expectFailure(result, 'invalid_arguments');
  assert.match(output(result), /builder\|guest\|smoke\|all/);
});

test('no subcommand fails with invalid_arguments', () => {
  const result = runVerify([]);

  expectFailure(result, 'invalid_arguments');
});

// --- builder observations (requirement 4.9, 4.10, 4.11) -------------------

test('builder passes on a fresh credential-driven join logged by the daemon', () => {
  const result = runVerify(['builder']);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[builder\]/);
  assert.ok(result.stdout.includes(TAG), 'the report must name the builder tag');
  assert.match(result.stdout, /auth daemon/);
  assert.match(result.stdout, /OAuth credential present \(value not read\)/);
  assert.match(result.stdout, /credential-driven join logged/);
  assert.ok(
    fs.readFileSync(paths.authLog, 'utf8').includes(JOIN_MARKER),
    'the fake daemon must have logged the join the verifier requires',
  );
});

test('builder fails with tailnet_status when tailscale status fails', () => {
  const result = runVerify(['builder'], { STUB_TAILSCALE_FAIL: '1' });

  expectFailure(result, 'tailnet_status');
});

test('builder fails with fresh_join_missing for a pre-existing Running node', () => {
  // No daemon join is logged after the controlled logout: the node is Running
  // and tagged, but nothing proves the credential produced that session.
  const result = runVerify(['builder'], { STUB_TAILSCALE_AFTER_JSON: '' });

  expectFailure(result, 'fresh_join_missing');
  assert.match(output(result), /already Running/);
  assert.ok(output(result).includes(paths.authLog), 'the failure must name the daemon log');
});

test('builder ignores a join line written before the controlled logout', () => {
  fs.appendFileSync(paths.authLog, `${JOIN_MARKER}\n`);
  const result = runVerify(['builder'], { STUB_TAILSCALE_AFTER_JSON: '' });

  expectFailure(result, 'fresh_join_missing');
});

test('builder fails with reauth_logout_failed when logout cannot withdraw the session', () => {
  const result = runVerify(['builder'], { STUB_TAILSCALE_LOGOUT_FAIL: '1' });

  expectFailure(result, 'reauth_logout_failed');
});

test('builder fails with credential_missing when the OAuth credential is absent', () => {
  fs.rmSync(paths.credential);
  const result = runVerify(['builder']);

  expectFailure(result, 'credential_missing');
  assert.ok(output(result).includes(paths.credential));
});

test('builder fails with credential_missing when the OAuth credential is empty', () => {
  fs.writeFileSync(paths.credential, '');
  const result = runVerify(['builder']);

  expectFailure(result, 'credential_missing');
  assert.match(output(result), /empty/);
});

test('builder fails with auth_log_missing when the daemon log is absent', () => {
  fs.rmSync(paths.authLog);
  const result = runVerify(['builder']);

  expectFailure(result, 'auth_log_missing');
  assert.ok(output(result).includes(paths.authLog));
});

test('builder fails with tailnet_not_running when the credential does not restore membership', () => {
  fs.writeFileSync(
    paths.tailscaleJson,
    `${JSON.stringify({ BackendState: 'NeedsLogin', Self: { Tags: [] } })}\n`,
  );
  fs.writeFileSync(
    paths.tailscaleAfter,
    `${JSON.stringify({ BackendState: 'NeedsLogin', Self: { Tags: [] } })}\n`,
  );
  const result = runVerify(['builder']);

  expectFailure(result, 'tailnet_not_running');
  assert.match(output(result), /NeedsLogin/);
});

test('builder fails with tailnet_tag_missing when the fresh join lacks the builder tag', () => {
  fs.writeFileSync(
    paths.tailscaleAfter,
    `${JSON.stringify({ BackendState: 'Running', Self: { Tags: ['tag:fabro'] } })}\n`,
  );
  const result = runVerify(['builder']);

  expectFailure(result, 'tailnet_tag_missing');
  assert.ok(output(result).includes(TAG), 'the failure must name the expected tag');
});

test('builder fails with auth_service_missing when the auth daemon is not loaded', () => {
  const result = runVerify(['builder'], { STUB_LAUNCHCTL_FAIL: '1' });

  expectFailure(result, 'auth_service_missing');
  assert.match(output(result), /mac-builder-tailscale-auth/);
});

// --- guest observations (requirements 1.2, 3.2, 6.6) ----------------------

test('guest passes with one 0600 machines line, a restarted daemon, and a local build', () => {
  const result = runVerify(['guest']);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[guest\]/);
  assert.ok(result.stdout.includes(paths.machines), 'the report must name the machines file');
  assert.ok(result.stdout.includes(HOST), 'the report must name the builder tailnet name');
  assert.ok(result.stdout.includes(paths.localBuild), 'the report must name the local build output');
});

test('guest fails with renderer_not_active when the renderer unit is not active', () => {
  fs.writeFileSync(paths.rendererActive, 'failed\n');
  const result = runVerify(['guest']);

  expectFailure(result, 'renderer_not_active');
  assert.match(output(result), /fabro-darwin-builders/);
});

test('guest fails with machines_missing when the machines file is absent', () => {
  fs.rmSync(paths.machines);
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_missing');
  assert.ok(output(result).includes(paths.machines));
});

test('guest fails with machines_permissions when the machines file is not 0600 root root', () => {
  fs.writeFileSync(paths.statOutput, '644 root root\n');
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_permissions');
  assert.match(output(result), /644 root root/);
});

test('guest fails with machines_line_count when the file holds more than one line', () => {
  fs.writeFileSync(paths.machines, `${MACHINES_LINE}\n${MACHINES_LINE}\n`);
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_line_count');
});

test('guest fails with machines_line_count when the file holds no line', () => {
  fs.writeFileSync(paths.machines, '');
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_line_count');
});

test('guest fails with machines_system_mismatch when the entry targets another system', () => {
  fs.writeFileSync(
    paths.machines,
    `ssh-ng://nix-builder@${HOST} aarch64-linux /run/secrets/build-client-key 4 2 - - AAAHOSTKEY\n`,
  );
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_system_mismatch');
  assert.match(output(result), /aarch64-darwin/);
});

test('guest fails with machines_host_mismatch when the entry does not name the tailnet host', () => {
  fs.writeFileSync(
    paths.machines,
    'ssh-ng://nix-builder@127.0.0.1 aarch64-darwin /run/secrets/build-client-key 4 2 - - AAAHOSTKEY\n',
  );
  const result = runVerify(['guest']);

  expectFailure(result, 'machines_host_mismatch');
  assert.ok(output(result).includes(HOST), 'the failure must name the expected tailnet host');
});

test('guest fails with daemon_not_active when the daemon is down', () => {
  fs.writeFileSync(paths.daemonActive, 'inactive\n');
  const result = runVerify(['guest']);

  expectFailure(result, 'daemon_not_active');
});

test('guest fails with daemon_not_restarted when the daemon predates the render', () => {
  fs.writeFileSync(paths.daemonMono, '700000\n');
  fs.writeFileSync(paths.rendererMono, '800000\n');
  const result = runVerify(['guest']);

  expectFailure(result, 'daemon_not_restarted');
});

test('guest fails with local_build_failed when the local build fails', () => {
  const result = runVerify(['guest'], { STUB_NIX_FAIL: '1' });

  expectFailure(result, 'local_build_failed');
});

test('guest fails with local_build_failed when the local output is absent', () => {
  fs.rmSync(paths.localBuild);
  const result = runVerify(['guest']);

  expectFailure(result, 'local_build_failed');
});

// --- smoke and sandbox resolution (requirements 1.4, 8.6) -----------------

test('smoke passes when the reported store path resolves in a fresh sandbox', () => {
  const result = runVerify(['smoke']);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[smoke\]/);
  assert.ok(result.stdout.includes(paths.storePath), 'the report must name the store path');

  const calls = podmanCalls();
  assert.equal(calls.length, 1, `expected one podman invocation, got: ${calls.join(' | ')}`);
  assert.ok(
    calls[0].includes(`run --rm ${DEFAULT_REF} /bin/bash -c`),
    `unexpected podman invocation: ${calls[0]}`,
  );
  assert.ok(calls[0].includes(`test -e ${paths.storePath}`), calls[0]);
  for (const mountFlag of ['-v ', '--volume', '--mount']) {
    assert.ok(
      !calls[0].includes(mountFlag),
      `the resolution check must not add a per-run mount (${mountFlag}): ${calls[0]}`,
    );
  }
});

test('smoke uses an explicit image reference override', () => {
  const result = runVerify(['smoke'], { FABRO_DARWIN_VERIFY_IMAGE: EXPLICIT_REF });

  assert.equal(result.status, 0, output(result));
  const calls = podmanCalls();
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes(`run --rm ${EXPLICIT_REF} /bin/bash -c`), calls[0]);
});

test('smoke fails with smoke_missing when the smoke command is absent', () => {
  const result = runVerify(['smoke'], {
    FABRO_DARWIN_VERIFY_SMOKE: path.join(workspace, 'absent-smoke'),
  });

  expectFailure(result, 'smoke_missing');
  assert.deepEqual(podmanCalls(), []);
});

test('smoke fails with smoke_failed when the smoke returns non-zero', () => {
  const result = runVerify(['smoke'], { STUB_SMOKE_FAIL: '1' });

  expectFailure(result, 'smoke_failed');
  assert.match(output(result), /\[build\]/, 'the smoke output must be relayed');
  assert.deepEqual(podmanCalls(), []);
});

test('smoke fails with smoke_output when the smoke prints no store path', () => {
  const result = runVerify(['smoke'], { STUB_SMOKE_STORE_PATH: '' });

  expectFailure(result, 'smoke_output');
  assert.deepEqual(podmanCalls(), []);
});

test('smoke fails with store_path_missing when the path is not in the guest store', () => {
  fs.rmSync(paths.storePath);
  const result = runVerify(['smoke']);

  expectFailure(result, 'store_path_missing');
  assert.deepEqual(podmanCalls(), [], 'an absent store path must not reach the sandbox step');
});

test('smoke fails with sandbox_resolution_failed when the sandbox cannot resolve the path', () => {
  const result = runVerify(['smoke'], { STUB_PODMAN_FAIL: '1' });

  expectFailure(result, 'sandbox_resolution_failed');
  assert.equal(podmanCalls().length, 1);
});

test('smoke fails with image_reference_missing when the digest is unavailable', () => {
  fs.rmSync(paths.digest);
  const result = runVerify(['smoke']);

  expectFailure(result, 'image_reference_missing');
  assert.ok(output(result).includes(paths.digest));
});

// --- all ----------------------------------------------------------------

test('all runs the guest observations and then the smoke', () => {
  const result = runVerify(['all']);

  assert.equal(result.status, 0, output(result));
  assert.match(result.stdout, /\[guest\]/);
  assert.match(result.stdout, /\[smoke\]/);
  assert.equal(podmanCalls().length, 1);
});

test('all stops at a failed guest observation before the smoke runs', () => {
  fs.writeFileSync(paths.statOutput, '644 root root\n');
  const result = runVerify(['all']);

  expectFailure(result, 'machines_permissions');
  assert.deepEqual(podmanCalls(), [], 'the smoke must not run after a failed guest observation');
});

// --- guest wiring --------------------------------------------------------

test('the guest installs fabro-darwin-dispatch-verify with its configured paths', () => {
  const report = JSON.parse(childProcess.execFileSync(
    'nix',
    [
      'eval',
      '--json',
      '--impure',
      '--expr',
      `let flake = builtins.getFlake (toString ${repoRoot}); in
       let cfg = flake.nixosConfigurations."fabro-vm".config; in
       {
         names = map (package: package.name) cfg.environment.systemPackages;
         machinesFile = cfg.fabro.darwinBuilder.machinesFile;
         hostName = cfg.fabro.darwinBuilder.machine.hostName;
       }`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));

  assert.ok(
    report.names.includes('fabro-darwin-dispatch-verify'),
    `the guest system packages must include fabro-darwin-dispatch-verify; got ${report.names.join(', ')}`,
  );

  const out = childProcess.execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '--impure',
      '--expr',
      `let
         flake = builtins.getFlake (toString ${repoRoot});
         packages = builtins.filter
           (package: package.name == "fabro-darwin-dispatch-verify")
           flake.nixosConfigurations."fabro-vm".config.environment.systemPackages;
       in builtins.head packages`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim().split('\n').pop();

  const script = fs.readFileSync(path.join(out, 'bin', 'fabro-darwin-dispatch-verify'), 'utf8');
  assert.ok(
    script.includes(report.machinesFile),
    'the installed verifier must default to the configured machines file',
  );
  assert.ok(
    script.includes(report.hostName),
    'the installed verifier must default to the configured builder tailnet name',
  );
});
// --- join-marker compatibility -------------------------------------------

test('the verifier waits for the join line the auth daemon still writes', () => {
  // The builder observation is only meaningful while the daemon logs the line
  // the verifier greps for. Build the wrapper from source so a wording change
  // fails this suite instead of silently making `builder` unpassable.
  const out = childProcess.execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '--impure',
      '--expr',
      `let
         flake = builtins.getFlake (toString ${repoRoot});
         pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
       in pkgs.callPackage ${repoRoot}/scripts/mac-builder-tailscale-auth.nix { }`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim().split('\n').pop();

  const script = fs.readFileSync(path.join(out, 'bin', 'mac-builder-tailscale-auth'), 'utf8');
  const marker = 'joining the tailnet as ${hostname} (${tag})';
  const markerIndex = script.indexOf(marker);
  assert.ok(markerIndex >= 0, `the daemon must log the verifier's join marker: ${marker}`);
  assert.ok(
    script.indexOf('"$tailscale_bin" up', markerIndex) > markerIndex,
    'the join marker must immediately precede the credential-driven tailscale up',
  );
  assert.ok(
    script.includes('--auth-key=') && script.includes('--advertise-tags='),
    'the join must be credential-driven and advertise the builder tag',
  );
});
