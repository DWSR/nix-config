'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const acceptancePath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-acceptance.nix');
const adminPath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-admin.nix');
const nixTimeoutMs = 600_000;
const enrollment = Object.freeze({
  stateDir: 'STATE_DIR',
  identityLabel: 'git-mcp-test-host',
  ctkPublicKeyHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAtest',
  sshFingerprint: 'SHA256:test-fingerprint',
  githubSigningKeyRegistered: true,
});

function nixBuild(expression) {
  return childProcess.execFileSync(
    'nix',
    [
      'build',
      '--no-link',
      '--print-out-paths',
      '--impure',
      '--expr',
      expression,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: nixTimeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        NIX_CONFIG: 'experimental-features = nix-command flakes',
      },
    },
  ).trim();
}

function buildAcceptancePackage() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      admin = pkgs.callPackage ${JSON.stringify(adminPath)} { };
    in
      pkgs.callPackage ${JSON.stringify(acceptancePath)} { adminPackage = admin; }
  `);
}

function buildAcceptanceFixturePackage() {
  return nixBuild(`
    let
      flake = builtins.getFlake ${JSON.stringify(repoRoot)};
      pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
      fakeGit = pkgs.writeShellApplication {
        name = "git";
        runtimeInputs = [ pkgs.coreutils pkgs.gnugrep ];
        text = ''
          repo="";
          if [[ "''\${1:-}" == "-C" ]]; then
            repo="$2";
            shift 2;
          fi
          case "''\${1:-}" in
            rev-parse)
              if [[ "''\${2:-}" == "--show-toplevel" ]]; then
                printf '%s\\n' "$repo";
              elif [[ "''\${2:-}" == "HEAD" ]]; then
                [[ -f "$repo/.fake-commit-count" ]] || exit 1;
                printf '%040d\\n' "$(<"$repo/.fake-commit-count")";
              fi
              ;;
            config)
              case "''\${3:-}" in
                user.name) printf '%s\\n' 'Fixture Operator' ;;
                user.email) printf '%s\\n' 'fixture@example.test' ;;
              esac
              ;;
            diff-tree)
              printf '%s\\n' '.git-mcp-secure-enclave-acceptance/unlocked.txt';
              ;;
            verify-commit)
              allowed_signers="";
              for argument in "$@"; do
                case "$argument" in
                  gpg.ssh.allowedSignersFile=*) allowed_signers="''\${argument#gpg.ssh.allowedSignersFile=}" ;;
                esac
              done
              grep -Fx 'git-mcp-test-host namespaces="git" sk-ecdsa-sha2-nistp256@openssh.com AAAAtest' "$allowed_signers" >/dev/null \
                || exit 1
              printf '%s\\n' 'Good "git" signature for git-mcp-test-host with ED25519 key SHA256:test-fingerprint';
              ;;
            show)
              if [[ " $* " == *'%cI'* ]]; then
                printf '%s\\n' '2026-09-14T12:00:00+00:00';
              else
                printf '%s\\n' 'Fixture Operator <fixture@example.test>';
              fi
              ;;
            *)
              ;;
          esac
        '';
      };
      fakeCurl = pkgs.writeShellApplication {
        name = "curl";
        text = ''
          printf '%s\\n' '{"status":"ok"}';
        '';
      };
      fakeMcpproxy = pkgs.writeShellApplication {
        name = "mcpproxy";
        runtimeInputs = [ pkgs.jq ];
        text = ''
          invocation=" $* ";
          [[ "$invocation" == *" --data-dir "* ]] \
            || { printf '%s\n' 'missing mcpproxy data-dir' >&2; exit 2; }
          [[ "$invocation" == *" call tool-write --config $HOME/.mcpproxy/runtime-config/mcp_config.json "* ]] \
            || { printf '%s\n' 'missing mcpproxy runtime config' >&2; exit 2; }
          [[ "$invocation" == *" --tool-name=git-mcp:git_commit "* ]] \
            || { printf '%s\n' 'missing git-mcp commit tool' >&2; exit 2; }
          [[ "$invocation" == *" --timeout=75s "* ]] \
            || { printf '%s\n' 'missing mcpproxy timeout' >&2; exit 2; }
          json_args="";
          for argument in "$@"; do
            case "$argument" in
              --json_args=*) json_args="''\${argument#--json_args=}" ;;
            esac
          done
          jq -e '.path and .message and (.filesToStage | length == 1)' <<< "$json_args" >/dev/null
          repo="$(jq -r .path <<< "$json_args")";
          count_file="$repo/.fake-commit-count";
          count=0;
          if [[ -f "$count_file" ]]; then count="$(<"$count_file")"; fi
          printf '%s\\n' "$((count + 1))" > "$count_file";
          printf '%s\\n' '{}';
        '';
      };
      fakeAdmin = pkgs.writeShellApplication {
        name = "git-mcp-secure-enclave-admin";
        text = ''
          exit 0;
        '';
      };
    in
      pkgs.callPackage ${JSON.stringify(acceptancePath)} {
        adminPackage = fakeAdmin;
        curl = fakeCurl;
        git = fakeGit;
        "mcpproxy-go" = fakeMcpproxy;
      }
  `);
}

function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-acceptance-client-'));
  const configHome = path.join(root, 'config');
  const stateHome = path.join(root, 'state');
  const repo = path.join(root, 'repo');
  const stateDir = path.join(stateHome, 'git-mcp-secure-enclave-signing');
  const identityDir = path.join(stateDir, 'identities', enrollment.ctkPublicKeyHash);
  const markerDir = path.join(configHome, 'git-mcp-secure-enclave-signing');
  const mcpConfigDir = path.join(configHome, 'mcpproxy');
  const runtimeConfigDir = path.join(root, '.mcpproxy', 'runtime-config');

  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(identityDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(mcpConfigDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeConfigDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(identityDir, 'id_ecdsa_sk_rk'), 'fixture resident handle\n', { mode: 0o600 });
  fs.writeFileSync(path.join(identityDir, 'id_ecdsa_sk_rk.pub'), `${enrollment.sshPublicKey}\n`, { mode: 0o644 });
  fs.writeFileSync(
    path.join(markerDir, 'active.json'),
    `${JSON.stringify({ ...enrollment, stateDir }, null, 2)}\n`,
    { mode: 0o644 },
  );
  fs.writeFileSync(
    path.join(mcpConfigDir, 'mcp_config.json'),
    `${JSON.stringify({
      listen: '127.0.0.1:8080',
      mcpServers: [{
        name: 'git-mcp',
        env: {
          GIT_SIGN_COMMITS: 'true',
          GIT_CONFIG_COUNT: '4',
          GIT_CONFIG_KEY_0: 'commit.gpgSign',
          GIT_CONFIG_VALUE_0: 'true',
          GIT_CONFIG_KEY_1: 'gpg.format',
          GIT_CONFIG_VALUE_1: 'ssh',
          GIT_CONFIG_KEY_2: 'gpg.ssh.program',
          GIT_CONFIG_VALUE_2: '/nix/store/fixture-signer/bin/git-mcp-secure-enclave-signer',
          GIT_CONFIG_KEY_3: 'user.signingKey',
          GIT_CONFIG_VALUE_3: path.join(stateDir, 'identities', enrollment.ctkPublicKeyHash, 'id_ecdsa_sk_rk'),
          SSH_SK_PROVIDER: '/usr/lib/ssh-keychain.dylib',
          KEYCHAIN_CERTIFICATES: enrollment.ctkPublicKeyHash,
          GIT_MCP_SIGNING_CTK_HASH: enrollment.ctkPublicKeyHash,
          GIT_MCP_SIGNING_PUBLIC_KEY: enrollment.sshPublicKey,
          GIT_MCP_SIGNING_FINGERPRINT: enrollment.sshFingerprint,
          GIT_MCP_SIGNING_STUB: path.join(stateDir, 'identities', enrollment.ctkPublicKeyHash, 'id_ecdsa_sk_rk'),
          MCP_SESSION_MODE: 'stateless',
          STORAGE_PROVIDER_TYPE: 'in-memory',
        },
      }],
    }, null, 2)}\n`,
    { mode: 0o644 },
  );
  fs.copyFileSync(
    path.join(mcpConfigDir, 'mcp_config.json'),
    path.join(runtimeConfigDir, 'mcp_config.json'),
  );
  childProcess.execFileSync('git', ['init', '--quiet', '--initial-branch=main', repo]);
  childProcess.execFileSync('git', ['-C', repo, 'config', 'user.name', 'Fixture Operator']);
  childProcess.execFileSync('git', ['-C', repo, 'config', 'user.email', 'fixture@example.test']);

  return {
    root,
    repo,
    env: {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: configHome,
      XDG_STATE_HOME: stateHome,
    },
  };
}

test('standalone acceptance client emits the git-mcp commit request without OpenCode', () => {
  const packagePath = buildAcceptancePackage();
  const fixture = createFixture();

  try {
    const output = childProcess.execFileSync(
      path.join(packagePath, 'bin/git-mcp-secure-enclave-acceptance'),
      [
        'probe',
        '--repo', fixture.repo,
        '--state', 'unlocked',
        '--dry-run',
      ],
      {
        cwd: repoRoot,
        env: fixture.env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const request = JSON.parse(output);

    assert.deepEqual(request.tool, 'git-mcp:git_commit');
    assert.equal(request.args.path, fs.realpathSync(fixture.repo));
    assert.equal(request.args.filesToStage[0], '.git-mcp-secure-enclave-acceptance/unlocked.txt');
    assert.match(request.args.message, /secure enclave acceptance unlocked/);
    assert.equal(fs.existsSync(path.join(fixture.repo, '.git-mcp-secure-enclave-acceptance')), false);
    assert.doesNotMatch(output, /opencode/i);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('standalone acceptance client rejects an unknown physical state', () => {
  const packagePath = buildAcceptancePackage();
  const fixture = createFixture();

  try {
    assert.throws(
      () => childProcess.execFileSync(
        path.join(packagePath, 'bin/git-mcp-secure-enclave-acceptance'),
        ['probe', '--repo', fixture.repo, '--state', 'interactive-agent'],
        {
          cwd: repoRoot,
          env: fixture.env,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
      /invalid probe state/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('standalone acceptance client refuses a pre-staged index', () => {
  const packagePath = buildAcceptancePackage();
  const fixture = createFixture();

  try {
    fs.writeFileSync(path.join(fixture.repo, 'pre-staged.txt'), 'must not be committed\n');
    childProcess.execFileSync('git', ['-C', fixture.repo, 'add', 'pre-staged.txt']);
    assert.throws(
      () => childProcess.execFileSync(
        path.join(packagePath, 'bin/git-mcp-secure-enclave-acceptance'),
        ['probe', '--repo', fixture.repo, '--state', 'unlocked', '--dry-run'],
        {
          cwd: repoRoot,
          env: fixture.env,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
      /pre-staged files/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('standalone acceptance client calls mcpproxy and records public evidence', () => {
  const packagePath = buildAcceptanceFixturePackage();
  const fixture = createFixture();

  try {
    const output = childProcess.execFileSync(
      path.join(packagePath, 'bin/git-mcp-secure-enclave-acceptance'),
      ['probe', '--repo', fixture.repo, '--state', 'unlocked'],
      {
        cwd: repoRoot,
        env: fixture.env,
        encoding: 'utf8',
        timeout: 30_000,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const evidencePath = path.join(
      fixture.env.XDG_STATE_HOME,
      'git-mcp-secure-enclave-signing',
      'acceptance-probes',
      `${enrollment.ctkPublicKeyHash}.json`,
    );
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));

    assert.match(output, /The commit was created by git-mcp through mcpproxy/);
    assert.equal(fs.readFileSync(path.join(fixture.repo, '.fake-commit-count'), 'utf8').trim(), '1');
    assert.equal(evidence.probes.unlocked.result, 'verified');
    assert.match(evidence.probes.unlocked.commit, /^0+1$/);
    assert.equal(evidence.sshFingerprint, enrollment.sshFingerprint);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('standalone acceptance client requires all five probes before recording', () => {
  const packagePath = buildAcceptanceFixturePackage();
  const fixture = createFixture();
  const evidencePath = path.join(
    fixture.env.XDG_STATE_HOME,
    'git-mcp-secure-enclave-signing',
    'acceptance-probes',
    `${enrollment.ctkPublicKeyHash}.json`,
  );

  try {
    fs.mkdirSync(path.dirname(evidencePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(evidencePath, `${JSON.stringify({
      ctkPublicKeyHash: enrollment.ctkPublicKeyHash,
      repo: fixture.repo,
      probes: {
        unlocked: { commit: '1'.repeat(40), result: 'verified' },
      },
    })}\n`);
    assert.throws(
      () => childProcess.execFileSync(
        path.join(packagePath, 'bin/git-mcp-secure-enclave-acceptance'),
        ['record', '--evidence', evidencePath, '--github-verified'],
        {
          cwd: repoRoot,
          env: fixture.env,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
      /five verified, distinct probe commits/,
    );
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
