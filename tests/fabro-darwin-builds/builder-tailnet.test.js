'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');
const dummyCredential = 'dummy-test-credential';

function authFixture(backendState, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fabro-builder-tailnet-'));
  const calls = path.join(directory, 'calls');
  const credential = path.join(directory, 'credential');
  const tailscale = path.join(directory, 'tailscale');
  if (options.credential !== false) fs.writeFileSync(credential, options.empty ? '' : dummyCredential);
  fs.writeFileSync(tailscale, `#!/bin/sh\nif [ "$1" = status ]; then\n  ${options.unresponsive ? 'exit 1' : `printf '%s\\n' '${JSON.stringify({ BackendState: backendState })}'`}\nelse\n  printf '%s\\n' "$@" > "$CALLS"\nfi\n`);
  fs.chmodSync(tailscale, 0o755);
  const expression = `let pkgs = import <nixpkgs> {}; in pkgs.callPackage ${JSON.stringify(path.join(repoRoot, 'scripts/mac-builder-tailscale-auth.nix'))} {}`;
  const executable = childProcess.execFileSync('nix', ['build', '--impure', '--no-link', '--print-out-paths', '--expr', expression], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 }).trim() + '/bin/mac-builder-tailscale-auth';
  const args = ['--auth-key-file', credential, '--hostname', 'mac-builder', '--tag', 'tag:mac-builder', '--tailscale', tailscale, '--once'];
  const run = () => childProcess.spawnSync(executable, args, { encoding: 'utf8', env: { ...process.env, CALLS: calls } });
  return { calls, credential, run };
}

