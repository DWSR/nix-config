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
const flakePath = path.join(repoRoot, 'flake.nix');
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
const SIGNING_ENVIRONMENT_NAMES = Object.freeze([
  'GIT_SIGN_COMMITS',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_KEY_1',
  'GIT_CONFIG_VALUE_1',
  'GIT_CONFIG_KEY_2',
  'GIT_CONFIG_VALUE_2',
  'GIT_CONFIG_KEY_3',
  'GIT_CONFIG_VALUE_3',
  'SSH_SK_PROVIDER',
  'KEYCHAIN_CERTIFICATES',
  'GIT_MCP_SIGNING_CTK_HASH',
  'GIT_MCP_SIGNING_PUBLIC_KEY',
  'GIT_MCP_SIGNING_FINGERPRINT',
  'GIT_MCP_SIGNING_STUB',
]);
const ENROLLMENT = Object.freeze({
  stateDir: '/var/tmp/git-mcp-signing-fixture-state',
  identityLabel: 'git-mcp-signing-fixture',
  ctkPublicKeyHash: 'abcdefabcdefabcdefabcdefabcdefabcdefabcd',
  sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBGsX0fLhLEJH+Lzm5WOkQPJ3A32BLeszoPShOUXYmMKWT+NC4v4af5uO5+tKfA+eFivOM1drMV7Oy7ZAaDe/UfUAAAAEc3NoOg== fixture',
  sshFingerprint: 'SHA256:Sq6FPgsPWZc3RXSXKFq4uzEhPEwaHZCAoX46/7Q5024',
  githubSigningKeyRegistered: true,
});
const PERSONAL_ENROLLMENT = Object.freeze({
  identityLabel: 'git-mcp-Brandons-MacBook-Pro',
  ctkPublicKeyHash: 'b1e127793b64711c7559f1b6d5d41db292b6d96c',
  sshPublicKey: 'sk-ecdsa-sha2-nistp256@openssh.com AAAAInNrLWVjZHNhLXNoYTItbmlzdHAyNTZAb3BlbnNzaC5jb20AAAAIbmlzdHAyNTYAAABBBIiDRKcjop0g6wtGiK3xdz8HSUxkPKJgEmpAoouVF4EFDtcvXfkMtBmWNZJPb3K/455uE1X3JmIQpQMy1Lu8M5kAAAAEc3NoOg==',
  sshFingerprint: 'SHA256:dFsOKcsaspDUGy0LbSIJbDZmb0kq8F5jx00LUjw8buo',
  githubSigningKeyRegistered: true,
});
const MAX_SSH_PUBLIC_KEY_LINE_LENGTH = 64 * 1024;
const SSH_SK_P256_POINT_OFFSET = 54;
const SSH_SK_P256_POINT_LENGTH = 65;
const EXPECTED_HOST_GIT = Object.freeze({
  personal: Object.freeze({
    authorName: 'Brandon McNama',
    authorEmail: 'brandonmcnama@outlook.com',
    signingKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJtopEfMT4upVKkHhfZfGQojwVTtzxoTsxFLdMvAgDsl',
  }),
  shopify: Object.freeze({
    authorName: 'Brandon McNama',
    authorEmail: 'brandon.mcnama@shopify.com',
    signingKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIavhvh92uJLrqVXddjkTUNl1CTiqjxF03ADvjd0OFr2',
  }),
});
const EXPECTED_GLOBAL_GIT_SIGNING = Object.freeze({
  format: 'ssh',
  signByDefault: true,
  signer: '/Applications/1Password.app/Contents/MacOS/op-ssh-sign',
});
const EXPECTED_SSH = Object.freeze({
  extraConfig: 'IdentityAgent "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"',
  settings: Object.freeze({
    header: 'Host *',
    ForwardAgent: false,
    AddKeysToAgent: 'no',
    ControlMaster: 'auto',
    ControlPath: '~/.ssh/master-%r@%n:%p',
    ControlPersist: 'no',
    HashKnownHosts: false,
    UserKnownHostsFile: '~/.ssh/known_hosts',
    ServerAliveInterval: 0,
    ServerAliveCountMax: 3,
    Compression: true,
  }),
});

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

