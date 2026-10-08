'use strict';

/*
 * hm-render.test.js — HM render assertions for the opencode-nono-sandbox
 * spec (Task 7.1). Renders the personal nix-darwin host via `nix eval --json` and
 * asserts the `programs.opencode-nono` module's emitted surface: the three
 * base profiles (each `extends ["default"]`, secret-free, no Keychain /
 * security / curl grants), profile content, host-specific labels, the
 * rendered metadata (incl. a `nonoVersion` that tracks `cfg.package.version`),
 * the operator guide, the `finalPackage` launcher override, the peer
 * assertion, and the invariant that the module makes NO opencode permission
 * or MCP-quarantine changes.
 *
 * Requirements: 2.1, 2.2, 2.3, 2.5, 4.1, 4.3, 4.5, 5.5, 6.3, 6.5, 7.3, 7.4.
 * Design: Testing Strategy "Integration Tests" (HM render + Profile content),
 * "Security Considerations" (Keychain/security/curl OUTSIDE the sandbox).
 *
 * The render assertions are pure `nix eval` of `xdg.configFile.<path>.text`
 * and `config.assertions` / `programs.opencode.settings` — these evaluate
 * inside the Nix check sandbox (no toplevel BUILD), matching the
 * subagent-context-budget precedent; `NIX_BUILD_TOP` gating is therefore
 * unnecessary here (we never trigger a heavy build).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../../..');
const NIX_COMMAND_TIMEOUT_MS = 600_000;
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
});
const PROFILE_KEYS = Object.freeze(['opencode-managed', 'opencode-audit', 'opencode-review']);

// Case-insensitive substring tokens that MUST NOT appear anywhere in a
// rendered profile's JSON text (R2.5 / R4.5 + design Security
// Considerations: Keychain/security/curl live OUTSIDE the sandbox).
const FORBIDDEN_GRANT_TOKENS = Object.freeze([
  'security',
  'keychain',
  '/usr/bin/security',
  'curl',
  '/usr/bin/curl',
  'deny_keychains',
]);

// Obvious secret-VALUE literal patterns. Env-var NAMES (e.g. ANTHROPIC_AUTH_TOKEN
// in allow_vars) are allowed; an actual `"apiKey": "<value>"` / token VALUE is not.
const SECRET_VALUE_PATTERNS = Object.freeze([
  /"api[_-]?key"\s*:\s*"[^"]+"/i,
  /"secret"\s*:\s*"[^"]+"/i,
  /"password"\s*:\s*"[^"]+"/i,
  /"auth[_-]?token"\s*:\s*"[^"]+"/i,
  /sk-[a-z0-9]{16,}/i,
]);

let renderCache;

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

// Render every artifact the assertions inspect: the three
// profile JSON texts (raw, so the forbidden-token scan runs over the literal
// serialized form), the metadata + guide texts, the launcher finalPackage
// name, the nono package name, and the live `config.assertions` list plus the
// opencode permission / mcp settings.
function liveRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = host: flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
      summarize = config:
        let
          nono = config.programs.opencode-nono;
          files = config.xdg.configFile;
          profileText = name: files."nono/profiles/\${name}.json".text;
        in
        {
          profileTexts = {
            "opencode-managed" = profileText nono.managedProfile;
            "opencode-audit" = profileText nono.auditProfile;
            "opencode-review" = profileText nono.reviewProfile;
          };
          metadataText = files."opencode/opencode-nono/metadata.json".text;
          guideText = files."opencode/opencode-nono/README.md".text;
          nonoPackageName = nono.package.name;
          launcherPackageName = config.programs.opencode.package.name;
          nonoInHomePackages = builtins.elem nono.package config.home.packages;
          assertions = map (a: { inherit (a) assertion message; }) config.assertions;
          permission = config.programs.opencode.settings.permission or null;
          mcp = config.programs.opencode.settings.mcp or null;
        };
    in
    {
      personal = summarize (hm "${HOSTS.personal}");
    }
  `;
}

// metadata + nono package name when `programs.opencode-nono.package` is
// overridden with pkgs.hello. Proves `nonoVersion = cfg.package.version`
// (R7.3 / R7.4) rather than a hardcoded "0.61.1".
function overriddenPackageExpr(host) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = flake.darwinConfigurations."${host}".pkgs;
      hm = (flake.darwinConfigurations."${host}".extendModules {
        modules = [
          ({ ... }: {
            home-manager.users.brandonmcnama.programs.opencode-nono.package = pkgs.hello;
          })
        ];
      }).config.home-manager.users.brandonmcnama;
    in
    {
      metadataText = hm.xdg.configFile."opencode/opencode-nono/metadata.json".text;
      packageName = hm.programs.opencode-nono.package.name;
      packageVersion = hm.programs.opencode-nono.package.version;
    }
  `;
}

// Render opencode permission/mcp settings with the nono module DISABLED
// (force enable = false) so test 12 can prove the module touches neither.
function nonoDisabledSettingsExpr(host) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = (flake.darwinConfigurations."${host}".extendModules {
        modules = [
          ({ lib, ... }: {
            home-manager.users.brandonmcnama.programs.opencode-nono.enable = lib.mkForce false;
          })
        ];
      }).config.home-manager.users.brandonmcnama;
    in
    {
      permission = hm.programs.opencode.settings.permission or null;
      mcp = hm.programs.opencode.settings.mcp or null;
    }
  `;
}

// Build a config where opencode-nono is enabled but the opencode peer is
// force-disabled, so the peer assertion's `assertion` is false. Evaluating
// `config.assertions` is a lazy list and does NOT throw.
function peerAssertionExpr(host) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = (flake.darwinConfigurations."${host}".extendModules {
        modules = [
          ({ lib, ... }: {
            home-manager.users.brandonmcnama.programs.opencode.enable = lib.mkForce false;
          })
        ];
      }).config.home-manager.users.brandonmcnama;
    in
    map (a: { inherit (a) assertion message; }) hm.assertions
  `;
}

function getRender() {
  if (!renderCache) {
    if (process.env.OPENCODE_NONO_HOSTS) {
      const rows = JSON.parse(fs.readFileSync(process.env.OPENCODE_NONO_HOSTS, 'utf8'));
      renderCache = { personal: rows.personal.nonoRender };
    } else {
      renderCache = nixEvalJson(liveRenderExpr());
    }
  }
  return renderCache;
}

// The no-keychain/no-secret scanner under test. Returns the list of tokens /
// patterns it flagged in `text`; empty list = clean. Exercised both over the
// real profile texts (must be empty) and over a fake poisoned string (the
// non-vacuity self-test below — must be non-empty).
function scanForbidden(text) {
  const lower = text.toLowerCase();
  const flagged = [];
  for (const token of FORBIDDEN_GRANT_TOKENS) {
    if (lower.includes(token.toLowerCase())) {
      flagged.push(token);
    }
  }
  for (const pattern of SECRET_VALUE_PATTERNS) {
    if (pattern.test(text)) {
      flagged.push(pattern.source);
    }
  }
  return flagged;
}

test('both hosts render three profiles that extend ["default"]', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of PROFILE_KEYS) {
      const text = host.profileTexts[key];
      assert.ok(text && text.length > 0, `${hostKey} must render ${key} profile`);
      const profile = JSON.parse(text);
      assert.deepEqual(profile.extends, ['default'], `${hostKey}/${key} must extend ["default"]`);
    }
  }
});

test('each rendered profile has meta name/version/description (R2.2)', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of PROFILE_KEYS) {
      const profile = JSON.parse(host.profileTexts[key]);
      assert.equal(profile.meta.name, key, `${hostKey}/${key} meta.name must equal its key`);
      assert.equal(typeof profile.meta.version, 'string');
      assert.equal(profile.meta.version, '0.1.0', `${hostKey}/${key} meta.version`);
      assert.equal(typeof profile.meta.description, 'string');
      assert.ok(profile.meta.description.length > 0, `${hostKey}/${key} meta.description non-empty`);
    }
  }
});

test('no rendered profile grants Keychain / security / curl or embeds secrets (R2.5/R4.5)', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of PROFILE_KEYS) {
      const text = host.profileTexts[key];
      const flagged = scanForbidden(text);
      assert.deepEqual(flagged, [], `${hostKey}/${key} must contain no forbidden grants/secrets, found: ${flagged}`);
    }
  }
});

test('opencode-managed profile content: groups, open_port, allow_vars (R4.1/R4.3)', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    const managed = JSON.parse(host.profileTexts['opencode-managed']);
    for (const group of ['node_runtime', 'nix_runtime', 'user_caches_macos']) {
      assert.ok(managed.groups.include.includes(group), `${hostKey}/managed groups.include must contain ${group}`);
    }
    // git_config is intentionally NOT included: git runs through the git-mcp
    // base server, so the sandbox grants no direct git config access.
    assert.ok(
      !managed.groups.include.includes('git_config'),
      `${hostKey}/managed groups.include must NOT contain git_config`,
    );
    assert.ok(Array.isArray(managed.network.open_port));
    assert.ok(managed.network.open_port.includes(8080), `${hostKey}/managed open_port must contain 8080`);
    assert.ok(Array.isArray(managed.environment.allow_vars));
    assert.ok(managed.environment.allow_vars.length > 0, `${hostKey}/managed allow_vars non-empty`);
    assert.ok(managed.environment.allow_vars.includes('OPENCODE_*'), `${hostKey}/managed allow_vars must include OPENCODE_*`);
    assert.ok(managed.environment.allow_vars.includes('DEFAULT_PROXY_BASE'), `${hostKey}/managed allow_vars must include DEFAULT_PROXY_BASE`);
  }
});

test('~/.local/logs has profile-appropriate sandbox access', () => {
  const rendered = getRender();
  const logsPath = '$HOME/.local/logs';

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of ['opencode-managed', 'opencode-audit']) {
      const profile = JSON.parse(host.profileTexts[key]);
      assert.ok(
        profile.filesystem.allow.includes(logsPath),
        `${hostKey}/${key} filesystem.allow must contain ${logsPath}`,
      );
    }

    const review = JSON.parse(host.profileTexts['opencode-review']);
    assert.ok(
      review.filesystem.read.includes(logsPath),
      `${hostKey}/opencode-review filesystem.read must contain ${logsPath}`,
    );
  }
});

test('git access is denied on every profile: no git_config group, ~/.config/git denied', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of PROFILE_KEYS) {
      const profile = JSON.parse(host.profileTexts[key]);
      assert.ok(
        !(profile.groups.include || []).includes('git_config'),
        `${hostKey}/${key} groups.include must NOT contain git_config (git runs via git-mcp)`,
      );
      assert.ok(
        ((profile.filesystem || {}).deny || []).includes('$HOME/.config/git'),
        `${hostKey}/${key} filesystem.deny must contain $HOME/.config/git`,
      );
    }
  }
});

// Regression guard for the CFUserTextEncoding bug: nono's filesystem.allow/
// read/write are directory-only (recursive dir grants). A single FILE placed
// there passes `nono profile validate` (schema-only) but aborts `nono run`
// with "<path> is not a directory" once the file exists. ~/.CFUserTextEncoding
// is a single macOS file, so it must be granted via a *_file key. This check
// is hermetic (pure render inspection) — unlike a `nono run --dry-run` gate it
// needs no sandbox init, so it holds in the flake-check build.
test('CFUserTextEncoding is granted as a single file, never in a directory key (regression)', () => {
  const rendered = getRender();
  const CF = '.CFUserTextEncoding';
  let grantedAsFile = false;

  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const key of PROFILE_KEYS) {
      const filesystem = JSON.parse(host.profileTexts[key]).filesystem || {};
      for (const dirKey of ['allow', 'read', 'write']) {
        for (const p of filesystem[dirKey] || []) {
          assert.ok(
            !p.includes(CF),
            `${hostKey}/${key}: ${CF} must not be in directory-only filesystem.${dirKey} — use a *_file key`,
          );
        }
      }
      for (const fileKey of ['allow_file', 'read_file', 'write_file']) {
        if ((filesystem[fileKey] || []).some((p) => p.includes(CF))) {
          grantedAsFile = true;
        }
      }
    }
  }

  // Non-vacuity: the catalog really does grant CF via a single-file key, so
  // the directory-key assertions above are meaningfully exercised (and the
  // CF startup read is not silently dropped).
  assert.ok(grantedAsFile, `${CF} must be granted via a *_file key on at least one profile`);
});

test('rendered metadata.json has the expected shape (R6.5/R7.4)', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    const metadata = JSON.parse(host.metadataText);
    assert.equal(typeof metadata.profileVersion, 'string');
    assert.ok(metadata.profileVersion.length > 0, `${hostKey} profileVersion non-empty`);
    assert.equal(metadata.defaultState, 'audit', `${hostKey} defaultState`);
    assert.ok(Array.isArray(metadata.profiles), `${hostKey} profiles is array`);
    assert.ok(metadata.profiles.length >= 3, `${hostKey} at least three profiles`);
    for (const p of metadata.profiles) {
      assert.equal(typeof p.name, 'string');
      assert.equal(typeof p.version, 'string');
    }
    assert.equal(typeof metadata.envContract, 'object');
    assert.ok(metadata.envContract !== null, `${hostKey} envContract present`);
    assert.equal(typeof metadata.nonoVersion, 'string');
    assert.ok(metadata.nonoVersion.length > 0, `${hostKey} nonoVersion non-empty`);
  }
});

test('nonoVersion reflects an overridden package version, not a hardcode (R7.3/R7.4)', () => {
  for (const [hostKey, host] of Object.entries(HOSTS)) {
    const overridden = nixEvalJson(overriddenPackageExpr(host));
    const metadata = JSON.parse(overridden.metadataText);
    assert.match(overridden.packageName, /^hello/, `${hostKey} override resolved to hello`);
    assert.equal(
      metadata.nonoVersion,
      overridden.packageVersion,
      `${hostKey} nonoVersion must equal the overridden package version`,
    );
    assert.notEqual(metadata.nonoVersion, '0.61.1', `${hostKey} nonoVersion must not stay the base 0.61.1`);
  }
});

test('operator guide renders the five required sections (R6.3)', () => {
  const rendered = getRender();

  const requiredHeadings = [
    /Profile selection/i,
    /Noninteractive launch/i,
    /Runtime overrides/i,
    /Rollback/i,
    /Combined RTK \+ nono/i,
  ];
  for (const [hostKey, host] of Object.entries(rendered)) {
    for (const heading of requiredHeadings) {
      assert.match(host.guideText, heading, `${hostKey} guide must contain ${heading}`);
    }
  }
});

test('nono package is installed and named "nono" (R1.1)', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.match(host.nonoPackageName, /^nono/, `${hostKey} opencode-nono.package.name must start with "nono"`);
    assert.equal(host.nonoInHomePackages, true, `${hostKey} nono package must be in home.packages`);
  }
});

test('finalPackage launcher override wires programs.opencode.package = "opencode"', () => {
  const rendered = getRender();

  for (const [hostKey, host] of Object.entries(rendered)) {
    assert.equal(host.launcherPackageName, 'opencode', `${hostKey} launcher package name`);
  }
});

test('peer assertion fires false (with its message) when programs.opencode.enable is forced off', () => {
  // Approach: force `programs.opencode.enable = false` via extendModules and
  // eval the full assertions list (a lazy list — evaluating it does NOT
  // throw). The opencode-nono peer assertion entry must then have
  // `assertion == false` and a message naming `programs.opencode.enable`.
  for (const [hostKey, host] of Object.entries(HOSTS)) {
    const assertions = nixEvalJson(peerAssertionExpr(host));
    const peer = assertions.find((a) => /programs\.opencode\.enable/.test(a.message)
      && /programs\.opencode-nono\.enable/.test(a.message));
    assert.ok(peer, `${hostKey} must expose the opencode-nono peer assertion`);
    assert.equal(peer.assertion, false, `${hostKey} peer assertion must be false when opencode disabled`);
    assert.match(peer.message, /programs\.opencode\.enable/, `${hostKey} peer message must mention programs.opencode.enable`);
  }
});

test('module makes no opencode permission or MCP-quarantine changes (R5.5)', () => {
  const rendered = getRender();

  for (const [hostKey, hostName] of Object.entries(HOSTS)) {
    const disabled = nixEvalJson(nonoDisabledSettingsExpr(hostName));
    assert.deepEqual(
      rendered[hostKey].permission,
      disabled.permission,
      `${hostKey} opencode permission must be identical enabled vs disabled`,
    );
    assert.deepEqual(
      rendered[hostKey].mcp,
      disabled.mcp,
      `${hostKey} opencode mcp settings must be identical enabled vs disabled`,
    );
  }
});

test('flake exposes the opencode-nono test check', () => {
  const flake = fs.readFileSync(path.join(repoRoot, 'flake.nix'), 'utf8');

  assert.match(flake, /opencode-nono-tests/);
  assert.match(flake, /node --test tests\/opencode-nono\//);
});

// --- Non-vacuity / negative self-tests -----------------------------------
// The Observable requires the harness to FAIL on a secret/keychain grant, a
// permission change, or a nonoVersion mismatch. These prove the detectors are
// non-vacuous WITHOUT mutating the real module.

test('keychain/secret scanner flags a poisoned profile (non-vacuity)', () => {
  const poisonedKeychain = JSON.stringify({
    extends: ['default'],
    filesystem: { allow: ['/usr/bin/security'] },
    deny_keychains: false,
  });
  const flaggedKeychain = scanForbidden(poisonedKeychain);
  assert.ok(flaggedKeychain.includes('/usr/bin/security'), 'scanner must flag /usr/bin/security');
  assert.ok(flaggedKeychain.includes('security'), 'scanner must flag security');
  assert.ok(flaggedKeychain.includes('deny_keychains'), 'scanner must flag deny_keychains');

  const poisonedCurl = JSON.stringify({ filesystem: { allow: ['/usr/bin/curl'] } });
  assert.ok(scanForbidden(poisonedCurl).includes('curl'), 'scanner must flag curl');

  const poisonedSecret = JSON.stringify({ env: { apiKey: 'sk-abcdef0123456789abcdef' } });
  const flaggedSecret = scanForbidden(poisonedSecret);
  assert.ok(flaggedSecret.length > 0, 'scanner must flag an embedded secret value');

  // And confirm a clean fragment with only env-var NAMES is NOT flagged.
  const clean = JSON.stringify({ environment: { allow_vars: ['ANTHROPIC_AUTH_TOKEN', 'OPENCODE_*'] } });
  assert.deepEqual(scanForbidden(clean), [], 'env-var NAMES must not be flagged as secrets/grants');
});

test('deepEqual permission guard would fail on a difference (non-vacuity)', () => {
  // Self-check proving the permission-equality assertion in
  // "module makes no opencode permission..." is a real guard: deepEqual of
  // differing objects throws.
  assert.throws(() => assert.deepEqual({ a: 1 }, { a: 2 }));
});
