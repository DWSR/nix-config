'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function evaluateBuilder() {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    host = flake.darwinConfigurations.mac-builder;
    cfg = host.config;
  in builtins.toJSON {
    hostPlatform = cfg.nixpkgs.hostPlatform.system;
    extraPlatforms = cfg.nix.settings."extra-platforms" or null;
    trustedUsers = cfg.nix.settings.trusted-users;
    opensshEnable = cfg.services.openssh.enable;
    opensshExtraConfig = cfg.services.openssh.extraConfig;
    nixBuilder = cfg.users.users.nix-builder;
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