function assertNixExpressionParses(source, description) {
  const result = childProcess.spawnSync('nix-instantiate', [
    '--parse',
    '--expr',
    source,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: NIX_COMMAND_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, `${description} is valid Nix source:\n${result.stderr}`);
}

function assertNixFixtureParses(source, description) {
  assertNixExpressionParses(`let
      pkgs = { runCommand = _: _: _: null; };
      not-an-interpolation = null;
${source}
    in 1`, description);
}

let cachedHostRender;

function realHostRender() {
  if (cachedHostRender === undefined) cachedHostRender = nixEvalJson(hostRenderExpr());
  return cachedHostRender;
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
          otherServerEnvironments = builtins.listToAttrs (
            map
              (server: {
                name = server.name;
                value = server.env or { };
              })
              (builtins.filter (server: server.name != "git-mcp") rendered.mcpServers)
          );
          signing = {
            enable = config.home.mcp.gitMcpSigning.enable;
            stateDir = config.home.mcp.gitMcpSigning.stateDir;
            stubPath = config.home.mcp.gitMcpSigning.stubPath;
          };
          adjacent = {
            git = {
              authorName = config.programs.git.settings.user.name;
              authorEmail = config.programs.git.settings.user.email;
              signingKey = config.programs.git.signing.key;
              format = config.programs.git.signing.format;
              signByDefault = config.programs.git.signing.signByDefault;
              signer = config.programs.git.signing.signer;
            };
            ssh = {
              extraConfig = config.programs.ssh.extraConfig;
              settings = config.programs.ssh.settings."*".data;
            };
          };
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
          ({ pkgs, lib, ... }:
            let
              signingFixtures = import ${JSON.stringify(signingFixturePath)} {
                inherit pkgs;
                signerPackage = import ${JSON.stringify(signerPackagePath)};
                adminPackage = import ${JSON.stringify(adminPackagePath)};
              };
            in
            {
              home-manager.users.brandonmcnama.home.mcp.enable = ${JSON.stringify(mcpEnabled)};
              home-manager.users.brandonmcnama.home.mcp.gitMcpSigning = lib.mkForce {
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
      gitMcpCount = builtins.length (
        builtins.filter (server: server.name == "git-mcp") rendered.mcpServers
      );
      otherServerEnvironments = builtins.listToAttrs (
        map
          (server: {
            name = server.name;
            value = server.env or { };
          })
          (builtins.filter (server: server.name != "git-mcp") rendered.mcpServers)
      );
      signerExecutable = builtins.unsafeDiscardStringContext "\${config.home.mcp.gitMcpSigning.signerPackage}/bin/git-mcp-secure-enclave-signer";
      signerProviderPath = builtins.unsafeDiscardStringContext config.home.mcp.gitMcpSigning.signerPackage.providerPath;
      packageNames = map (pkg: pkg.name or pkg.pname or "") config.home.packages;
      signing = {
        enable = config.home.mcp.gitMcpSigning.enable;
        stateDir = config.home.mcp.gitMcpSigning.stateDir;
        stubPath = config.home.mcp.gitMcpSigning.stubPath;
      };
      adjacent = {
        git = {
          authorName = config.programs.git.settings.user.name;
          authorEmail = config.programs.git.settings.user.email;
          signingKey = config.programs.git.signing.key;
          format = config.programs.git.signing.format;
          signByDefault = config.programs.git.signing.signByDefault;
          signer = config.programs.git.signing.signer;
        };
        ssh = {
          extraConfig = config.programs.ssh.extraConfig;
          settings = config.programs.ssh.settings."*".data;
        };
      };
    }
  `;
}

function enabledSigningFixtureSignerPackageExpr() {
  return `${signingFixtureBaseExpr()}
    config.home.mcp.gitMcpSigning.signerPackage
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
          signerProviderPath = builtins.unsafeDiscardStringContext signing.signerPackage.providerPath;
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
  assert.equal(Object.hasOwn(server.env, 'SSH_AUTH_SOCK'), false, `${hostKey} git-mcp does not render SSH_AUTH_SOCK`);
}

function signingGitMcpEnvironment(signerExecutable, signerProviderPath) {
  const stubPath = `${ENROLLMENT.stateDir}/identities/${ENROLLMENT.ctkPublicKeyHash}/id_ecdsa_sk_rk`;

  return {
    ...HARDENED_GIT_MCP_ENV,
    GIT_SIGN_COMMITS: 'true',
    GIT_CONFIG_COUNT: '4',
    GIT_CONFIG_KEY_0: 'commit.gpgSign',
    GIT_CONFIG_VALUE_0: 'true',
    GIT_CONFIG_KEY_1: 'gpg.format',
    GIT_CONFIG_VALUE_1: 'ssh',
    GIT_CONFIG_KEY_2: 'gpg.ssh.program',
    GIT_CONFIG_VALUE_2: signerExecutable,
    GIT_CONFIG_KEY_3: 'user.signingKey',
    GIT_CONFIG_VALUE_3: stubPath,
    SSH_SK_PROVIDER: signerProviderPath,
    KEYCHAIN_CERTIFICATES: ENROLLMENT.ctkPublicKeyHash,
    GIT_MCP_SIGNING_CTK_HASH: ENROLLMENT.ctkPublicKeyHash,
    GIT_MCP_SIGNING_PUBLIC_KEY: ENROLLMENT.sshPublicKey,
    GIT_MCP_SIGNING_FINGERPRINT: ENROLLMENT.sshFingerprint,
    GIT_MCP_SIGNING_STUB: stubPath,
  };
}

function assertNoSigningEnvironment(environment, description) {
  for (const name of SIGNING_ENVIRONMENT_NAMES) {
    assert.equal(Object.hasOwn(environment, name), false, `${description} does not render ${name}`);
  }
  assert.equal(Object.hasOwn(environment, 'SSH_AUTH_SOCK'), false, `${description} does not render SSH_AUTH_SOCK`);
}

function assertAdjacentGitAndSshConfig(adjacent, hostKey) {
  assert.deepEqual(adjacent.git, {
    ...EXPECTED_HOST_GIT[hostKey],
    ...EXPECTED_GLOBAL_GIT_SIGNING,
  }, `${hostKey} preserves its global Git author and 1Password signing configuration`);
  assert.deepEqual(adjacent.ssh, EXPECTED_SSH, `${hostKey} preserves its common 1Password SSH configuration`);
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

function skipNixLineComment(source, start) {
  const end = source.indexOf('\n', start + 1);
  return end === -1 ? source.length : end + 1;
}

function skipNixBlockComment(source, start) {
  const end = source.indexOf('*/', start + 2);

  assert.notEqual(end, -1, 'flake contains an unterminated block comment');
  return end + 2;
}

function skipNixDoubleString(source, start) {
  let index = start + 1;

  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
    } else if (source.startsWith('$$', index)) {
      index += 2;
    } else if (source.startsWith('${', index)) {
      index = skipNixInterpolation(source, index);
    } else if (source[index] === '"') {
      return index + 1;
    } else {
      index += 1;
    }
  }

  assert.fail('flake contains an unterminated double-quoted string');
}

function skipNixIndentedString(source, start) {
  let index = start + 2;

  while (index < source.length) {
    if (source.startsWith('$$', index)) {
      index += 2;
    } else if (source.startsWith("''", index)) {
      if (source[index + 2] === '\\') {
        index += 4;
      } else if (source[index + 2] === '$' || source[index + 2] === "'") {
        index += 3;
      } else {
        return index + 2;
      }
    } else if (source.startsWith('${', index)) {
      index = skipNixInterpolation(source, index);
    } else {
      index += 1;
    }
  }

  assert.fail('flake contains an unterminated indented string');
}

function skipNixInterpolation(source, start) {
  let depth = 1;
  let index = start + 2;

  while (index < source.length) {
    if (source[index] === '#') {
      index = skipNixLineComment(source, index);
    } else if (source.startsWith('/*', index)) {
      index = skipNixBlockComment(source, index);
    } else if (source[index] === '"') {
      index = skipNixDoubleString(source, index);
    } else if (source.startsWith("''", index)) {
      index = skipNixIndentedString(source, index);
    } else if (source[index] === '{') {
      depth += 1;
      index += 1;
    } else if (source[index] === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
    } else {
      index += 1;
    }
  }

  assert.fail('flake contains an unterminated string interpolation');
}

function isNixIdentifierStart(character) {
  return /[A-Za-z_]/.test(character);
}

function isNixIdentifierCharacter(character) {
  return /[A-Za-z0-9_'-]/.test(character);
}

function nixTokens(source) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const start = index;
    const character = source[index];

    if (/\s/.test(character)) {
      index += 1;
    } else if (character === '#') {
      index = skipNixLineComment(source, index);
    } else if (source.startsWith('/*', index)) {
      index = skipNixBlockComment(source, index);
    } else if (character === '"') {
      index = skipNixDoubleString(source, index);
      tokens.push({
        type: 'string',
        value: source.slice(start + 1, index - 1),
        start,
        end: index,
      });
    } else if (source.startsWith("''", index)) {
      index = skipNixIndentedString(source, index);
      tokens.push({ type: 'indented-string', start, end: index });
    } else if (isNixIdentifierStart(character)) {
      index += 1;
      while (index < source.length && isNixIdentifierCharacter(source[index])) index += 1;
      tokens.push({
        type: 'identifier',
        value: source.slice(start, index),
        start,
        end: index,
      });
    } else {
      index += 1;
      tokens.push({ type: 'punctuation', value: character, start, end: index });
    }
  }

  return tokens;
}

function matchingDelimiterEnd(tokens, start, opening, closing) {
  let depth = 0;

  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== 'punctuation') continue;
    if (token.value === opening) depth += 1;
    if (token.value === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function matchingDelimiterStart(tokens, end, opening, closing) {
  let depth = 0;

  for (let index = end; index >= 0; index -= 1) {
    const token = tokens[index];
    if (token.type !== 'punctuation') continue;
    if (token.value === closing) depth += 1;
    if (token.value === opening) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }

  return -1;
}

function matchingAttrsetEnd(tokens, start) {
  return matchingDelimiterEnd(tokens, start, '{', '}');
}

function directNativeBuildInputs(tokens, attrsetStart, attrsetEnd) {
  const candidates = [];
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let letDepth = 0;

  for (let index = attrsetStart + 1; index < attrsetEnd; index += 1) {
    const token = tokens[index];

    if (token.type === 'punctuation') {
      if (token.value === '{') braceDepth += 1;
      if (token.value === '}') braceDepth -= 1;
      if (token.value === '(') parenthesisDepth += 1;
      if (token.value === ')') parenthesisDepth -= 1;
      if (token.value === '[') bracketDepth += 1;
      if (token.value === ']') bracketDepth -= 1;
      continue;
    }

    if (token.type === 'identifier' && token.value === 'let') {
      letDepth += 1;
      continue;
    }
    if (token.type === 'identifier' && token.value === 'in' && letDepth > 0) {
      letDepth -= 1;
      continue;
    }

    const [name, equals, opening] = tokens.slice(index, index + 3);
    if (
      braceDepth !== 0 || parenthesisDepth !== 0 || bracketDepth !== 0 || letDepth !== 0
      || tokens[index - 1]?.value === '.'
      || name.type !== 'identifier' || name.value !== 'nativeBuildInputs'
      || equals.value !== '=' || opening.value !== '['
    ) continue;

    const end = matchingDelimiterEnd(tokens, index + 2, '[', ']');
    assert.notEqual(end, -1, 'git-mcp check has a balanced direct nativeBuildInputs list');
    assert.equal(tokens[end + 1]?.value, ';', 'git-mcp check terminates its direct nativeBuildInputs list');
    candidates.push({ start: index + 2, end });
  }

  assert.equal(candidates.length, 1, 'git-mcp check has exactly one direct nativeBuildInputs list');
  return candidates[0];
}

function directListPackageEntries(source, tokens, list) {
  const entries = [];

  for (let index = list.start + 1; index < list.end; index += 1) {
    const token = tokens[index];
    if (token.type !== 'identifier' || token.value !== 'pkgs') continue;

    const lineStart = source.lastIndexOf('\n', token.start) + 1;
    const lineEnd = source.indexOf('\n', token.end);
    entries.push(source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd).replace(/^[ \t]*/, ''));
  }

  return entries;
}

function checksResultAttrset(tokens) {
  const checksBindings = [];

  for (let index = 0; index < tokens.length - 3; index += 1) {
    const [checks, equals, forAllSystems, opening] = tokens.slice(index, index + 4);
    if (
      checks.type !== 'identifier' || checks.value !== 'checks'
      || equals.value !== '='
      || forAllSystems.type !== 'identifier' || forAllSystems.value !== 'forAllSystems'
      || opening.value !== '('
    ) continue;

    const closing = matchingDelimiterEnd(tokens, index + 3, '(', ')');

    assert.notEqual(closing, -1, 'checks = forAllSystems has balanced parentheses');
    checksBindings.push({ opening: index + 3, closing });
  }

  assert.equal(checksBindings.length, 1, 'flake defines exactly one checks = forAllSystems binding');
  const { opening, closing } = checksBindings[0];
  let terminalEnd = closing;

  while (tokens[terminalEnd - 1]?.value === ')') {
    const groupStart = matchingDelimiterStart(tokens, terminalEnd - 1, '(', ')');
    assert.notEqual(groupStart, -1, 'checks = forAllSystems has balanced terminal parentheses');
    terminalEnd -= 1;
  }

  const attrsetEnd = terminalEnd - 1;
  assert.equal(tokens[attrsetEnd]?.value, '}', 'checks = forAllSystems has a terminal recursive attrset');
  const attrsetStart = matchingDelimiterStart(tokens, attrsetEnd, '{', '}');

  assert.notEqual(attrsetStart, -1, 'checks = forAllSystems has a balanced terminal recursive attrset');
  assert.equal(tokens[attrsetStart - 1]?.value, 'rec', 'checks = forAllSystems ends with a recursive attrset');
  return { start: attrsetStart, end: attrsetEnd };
}

function gitMcpCheck(source = fs.readFileSync(flakePath, 'utf8')) {
  const tokens = nixTokens(source);
  const resultAttrset = checksResultAttrset(tokens);
  const candidates = [];
  let braceDepth = 0;
  let parenthesisDepth = 0;
  let bracketDepth = 0;
  let letDepth = 0;

  for (let index = resultAttrset.start + 1; index < resultAttrset.end; index += 1) {
    const token = tokens[index];

    if (token.type === 'punctuation') {
      if (token.value === '{') braceDepth += 1;
      if (token.value === '}') braceDepth -= 1;
      if (token.value === '(') parenthesisDepth += 1;
      if (token.value === ')') parenthesisDepth -= 1;
      if (token.value === '[') bracketDepth += 1;
      if (token.value === ']') bracketDepth -= 1;
      continue;
    }

    if (token.type === 'identifier' && token.value === 'let') {
      letDepth += 1;
      continue;
    }
    if (token.type === 'identifier' && token.value === 'in' && letDepth > 0) {
      letDepth -= 1;
      continue;
    }

    const [binding, equals, pkgs, dot, runCommand, name, attrset] = tokens.slice(index, index + 7);
    if (
      braceDepth !== 0 || parenthesisDepth !== 0 || bracketDepth !== 0 || letDepth !== 0
      || tokens[index - 1]?.value === '.'
      || binding.type !== 'identifier' || binding.value !== 'git-mcp'
      || equals.value !== '='
      || pkgs.type !== 'identifier' || pkgs.value !== 'pkgs'
      || dot.value !== '.'
      || runCommand.type !== 'identifier' || runCommand.value !== 'runCommand'
      || name.type !== 'string' || name.value !== 'git-mcp'
      || attrset.value !== '{'
    ) continue;

    const attrsetEnd = matchingAttrsetEnd(tokens, index + 6);

    assert.notEqual(attrsetEnd, -1, 'git-mcp check has a balanced runCommand attribute set');
    const shell = tokens[attrsetEnd + 1];
    const terminator = tokens[attrsetEnd + 2];

    assert.equal(shell?.type, 'indented-string', 'git-mcp check has a runCommand shell string');
    assert.equal(terminator?.value, ';', 'git-mcp check has its runCommand terminator');
    candidates.push({
      nativeBuildInputs: directListPackageEntries(
        source,
        tokens,
        directNativeBuildInputs(tokens, index + 6, attrsetEnd),
      ),
      shellBody: source.slice(shell.start + 2, shell.end - 2),
    });
  }

  assert.notEqual(candidates.length, 0, 'checks result defines a direct git-mcp check');
  assert.equal(candidates.length, 1, 'checks result has an ambiguous git-mcp check');
  return candidates[0];
}

function completeGitMcpCheckDecoy(marker) {
  return `          git-mcp =
            pkgs.runCommand "git-mcp"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                  pkgs.go
                  pkgs.stdenv.cc
                  pkgs.apple-sdk
                  pkgs.git
                  pkgs.openssh
                  pkgs.mcpproxy-go
                  pkgs.coreutils
                ];
              }
              ''
                cp -R \${./.} source
                chmod -R u+w source
                cd source
                go -C scripts/git-mcp-secure-enclave-signer test ./...
                go -C tests/git-mcp/fixtures test ./...
                node --test tests/git-mcp/fixtures/signing-tools.test.js
                node --test tests/git-mcp/signer-adapter.test.js
                node --test tests/git-mcp/hm-render.test.js
                node --test tests/git-mcp/admin-contract.test.js
                node --test tests/git-mcp/upstream-isolation.test.js
                printf '%s\\n' '${marker}'
              '';`;
}

function insertBeforeGitMcpBinding(flake, prefix) {
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const fixture = flake.replace(binding, `${prefix}\n${binding}`);

  assert.notEqual(fixture, flake, 'fixture inserts a preceding lexical decoy');
  return fixture;
}

test('git-mcp check extraction accepts a parenthesized terminal result attrset', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const start = flake.indexOf('        // rec {');
  const terminator = '\n        }\n      );';
  const end = flake.indexOf(terminator, start);

  assert.notEqual(start, -1, 'fixture finds the terminal recursive check attrset');
  assert.notEqual(end, -1, 'fixture finds the checks binding terminator');
  const fixture = `${flake.slice(0, start)}${flake.slice(start, end).replace(
    '        // rec {',
    '        // (rec {',
  )}\n        })\n      );${flake.slice(end + terminator.length)}`;

  assert.match(
    assertGitMcpCheckWiring(fixture),
    /node --test tests\/git-mcp\/upstream-isolation\.test\.js/,
  );
});