function evaluateBuilder() {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    host = flake.darwinConfigurations.mac-builder;
    cfg = host.config;
  in builtins.toJSON {
    hostPlatform = cfg.nixpkgs.hostPlatform.system;
    extraPlatforms = cfg.nix.settings."extra-platforms" or null;
    trustedUsers = cfg.nix.settings.trusted-users;
    substituters = cfg.nix.settings.substituters;
    trustedPublicKeys = cfg.nix.settings.trusted-public-keys;
    extraSubstituters = cfg.nix.settings."extra-substituters" or [ ];
    postBuildHook = cfg.nix.settings."post-build-hook" or null;
    rootTrusted = builtins.elem "root" cfg.nix.settings.trusted-users;
    opensshEnable = cfg.services.openssh.enable;
    opensshExtraConfig = cfg.services.openssh.extraConfig;
    nixBuilder = {
      uid = cfg.users.users.nix-builder.uid;
      gid = cfg.users.users.nix-builder.gid;
      isAdmin = cfg.users.users.nix-builder.isAdmin or false;
    };
    rootAuthorizedKeys = cfg.users.users.root.openssh.authorizedKeys.keys or [ ];
    gcAutomatic = cfg.nix.gc.automatic;
    gcInterval = cfg.nix.gc.interval;
    gcOptions = cfg.nix.gc.options;
    optimiseAutomatic = cfg.nix.optimise.automatic;
    authorizedKeysSecret = cfg.sops.secrets."builder-authorized-keys";
    activation = cfg.system.activationScripts.postActivation.text;
    sopsPostActivation = cfg.system.activationScripts.postActivation.text;
    sopsDaemon = cfg.launchd.daemons.sops-install-secrets;
    launchdDaemons = builtins.attrNames cfg.launchd.daemons;
    nixDaemonNames = builtins.filter (name: builtins.match ".*nix-daemon.*" name != null) (builtins.attrNames cfg.launchd.daemons);
    deploy = flake.apps.aarch64-darwin.mac-builder-deploy.program;
    readiness = flake.apps.aarch64-darwin.mac-builder-readiness.program;
    tailscaleEnabled = cfg.services.tailscale.enable;
    tailscalePackagePath = builtins.unsafeDiscardStringContext (toString cfg.services.tailscale.package);
    defaultTailscalePackagePath = builtins.unsafeDiscardStringContext (toString host.pkgs.tailscale);
    authDaemon = cfg.launchd.daemons.mac-builder-tailscale-auth;
    secret = cfg.sops.secrets."builder-tailscale-oauth-secret";
    tailscaled = cfg.launchd.daemons.tailscaled;
    generatedTailscaledPlist = cfg.environment.launchDaemons."com.tailscale.tailscaled.plist";
    hmEnabled = cfg.home-manager.enable or false;
  }`;
  return JSON.parse(childProcess.execFileSync('nix', [
    'eval', '--impure', '--raw', '--expr', expression,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 }));
}

test('mac-builder tailnet module declares the open-source service and root-only OAuth secret', () => {
  const config = evaluateBuilder();

  assert.equal(config.hostPlatform, 'aarch64-darwin');
  assert.equal(config.extraPlatforms, null);
  assert.ok(config.trustedUsers.includes('nix-builder'));
  assert.equal(config.rootTrusted, true);
  assert.ok(config.trustedUsers.includes('nix-builder'));
  assert.equal(config.nixBuilder.isAdmin, false);
  assert.equal(config.nixBuilder.gid, 20);
  assert.deepEqual(config.rootAuthorizedKeys, []);
  assert.equal(config.opensshEnable, true);
  assert.match(config.opensshExtraConfig, /PermitRootLogin no/);
  assert.equal(config.nixBuilder.uid, 502);
  assert.equal(config.gcAutomatic, true);
  assert.equal(config.optimiseAutomatic, true);
  assert.equal(config.authorizedKeysSecret.path, '/run/secrets/builder-authorized-keys');
  assert.match(config.activation, /secret_file="\/run\/secrets\/builder-authorized-keys"/);
  assert.match(config.activation, /install -m 0600 -o nix-builder -g staff/);
  assert.match(config.sopsPostActivation, /sops-install-secrets/);
  assert.match(config.sopsPostActivation, /\/run\/secrets\/builder-authorized-keys/);
  assert.ok(config.sopsPostActivation.indexOf('sops-install-secrets') < config.sopsPostActivation.indexOf('secret_file="/run/secrets/builder-authorized-keys"'));
  assert.equal(config.sopsDaemon.serviceConfig.RunAtLoad, true);
  assert.equal(config.sopsDaemon.serviceConfig.KeepAlive, false);
  assert.ok(config.launchdDaemons.some(name => name.includes('nix-daemon')));
  assert.ok(config.nixDaemonNames.length > 0);
  assert.equal(typeof config.deploy, 'string');
  assert.equal(typeof config.readiness, 'string');
  assert.ok(config.deploy.endsWith('/bin/mac-builder-deploy'));
  assert.ok(config.readiness.endsWith('/bin/mac-builder-readiness'));
  assert.equal(config.tailscaleEnabled, true);
  assert.equal(config.tailscalePackagePath, config.defaultTailscalePackagePath);
  assert.equal(config.authDaemon.serviceConfig.ProgramArguments[config.authDaemon.serviceConfig.ProgramArguments.indexOf('--tailscale') + 1].split('/bin/')[0], config.defaultTailscalePackagePath);
  assert.equal(config.hmEnabled, false);
  assert.equal(config.secret.path, '/run/secrets/builder-tailscale-oauth-secret');
  assert.equal(config.secret.mode, '0400');
  assert.equal(config.secret.owner, 'root');
  assert.equal(config.secret.group, 'wheel');
  assert.equal(config.secret.key, 'builder-tailscale-oauth-secret');
  assert.equal(config.secret.name, 'builder-tailscale-oauth-secret');
});

test('mac-builder auth daemon invokes the wrapper with the exact credential and node identity', () => {
  const config = evaluateBuilder();
  const daemon = config.authDaemon;
  const args = daemon.serviceConfig.ProgramArguments;

  assert.equal(args[0].split('/').at(-1), 'mac-builder-tailscale-auth');
  assert.deepEqual(args.slice(1), [
    '--auth-key-file', '/run/secrets/builder-tailscale-oauth-secret',
    '--hostname', 'mac-builder',
    '--tag', 'tag:mac-builder',
    '--tailscale', args[args.indexOf('--tailscale') + 1],
  ]);
  assert.equal(args.some(arg => arg.startsWith('--auth-key=')), false);
  assert.match(args[args.indexOf('--tailscale') + 1], /\/tailscale$/);
  assert.equal(daemon.serviceConfig.RunAtLoad, true);
  assert.equal(daemon.serviceConfig.KeepAlive, true);
  assert.equal(daemon.serviceConfig.ThrottleInterval, 30);
  assert.equal(daemon.serviceConfig.ProcessType, 'Background');
  assert.match(daemon.serviceConfig.StandardOutPath, /^\/var\/log\//);
  assert.match(daemon.serviceConfig.StandardErrorPath, /^\/var\/log\//);

  assert.match(config.generatedTailscaledPlist.text, /<key>Label<\/key>\s*<string>com\.tailscale\.tailscaled<\/string>/);
  assert.match(config.generatedTailscaledPlist.text, /<key>ProgramArguments<\/key>/);
  assert.equal(config.generatedTailscaledPlist.target, 'com.tailscale.tailscaled.plist');
  assert.equal(config.tailscaled.command.endsWith('/bin/tailscaled'), true);
  assert.equal(config.tailscaled.serviceConfig.ProgramArguments.some(arg => arg === '--ssh'), false);
  assert.equal(config.tailscaled.serviceConfig.ProgramArguments.some(arg => arg.includes('auth-key')), false);
});

test('mac-builder endpoint has no bespoke build service, root SSH, or extra platforms', () => {
  const config = evaluateBuilder();
  assert.equal(config.extraPlatforms, null);
  assert.equal(config.rootTrusted, true);
  assert.ok(config.trustedUsers.includes('nix-builder'));
  assert.deepEqual(config.trustedUsers.filter(user => user !== 'root'), ['nix-builder']);
  assert.deepEqual(config.substituters, [
    'https://cache.nixos.org/',
    'https://nix-community.cachix.org',
  ]);
  assert.deepEqual(config.trustedPublicKeys, [
    'cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=',
    'nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs=',
  ]);
  assert.deepEqual(config.extraSubstituters, []);
  assert.equal(config.postBuildHook, null);
  assert.equal(config.substituters.some(value => /attic|private|\.internal/i.test(value)), false);
  assert.equal(config.trustedPublicKeys.some(value => /attic|private|\.internal/i.test(value)), false);
  assert.equal(config.nixBuilder.isAdmin, false);
  assert.match(config.opensshExtraConfig, /PermitRootLogin no/);
  assert.deepEqual(config.launchdDaemons.filter(name => /(?:^|[-.])(?!mac-builder-tailscale-auth)(?:build|queue|scheduler|api)(?:$|[-.])/i.test(name)), []);
});

test('mac-builder Tailscale auth --once handles Running without joining', () => {
  const fixture = authFixture('Running');
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(fixture.calls), false);
});

test('mac-builder Tailscale auth --once joins NeedsLogin with exact node arguments', () => {
  const fixture = authFixture('NeedsLogin');
  const result = fixture.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(fixture.calls, 'utf8').trim().split('\n'), [
    'up', `--auth-key=${dummyCredential}?ephemeral=false&preauthorized=true`,
    '--advertise-tags=tag:mac-builder', '--hostname=mac-builder', '--accept-dns=false',
  ]);
});

test('mac-builder Tailscale auth --once rejects missing credential without joining', () => {
  const fixture = authFixture('NeedsLogin', { credential: false });
  const result = fixture.run();
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes(fixture.credential), result.stderr);
  assert.equal(fs.existsSync(fixture.calls), false);
});

test('mac-builder Tailscale auth --once fails for an unresponsive daemon', () => {
  const fixture = authFixture('NeedsLogin', { unresponsive: true });
  assert.notEqual(fixture.run().status, 0);
});
