'use strict';

/*
 * hm-render.test.js — render assertions for git-mcp as a base MCP server.
 *
 * git-mcp (cyanheads/git-mcp-server, security-reviewed) is registered in
 * `baseServers` (home-manager/mcp/default.nix), NOT in any host's
 * `extraServers`. This test renders BOTH nix-darwin hosts' mcp_config.json
 * and asserts that git-mcp is present on each host exactly once with the
 * hardened posture: stdio transport, stateless session mode, in-memory
 * storage provider. Presence on both hosts (with no host extraServers entry)
 * is the proof that it is a base server.
 *
 * Mirrors the tests/grep-app-mcp render harness; the eval is a pure
 * `nix eval` of the rendered config text, so it runs inside the Nix check
 * sandbox without a heavy build.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const signerPackagePath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-signer.nix');
const adminPackagePath = path.join(repoRoot, 'scripts/git-mcp-secure-enclave-admin.nix');
const signingFixturePath = path.join(repoRoot, 'tests/git-mcp/fixtures/signing-tools.nix');
const NIX_COMMAND_TIMEOUT_MS = 600_000;
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});
const ACTIVE_MARKER_PATH = 'git-mcp-secure-enclave-signing/active.json';
const HARDENED_GIT_MCP_ENV = Object.freeze({
  MCP_SESSION_MODE: 'stateless',
  STORAGE_PROVIDER_TYPE: 'in-memory',
});
const ENROLLMENT = Object.freeze({
  stateDir: '/var/tmp/git-mcp-signing-fixture-state',
  identityLabel: 'git-mcp-signing-fixture',
  ctkPublicKeyHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfUAAAAEc3NoOg== fixture',
  sshFingerprint: 'SHA256:Sq6FPgsPWZc3RXSXKFq4uzEhPEwaHZCAoX46/7Q5024',
  githubSigningKeyRegistered: true,
});
const MAX_SSH_PUBLIC_KEY_LINE_LENGTH = 64 * 1024;
const SSH_SK_P256_POINT_OFFSET = 54;
const SSH_SK_P256_POINT_LENGTH = 65;

function enrollmentPublicKey(base64) {
  const [keyType, , ...comment] = ENROLLMENT.sshPublicKey.split(' ');
  return [keyType, base64, ...comment].join(' ');
}

function enrollmentPublicKeyBlob() {
  return Buffer.from(ENROLLMENT.sshPublicKey.split(' ')[1], 'base64');
}

function enrollmentPublicKeyWithApplication(application) {
  const applicationLength = Buffer.alloc(4);
  applicationLength.writeUInt32BE(application.length);

  return enrollmentPublicKey(Buffer.concat([
    enrollmentPublicKeyBlob().subarray(0, SSH_SK_P256_POINT_OFFSET + SSH_SK_P256_POINT_LENGTH),
    applicationLength,
    application,
  ]).toString('base64'));
}

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
}

function nixBuildOutPath(expr) {
  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ).trim();
}

function nixEvalFailure(expr) {
  try {
    childProcess.execFileSync(
      'nix',
      ['eval', '--impure', '--raw', '--expr', expr],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: NIX_COMMAND_TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (error) {
    return [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
  }

  assert.fail('expected Nix evaluation to fail');
}

function hostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          rendered = builtins.fromJSON (builtins.unsafeDiscardStringContext config.xdg.configFile."mcpproxy/mcp_config.json".text);
          servers = builtins.listToAttrs (map (server: { name = server.name; value = server; }) rendered.mcpServers);
          gitMcpEntries = builtins.filter (server: server.name == "git-mcp") rendered.mcpServers;
        in
        {
          serverNames = builtins.attrNames servers;
          gitMcp = servers.git-mcp or null;
          gitMcpCount = builtins.length gitMcpEntries;
          activeMarkerText = config.xdg.configFile."${ACTIVE_MARKER_PATH}".text or null;
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function signingDeclaration(overrides = {}) {
  const declaration = {
    enable: true,
    ...ENROLLMENT,
    ...overrides,
  };

  return Object.entries(declaration)
    .map(([name, value]) => `${name} = ${JSON.stringify(value)};`)
    .join('\n');
}

function signingFixtureBaseExpr(overrides = {}, mcpEnabled = true, rawPackageOverrides = {}) {
  const packageDeclarations = Object.entries({
    signerPackage: 'signingFixtures.signerPackage',
    adminPackage: 'signingFixtures.adminPackage',
    ...rawPackageOverrides,
  })
    .map(([name, value]) => `${name} = ${value};`)
    .join('\n');

  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      fixture = flake.darwinConfigurations."${HOSTS.personal}".extendModules {
        modules = [
          ({ pkgs, ... }:
            let
              signingFixtures = import ${JSON.stringify(signingFixturePath)} {
                inherit pkgs;
                signerPackage = import ${JSON.stringify(signerPackagePath)};
                adminPackage = import ${JSON.stringify(adminPackagePath)};
              };
            in
            {
              home-manager.users.brandonmcnama.home.mcp.enable = ${JSON.stringify(mcpEnabled)};
              home-manager.users.brandonmcnama.home.mcp.gitMcpSigning = {
                ${signingDeclaration(overrides)}
                ${packageDeclarations}
              };
            })
        ];
      };
      config = fixture.config.home-manager.users.brandonmcnama;
      rendered = builtins.fromJSON (
        builtins.unsafeDiscardStringContext config.xdg.configFile."mcpproxy/mcp_config.json".text
      );
      servers = builtins.listToAttrs (map (server: { name = server.name; value = server; }) rendered.mcpServers);
    in
  `;
}

function enabledSigningFixtureExpr(overrides = {}) {
  return `${signingFixtureBaseExpr(overrides)}
    {
      activeMarker = builtins.fromJSON (
        builtins.unsafeDiscardStringContext config.xdg.configFile."${ACTIVE_MARKER_PATH}".text
      );
      activeMarkerPath = "${ACTIVE_MARKER_PATH}";
      gitMcpEnv = servers.git-mcp.env;
      packageNames = map (pkg: pkg.name or pkg.pname or "") config.home.packages;
      signing = {
        enable = config.home.mcp.gitMcpSigning.enable;
        stateDir = config.home.mcp.gitMcpSigning.stateDir;
        stubPath = config.home.mcp.gitMcpSigning.stubPath;
      };
    }
  `;
}

function invalidSigningFixtureExpr(overrides, mcpEnabled = true, rawPackageOverrides = {}) {
  return `${signingFixtureBaseExpr(overrides, mcpEnabled, rawPackageOverrides)}
    builtins.unsafeDiscardStringContext fixture.config.system.build.toplevel.drvPath
  `;
}

function disabledSigningToolsExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          signing = config.home.mcp.gitMcpSigning;
        in
        {
          enable = signing.enable;
          signerPackageName = signing.signerPackage.name or signing.signerPackage.pname or "";
          adminPackageName = signing.adminPackage.name or signing.adminPackage.pname or "";
          packageNames = map (pkg: pkg.name or pkg.pname or "") config.home.packages;
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function disabledAdminPackageExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      config = flake.darwinConfigurations."${HOSTS.personal}".config.home-manager.users.brandonmcnama;
    in
      config.home.mcp.gitMcpSigning.adminPackage
  `;
}

function assertGitMcpServer(server, hostKey) {
  assert.ok(server, `${hostKey} renders a git-mcp server`);
  assert.equal(server.name, 'git-mcp', `${hostKey} git-mcp server name`);
  assert.equal(server.protocol, 'stdio', `${hostKey} git-mcp uses stdio`);
  assert.equal(server.enabled, true, `${hostKey} git-mcp enabled`);
  assert.equal(server.quarantined, false, `${hostKey} git-mcp not quarantined`);
  assert.deepEqual(server.args, [], `${hostKey} git-mcp has no args`);
  assert.match(
    server.command,
    /\/[^/]*git-mcp-server-[^/]+\/bin\/git-mcp-server$/,
    `${hostKey} git-mcp command points at the git-mcp-server package binary`,
  );
  assert.deepEqual(server.env, HARDENED_GIT_MCP_ENV, `${hostKey} git-mcp has only the hardened environment`);
}

function resolveCommand(command) {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Continue searching the PATH.
    }
  }
  return null;
}

test('disabled real-host signing leaves git-mcp unchanged and omits the active marker', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.ok(
      host.serverNames.includes('git-mcp'),
      `${hostKey} mcpproxy servers must include git-mcp as a base server`,
    );
    assert.equal(host.gitMcpCount, 1, `${hostKey} git-mcp must be registered exactly once`);
    assertGitMcpServer(host.gitMcp, hostKey);
    assert.equal(host.activeMarkerText, null, `${hostKey} omits the inactive signing marker`);
  }
});

test('disabled real-host signing installs production tools so admin is runnable before enrollment', () => {
  const rendered = nixEvalJson(disabledSigningToolsExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.enable, false, `${hostKey} leaves signing disabled by default`);
    assert.equal(host.signerPackageName, 'git-mcp-secure-enclave-signer', `${hostKey} uses the production signer default`);
    assert.equal(host.adminPackageName, 'git-mcp-secure-enclave-admin', `${hostKey} uses the production admin default`);
    assert.ok(host.packageNames.includes('git-mcp-secure-enclave-signer'), `${hostKey} installs the signer before enrollment`);
    assert.ok(host.packageNames.includes('git-mcp-secure-enclave-admin'), `${hostKey} installs the admin before enrollment`);
  }

  const adminPath = path.join(nixBuildOutPath(disabledAdminPackageExpr()), 'bin', 'git-mcp-secure-enclave-admin');
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'git-mcp-admin-disabled-'));

  try {
    const result = childProcess.spawnSync(adminPath, [], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: temporaryHome,
        XDG_CONFIG_HOME: path.join(temporaryHome, '.config'),
        XDG_STATE_HOME: path.join(temporaryHome, '.local', 'state'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    });

    assert.ifError(result.error);
    assert.equal(result.status, 1, 'the admin CLI reaches its usage handler before enrollment');
    assert.match(result.stderr, /usage: bootstrap\|rotate/, 'the admin CLI emits usage without invoking host signing tools');
  } finally {
    fs.rmSync(temporaryHome, { force: true, recursive: true });
  }
});

test('an isolated enabled declaration renders only the exact non-secret active marker and derived stub path', () => {
  const rendered = nixEvalJson(enabledSigningFixtureExpr());

  assert.equal(rendered.activeMarkerPath, ACTIVE_MARKER_PATH);
  assert.deepEqual(rendered.activeMarker, ENROLLMENT);
  assert.deepEqual(rendered.gitMcpEnv, HARDENED_GIT_MCP_ENV, 'Task 4.1 does not add signing environment fields');
  assert.equal(rendered.signing.enable, true);
  assert.equal(rendered.signing.stateDir, ENROLLMENT.stateDir);
  assert.equal(
    rendered.signing.stubPath,
    `${ENROLLMENT.stateDir}/identities/${ENROLLMENT.ctkPublicKeyHash}/id_ecdsa_sk_rk`,
  );
  assert.ok(rendered.packageNames.includes('git-mcp-secure-enclave-signer'));
  assert.ok(rendered.packageNames.includes('git-mcp-secure-enclave-admin'));
});

test('an isolated enabled declaration accepts normal optional SSH-SK public-key comments', () => {
  const [keyType, base64] = ENROLLMENT.sshPublicKey.split(' ');

  for (const sshPublicKey of [
    `${keyType} ${base64}`,
    `${keyType} ${base64} fixture comment`,
  ]) {
    const rendered = nixEvalJson(enabledSigningFixtureExpr({ sshPublicKey }));
    assert.equal(rendered.activeMarker.sshPublicKey, sshPublicKey);
  }
});

test('enabled signing rejects incomplete, unregistered, and malformed declarations during Nix evaluation', () => {
  const invalidDeclarations = [
    ['missing identity label', { identityLabel: null }, /identityLabel to be set/],
    ['unregistered GitHub signing key', { githubSigningKeyRegistered: false }, /githubSigningKeyRegistered = true/],
    ['relative state directory', { stateDir: 'relative/state' }, /stateDir/],
    ['empty identity label', { identityLabel: '' }, /identityLabel/],
    ['uppercase CTK hash', { ctkPublicKeyHash: ENROLLMENT.ctkPublicKeyHash.toUpperCase() }, /ctkPublicKeyHash/],
    ['wrong SSH public key type', { sshPublicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixture' }, /sshPublicKey/],
    ['wrong SSH fingerprint prefix', { sshFingerprint: 'MD5:fixture' }, /sshFingerprint/],
  ];

  for (const [name, overrides, expectedMessage] of invalidDeclarations) {
    const output = nixEvalFailure(invalidSigningFixtureExpr(overrides));
    assert.match(output, expectedMessage, `${name} fails with the relevant signing option error`);
  }
});

test('enabled signing rejects incomplete declarations even when parent MCP is disabled', () => {
  const output = nixEvalFailure(invalidSigningFixtureExpr({ identityLabel: null }, false));
  assert.match(output, /identityLabel to be set/);
});

test('enabled signing validates state and package options even when parent MCP is disabled', () => {
  const invalidDeclarations = [
    ['relative state directory', { stateDir: 'relative/state' }, {}, /stateDir/],
    ['invalid signer package', {}, { signerPackage: '"not-a-package"' }, /signerPackage/],
    ['invalid admin package', {}, { adminPackage: '"not-a-package"' }, /adminPackage/],
  ];

  for (const [name, overrides, rawPackageOverrides, expectedMessage] of invalidDeclarations) {
    const output = nixEvalFailure(invalidSigningFixtureExpr(overrides, false, rawPackageOverrides));
    assert.match(output, expectedMessage, `${name} fails with the relevant signing option error`);
  }
});

test('enabled signing rejects malformed OpenSSH metadata before marker rendering', () => {
  const malformedMetadata = [
    ['truncated SSH public key blob', { sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAA' }, /sshPublicKey/],
    ['invalid SSH public key Base64', { sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAA*' }, /sshPublicKey/],
    ['non-canonical SSH public key Base64 padding', { sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAA=' }, /sshPublicKey/],
    ['SSH public key trailing whitespace', { sshPublicKey: `${ENROLLMENT.sshPublicKey} ` }, /sshPublicKey/],
    ['SSH public key trailing newline', { sshPublicKey: `${ENROLLMENT.sshPublicKey}\n` }, /sshPublicKey/],
    ['invalid SHA256 fingerprint encoding', { sshFingerprint: 'SHA256:====' }, /sshFingerprint/],
  ];

  for (const [name, overrides, expectedMessage] of malformedMetadata) {
    const output = nixEvalFailure(invalidSigningFixtureExpr(overrides));
    assert.match(output, expectedMessage, `${name} fails before an active marker can render`);
  }
});

test('enabled signing rejects an SSH-SK blob truncated by eight Base64 characters before marker rendering', () => {
  const base64 = ENROLLMENT.sshPublicKey.split(' ')[1];
  const output = nixEvalFailure(invalidSigningFixtureExpr({
    sshPublicKey: enrollmentPublicKey(base64.slice(0, -8)),
  }));
  assert.match(output, /sshPublicKey/);
});

test('enabled signing rejects an SSH-SK blob with trailing wire data before marker rendering', () => {
  const blob = Buffer.concat([enrollmentPublicKeyBlob(), Buffer.alloc(4)]);
  const output = nixEvalFailure(invalidSigningFixtureExpr({
    sshPublicKey: enrollmentPublicKey(blob.toString('base64')),
  }));
  assert.match(output, /sshPublicKey/);
});

test('enabled signing rejects a Base64-valid SSH-SK blob with an invalid P-256 point before marker rendering', () => {
  const blob = enrollmentPublicKeyBlob();
  blob.fill(0, SSH_SK_P256_POINT_OFFSET + 1, SSH_SK_P256_POINT_OFFSET + SSH_SK_P256_POINT_LENGTH);
  const output = nixEvalFailure(invalidSigningFixtureExpr({
    sshPublicKey: enrollmentPublicKey(blob.toString('base64')),
  }));
  assert.match(output, /sshPublicKey/);
});

test('enabled signing rejects an SSH-SK application containing a NUL byte', () => {
  const sshPublicKey = enrollmentPublicKeyWithApplication(Buffer.from('ssh:\0fixture'));
  const output = nixEvalFailure(invalidSigningFixtureExpr({ sshPublicKey }));
  assert.match(output, /sshPublicKey/);
});

test('enabled signing accepts a 16 KiB non-NUL SSH-SK application', () => {
  const application = Buffer.concat([
    Buffer.from('ssh:'),
    Buffer.alloc((16 * 1024) - Buffer.byteLength('ssh:'), 'a'),
  ]);
  const sshPublicKey = enrollmentPublicKeyWithApplication(application);
  const rendered = nixEvalJson(enabledSigningFixtureExpr({ sshPublicKey }));

  assert.equal(rendered.activeMarker.sshPublicKey, sshPublicKey);
});

test('enabled signing rejects SSH-SK key lines over 64 KiB without a stack overflow', () => {
  const application = Buffer.concat([
    Buffer.from('ssh:'),
    Buffer.alloc((48 * 1024) - Buffer.byteLength('ssh:'), 'a'),
  ]);
  const sshPublicKey = enrollmentPublicKeyWithApplication(application);
  assert.ok(Buffer.byteLength(sshPublicKey) > MAX_SSH_PUBLIC_KEY_LINE_LENGTH);

  const output = nixEvalFailure(invalidSigningFixtureExpr({ sshPublicKey }));
  assert.match(output, /sshPublicKey/);
  assert.doesNotMatch(output, /stack overflow/i);
});

test('enabled signing rejects unpadded partial SSH-SK Base64', () => {
  const base64 = ENROLLMENT.sshPublicKey.split(' ')[1].replace(/==$/, '');
  const output = nixEvalFailure(invalidSigningFixtureExpr({
    sshPublicKey: enrollmentPublicKey(base64),
  }));
  assert.match(output, /sshPublicKey/);
});

test('git-mcp check runtime exposes its Git, SSH, proxy, and process tools', {
  skip: process.env.GIT_MCP_CHECK_RUNTIME !== '1',
}, () => {
  const expectedCommands = [
    ['git', 'git'],
    ['ssh', 'openssh'],
    ['ssh-keygen', 'openssh'],
    ['mcpproxy', 'mcpproxy-go'],
    ['timeout', 'coreutils'],
    ['kill', 'coreutils'],
  ];

  for (const [command, packageName] of expectedCommands) {
    const resolved = resolveCommand(command);
    assert.ok(resolved, `${command} must be available in the git-mcp check PATH`);
    assert.match(
      resolved,
      new RegExp(`/nix/store/[^/]+-${packageName}-[^/]+/bin/${command}$`),
      `${command} must come from the ${packageName} Nix input`,
    );
  }
});