test('git-mcp check extraction requires commands in its executable shell body', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const command = 'cp -R ${./.} source';
  const checkStart = flake.indexOf(binding);
  const commandText = `\n                ${command}\n`;
  const commandStart = flake.indexOf(commandText, checkStart);

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  assert.notEqual(commandStart, -1, 'fixture finds the shell command to remove');
  const withoutCommand = `${flake.slice(0, commandStart)}\n${flake.slice(commandStart + commandText.length)}`;
  const attrsetEnd = withoutCommand.indexOf("\n              }\n              ''", checkStart);

  assert.notEqual(attrsetEnd, -1, 'fixture finds the git-mcp runCommand attribute set');
  const fixture = `${withoutCommand.slice(0, attrsetEnd)}
                passthru.inertCommand = ''
                ${command}
                '';
${withoutCommand.slice(attrsetEnd)}`;

  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has an exact executable command sequence/,
  );
});

test('git-mcp check extraction rejects commands in heredoc data', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const command = 'go -C scripts/git-mcp-secure-enclave-signer test ./...';
  const checkStart = flake.indexOf(binding);
  const commandText = `\n                ${command}\n`;
  const commandStart = flake.indexOf(commandText, checkStart);

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  assert.notEqual(commandStart, -1, 'fixture finds the Go signer test command');
  const fixture = `${flake.slice(0, commandStart)}\n                : <<'INERT_GO'\n                ${command}\n                INERT_GO\n${flake.slice(commandStart + commandText.length)}`;
  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has an exact executable command sequence/,
  );
});

test('git-mcp check extraction rejects commands after a space-indented heredoc delimiter', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const command = 'go -C scripts/git-mcp-secure-enclave-signer test ./...';
  const checkStart = flake.indexOf(binding);
  const commandText = `\n                ${command}\n`;
  const commandStart = flake.indexOf(commandText, checkStart);

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  assert.notEqual(commandStart, -1, 'fixture finds the Go signer test command');
  const fixture = flake.replace(
    commandText,
    `\n                : <<'INERT_GO'\n                 INERT_GO\n                ${command}\n                INERT_GO\n`,
  );

  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has an exact executable command sequence/,
  );
});

test('git-mcp check extraction preserves <<- tab-only heredoc terminators', () => {
  const tabStripped = executableShellLines('\n: <<-END\n\tignored\n\tEND\necho after\n');
  const exact = executableShellLines('\n: <<END\n\tignored\n\tEND\necho after\n');

  assert.deepEqual(tabStripped, ['', ': <<-END', 'echo after', '']);
  assert.deepEqual(exact, ['', ': <<END']);
});

test('git-mcp check extraction rejects continued no-op commands', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const checkStart = flake.indexOf(binding);
  const continuation = String.fromCharCode(92);

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  for (const command of [
    'go -C scripts/git-mcp-secure-enclave-signer test ./...',
    'go -C tests/git-mcp/fixtures test ./...',
  ]) {
    const commandText = `\n                ${command}\n`;
    const commandStart = flake.indexOf(commandText, checkStart);

    assert.notEqual(commandStart, -1, `fixture finds ${command}`);
    const fixture = `${flake.slice(0, commandStart)}\n                : ${continuation}\n                ${command}\n${flake.slice(commandStart + commandText.length)}`;
    assertNixExpressionParses(fixture, `continued no-op fixture for ${command}`);
    assert.throws(
      () => assertGitMcpCheckWiring(fixture),
      /git-mcp check has an exact executable command sequence/,
    );
  }
});

test('git-mcp check extraction rejects carriage-return suffixed commands', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const command = 'go -C scripts/git-mcp-secure-enclave-signer test ./...';
  const checkStart = flake.indexOf(binding);
  const commandText = `\n                ${command}\n`;
  const commandStart = flake.indexOf(commandText, checkStart);
  const carriageReturn = String.fromCharCode(13);

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  assert.notEqual(commandStart, -1, 'fixture finds the Go signer test command');
  const fixture = `${flake.slice(0, commandStart)}\n                ${command}${carriageReturn}\n${flake.slice(commandStart + commandText.length)}`;

  assertNixExpressionParses(fixture, 'carriage-return signer command fixture');
  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has an exact executable command sequence/,
  );
});

test('git-mcp check extraction requires direct native build inputs', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const checkStart = flake.indexOf(binding);
  const packages = [
    'pkgs.go',
    'pkgs.stdenv.cc',
    'pkgs.apple-sdk',
  ];

  assert.notEqual(checkStart, -1, 'fixture finds the git-mcp check');
  let fixture = flake;
  for (const packageName of packages) {
    const packageText = `\n                  ${packageName}\n`;
    const packageStart = fixture.indexOf(packageText, checkStart);

    assert.notEqual(packageStart, -1, `fixture finds ${packageName}`);
    fixture = `${fixture.slice(0, packageStart)}\n${fixture.slice(packageStart + packageText.length)}`;
  }

  const inputsStart = fixture.indexOf('\n                nativeBuildInputs = [', checkStart);
  assert.notEqual(inputsStart, -1, 'fixture finds the git-mcp nativeBuildInputs declaration');
  fixture = `${fixture.slice(0, inputsStart)}
                passthru.nativeBuildInputs = [
                  ${packages.join('\n                  ')}
                ];
${fixture.slice(inputsStart)}`;

  assertNixExpressionParses(fixture, 'passthru nativeBuildInputs fixture');
  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has required direct nativeBuildInputs entries/,
  );
});

for (const [context, wrap] of [
  ['block-comment', (decoy) => `          /*\n${decoy}\n          */`],
  ['double-string interpolation', (decoy) => `          ignored = "before \\" $\${not-an-interpolation} \${\n          let\n          # } ignored line-comment brace\n          /* { } ignored block-comment braces */\n${decoy}\n          in "ignored"\n          } after";`],
  ['indented-string interpolation', (decoy) => `          ignored = ''\n            literal ''\${not-an-interpolation} $\${not-an-interpolation} ''\\q\n            before \${let\n            # } ignored line-comment brace\n            /* { } ignored block-comment braces */\n${decoy}\n            in "ignored"}\n          '';`],
]) {
  test(`git-mcp check extraction ignores a complete ${context} decoy`, () => {
    const flake = fs.readFileSync(flakePath, 'utf8');
    const marker = `git-mcp-check-decoy-${context.replaceAll(' ', '-')}`;
    const decoy = wrap(completeGitMcpCheckDecoy(marker));
    const fixture = insertBeforeGitMcpBinding(flake, decoy);

    assertNixFixtureParses(decoy, `${context} decoy`);
    const check = assertGitMcpCheckWiring(fixture);
    const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
    const decoyStart = fixture.indexOf(binding);
    const actualStart = fixture.indexOf(binding, decoyStart + binding.length);

    assert.ok(decoyStart >= 0 && actualStart > decoyStart, 'fixture keeps a real binding after the decoy');
    assert.ok(fixture.indexOf(marker) < actualStart, 'fixture places the decoy before the real binding');
    assert.doesNotMatch(check, new RegExp(marker), `does not select the ${context} decoy`);
  });
}

for (const [context, createDecoy] of [
  ['dotted nested', (marker) => completeGitMcpCheckDecoy(marker).replace(
    '          git-mcp =',
    '          unrelated.git-mcp =',
  )],
  ['local-let', (marker) => `          unrelated =
            let
${completeGitMcpCheckDecoy(marker)}
            in
              null;`],
]) {
  test(`git-mcp check extraction ignores a valid ${context} decoy`, () => {
    const flake = fs.readFileSync(flakePath, 'utf8');
    const marker = `git-mcp-check-decoy-${context}`;
    const decoy = createDecoy(marker);
    const fixture = insertBeforeGitMcpBinding(flake, decoy);

    assertNixFixtureParses(decoy, `${context} decoy`);
    const check = assertGitMcpCheckWiring(fixture);

    assert.doesNotMatch(check, new RegExp(marker), `does not select the ${context} decoy`);
    assert.equal(check, assertGitMcpCheckWiring(flake), `selects the real check after the ${context} decoy`);
  });
}

test('git-mcp check extraction rejects duplicate direct candidates as ambiguous', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const decoy = completeGitMcpCheckDecoy('git-mcp-check-decoy-duplicate-direct');
  const fixture = insertBeforeGitMcpBinding(flake, decoy);

  assertNixFixtureParses(decoy, 'duplicate direct candidate');
  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /ambiguous git-mcp check/,
  );
});

test('git-mcp check extraction rejects a missing local terminator', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const terminator = "\n              '';";
  const checkStart = flake.indexOf(binding);
  const terminatorStart = flake.indexOf(terminator, checkStart);
  const fixture = `${flake.slice(0, terminatorStart)}\n              ''${flake.slice(terminatorStart + terminator.length)}`;

  assert.notEqual(checkStart, -1, 'fixture finds the real git-mcp binding');
  assert.notEqual(terminatorStart, -1, 'fixture removes the real git-mcp terminator');
  assert.notEqual(fixture.indexOf(terminator, terminatorStart), -1, 'fixture retains the following check terminator');
  assert.throws(
    () => assertGitMcpCheckWiring(fixture),
    /git-mcp check has its runCommand terminator/,
  );
});

function shellHeredocDelimiters(line) {
  const delimiters = [];
  let index = 0;
  let quote = null;

  while (index < line.length) {
    const character = line[index];

    if (quote !== null) {
      if (quote === '"' && character === '\\') {
        index += 2;
      } else if (character === quote) {
        quote = null;
        index += 1;
      } else {
        index += 1;
      }
      continue;
    }

    if (character === '\\') {
      index += 2;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      index += 1;
      continue;
    }
    if (character === '#') break;
    if (!line.startsWith('<<', index)) {
      index += 1;
      continue;
    }

    index += 2;
    const stripTabs = line[index] === '-';
    if (stripTabs) index += 1;
    while (/\s/.test(line[index] || '')) index += 1;

    const delimiterQuote = line[index];
    if (delimiterQuote === "'" || delimiterQuote === '"') {
      const delimiterStart = index + 1;
      index = delimiterStart;
      while (index < line.length && line[index] !== delimiterQuote) index += 1;
      assert.notEqual(index, line.length, 'git-mcp check has a terminated heredoc delimiter');
      delimiters.push({
        value: line.slice(delimiterStart, index),
        stripTabs,
      });
      index += 1;
      continue;
    }

    const delimiterStart = index;
    while (index < line.length && !/[\s;|&()<>]/.test(line[index])) index += 1;
    if (index > delimiterStart) {
      delimiters.push({
        value: line.slice(delimiterStart, index),
        stripTabs,
      });
    }
  }

  return delimiters;
}

function nixIndentedStringLines(shellBody) {
  const lines = shellBody.split('\n');
  let indentation = Infinity;

  for (const line of lines) {
    if (!/\S/.test(line)) continue;
    indentation = Math.min(indentation, line.match(/^[ \t]*/)[0].length);
  }

  if (!Number.isFinite(indentation)) return lines;
  return lines.map((line) => line.slice(Math.min(indentation, line.match(/^[ \t]*/)[0].length)));
}

function executableShellLines(shellBody) {
  const lines = [];
  const heredocDelimiters = [];

  for (const line of nixIndentedStringLines(shellBody)) {
    if (heredocDelimiters.length > 0) {
      const { stripTabs, value } = heredocDelimiters[0];
      const terminator = stripTabs ? line.replace(/^\t+/, '') : line;
      if (terminator === value) heredocDelimiters.shift();
      continue;
    }

    lines.push(line);
    heredocDelimiters.push(...shellHeredocDelimiters(line));
  }

  return lines;
}

function assertCheckCommandSequence(shellBody, commands) {
  const executableCommands = executableShellLines(shellBody)
    .map((line) => line.replace(/^[ \t]*/, ''))
    .filter((line) => line !== '' && !line.startsWith('#'));

  assert.deepEqual(executableCommands, commands, 'git-mcp check has an exact executable command sequence');
}

function assertGitMcpCheckWiring(source) {
  const { nativeBuildInputs, shellBody } = gitMcpCheck(source);
  const nodeSuites = [
    'node --test tests/git-mcp/fixtures/signing-tools.test.js',
    'node --test tests/git-mcp/signer-adapter.test.js',
    'node --test tests/git-mcp/hm-render.test.js',
    'node --test tests/git-mcp/admin-contract.test.js',
    'node --test tests/git-mcp/upstream-isolation.test.js',
    'node --test tests/git-mcp/acceptance-client.test.js',
  ];

  assert.ok(
    ['pkgs.go', 'pkgs.stdenv.cc', 'pkgs.apple-sdk'].every((entry) => nativeBuildInputs.includes(entry)),
    'git-mcp check has required direct nativeBuildInputs entries',
  );
  assertCheckCommandSequence(shellBody, [
    'export HOME=$(mktemp -d)',
    'export NIX_CONFIG="experimental-features = nix-command flakes"',
    'export GIT_MCP_CHECK_RUNTIME=1',
    'cp -R ${./.} source',
    'chmod -R u+w source',
    'cd source',
    'go -C scripts/git-mcp-secure-enclave-signer test ./...',
    'go -C tests/git-mcp/fixtures test ./...',
    ...nodeSuites,
    'touch $out',
  ]);
  return shellBody;
}

test('git-mcp check extraction accepts blank lines after the binding', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const binding = '          git-mcp =\n            pkgs.runCommand "git-mcp"';
  const fixture = flake.replace(
    binding,
    '          git-mcp =\n\n            \t\n            pkgs.runCommand "git-mcp"',
  );

  assert.notEqual(fixture, flake, 'fixture adds blank lines after the git-mcp binding');
  const check = assertGitMcpCheckWiring(fixture);
  assert.match(check, /node --test tests\/git-mcp\/upstream-isolation\.test\.js/);
  assert.doesNotMatch(check, /hammerspoon-keybindings/);
});

test('personal real-host signing renders its enrollment while Shopify remains disabled', () => {
  const rendered = realHostRender();
  const personal = rendered.personal;
  const shopify = rendered.shopify;

  assert.equal(personal.signing.enable, true, 'personal signing is enabled');
  assert.equal(
    personal.signing.stubPath,
    `${personal.signing.stateDir}/identities/${PERSONAL_ENROLLMENT.ctkPublicKeyHash}/id_ecdsa_sk_rk`,
    'personal signing derives the hash-keyed resident stub path',
  );
  assert.deepEqual(
    JSON.parse(personal.activeMarkerText),
    {
      stateDir: personal.signing.stateDir,
      ...PERSONAL_ENROLLMENT,
    },
    'personal signing renders the declared public enrollment marker',
  );
  assert.equal(personal.gitMcp.env.GIT_SIGN_COMMITS, 'true');
  assert.equal(personal.gitMcp.env.GIT_MCP_SIGNING_CTK_HASH, PERSONAL_ENROLLMENT.ctkPublicKeyHash);
  assert.equal(personal.gitMcp.env.GIT_MCP_SIGNING_PUBLIC_KEY, PERSONAL_ENROLLMENT.sshPublicKey);
  assert.equal(personal.gitMcp.env.GIT_MCP_SIGNING_FINGERPRINT, PERSONAL_ENROLLMENT.sshFingerprint);
  assert.equal(personal.gitMcp.env.GIT_MCP_SIGNING_STUB, personal.signing.stubPath);

  assert.ok(
    shopify.serverNames.includes('git-mcp'),
    'Shopify mcpproxy servers must include git-mcp as a base server',
  );
  assert.equal(shopify.gitMcpCount, 1, 'Shopify git-mcp must be registered exactly once');
  assertGitMcpServer(shopify.gitMcp, 'shopify');
  assertNoSigningEnvironment(shopify.gitMcp.env, 'shopify disabled git-mcp');
  for (const [serverName, environment] of Object.entries(shopify.otherServerEnvironments)) {
    assertNoSigningEnvironment(environment, `shopify ${serverName}`);
  }
  assertAdjacentGitAndSshConfig(shopify.adjacent, 'shopify');
  assert.equal(shopify.activeMarkerText, null, 'Shopify omits the inactive signing marker');

  for (const [hostKey, host] of Object.entries({ personal, shopify })) {
    assert.ok(
      host.serverNames.includes('git-mcp'),
      `${hostKey} mcpproxy servers must include git-mcp as a base server`,
    );
    assert.equal(host.gitMcpCount, 1, `${hostKey} git-mcp must be registered exactly once`);
    assertAdjacentGitAndSshConfig(host.adjacent, hostKey);
  }
});

test('real-host signing installs production tools so admin is runnable before enrollment', () => {
  const rendered = nixEvalJson(disabledSigningToolsExpr());

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.enable, hostKey === 'personal', `${hostKey} has the expected enrollment enablement`);
    assert.equal(host.signerPackageName, 'git-mcp-secure-enclave-signer', `${hostKey} uses the production signer default`);
    assert.equal(host.signerProviderPath, '/usr/lib/ssh-keychain.dylib', `${hostKey} uses the fixed Apple signing provider`);
    assert.equal(host.adminPackageName, 'git-mcp-secure-enclave-admin', `${hostKey} uses the production admin default`);
    assert.ok(host.packageNames.includes('git-mcp-secure-enclave-signer'), `${hostKey} installs the signer before enrollment`);
    assert.ok(host.packageNames.includes('git-mcp-secure-enclave-admin'), `${hostKey} installs the admin before enrollment`);
    assert.ok(
      host.packageNames.includes('git-mcp-secure-enclave-acceptance'),
      `${hostKey} installs the standalone acceptance client`,
    );
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

test('an isolated enabled declaration overlays exact signing configuration only onto git-mcp', () => {
  const disabled = realHostRender().personal;
  const rendered = nixEvalJson(enabledSigningFixtureExpr());

  assert.equal(rendered.activeMarkerPath, ACTIVE_MARKER_PATH);
  assert.deepEqual(rendered.activeMarker, ENROLLMENT);
  assert.equal(rendered.gitMcpCount, 1, 'enabled signing keeps one git-mcp registration');
  assert.deepEqual(
    rendered.gitMcpEnv,
    signingGitMcpEnvironment(rendered.signerExecutable, rendered.signerProviderPath),
    'enabled signing renders exactly the git-mcp-specific signing environment',
  );
  assert.equal(Object.hasOwn(rendered.gitMcpEnv, 'SSH_AUTH_SOCK'), false, 'enabled git-mcp does not render SSH_AUTH_SOCK');
  assert.deepEqual(
    rendered.otherServerEnvironments,
    disabled.otherServerEnvironments,
    'enabled signing does not change other upstream environments',
  );
  for (const [serverName, environment] of Object.entries(rendered.otherServerEnvironments)) {
    assertNoSigningEnvironment(environment, `enabled ${serverName}`);
  }
  assert.deepEqual(rendered.adjacent, disabled.adjacent, 'enabled signing does not change adjacent Git or SSH configuration');
  assertAdjacentGitAndSshConfig(rendered.adjacent, 'personal');
  assert.equal(rendered.signing.enable, true);
  assert.equal(rendered.signing.stateDir, ENROLLMENT.stateDir);
  assert.equal(
    rendered.signing.stubPath,
    `${ENROLLMENT.stateDir}/identities/${ENROLLMENT.ctkPublicKeyHash}/id_ecdsa_sk_rk`,
  );
  assert.ok(rendered.packageNames.includes('git-mcp-secure-enclave-signer'));
  assert.ok(rendered.packageNames.includes('git-mcp-secure-enclave-admin'));
  assert.ok(rendered.packageNames.includes('git-mcp-secure-enclave-acceptance'));
});

test('fixture-injected signerPackage installs the selected Go signer package', () => {
  const signerPackage = nixBuildOutPath(enabledSigningFixtureSignerPackageExpr());

  for (const executable of [
    path.join(signerPackage, 'bin', 'git-mcp-secure-enclave-signer'),
    path.join(signerPackage, 'libexec', 'git-mcp-secure-enclave-signer-worker'),
  ]) {
    assert.ok(fs.existsSync(executable), `signerPackage installs ${executable}`);
    assert.ok(fs.statSync(executable).mode & 0o111, `signerPackage makes ${executable} executable`);
  }
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

test('git-mcp check extraction ignores unrelated following comments', () => {
  const flake = fs.readFileSync(flakePath, 'utf8');
  const hammerspoonComment = '\n\n          # Renderer + syntax-gate verification for hammerspoon-keybindings';
  const rewordedComment = '\n\n          # An unrelated check follows this git-mcp contract';
  const fixture = flake.replace(hammerspoonComment, rewordedComment);

  assert.notEqual(fixture, flake, 'fixture rewords the unrelated Hammerspoon comment');
  assert.match(fixture, /git-mcp =\n\s+pkgs\.runCommand "git-mcp"/);
  const check = assertGitMcpCheckWiring(fixture);
  assert.match(check, /node --test tests\/git-mcp\/upstream-isolation\.test\.js/);
  assert.doesNotMatch(check, /hammerspoon-keybindings/);
});

test('git-mcp check uses Nix Go to run both Go modules before isolated Node suites', () => {
  assertGitMcpCheckWiring();
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
