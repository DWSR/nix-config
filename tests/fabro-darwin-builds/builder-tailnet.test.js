'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '../..');

function evaluateBuilder(modulePath) {
  const expression = `let
    flake = builtins.getFlake (toString ${JSON.stringify(repoRoot)});
    extended = flake.darwinConfigurations.mac-builder.extendModules {
      modules = [ ${JSON.stringify(modulePath)} ];
    };
    cfg = extended.config;
  in builtins.toJSON {
    tailscaleEnabled = cfg.services.tailscale.enable;
    tailscalePackagePath = builtins.unsafeDiscardStringContext (toString cfg.services.tailscale.package);
    defaultTailscalePackagePath = builtins.unsafeDiscardStringContext (toString extended.pkgs.tailscale);
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
  const modulePath = path.join(repoRoot, 'configurations/mac-builder/tailscale.nix');
  const config = evaluateBuilder(modulePath);

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
  const modulePath = path.join(repoRoot, 'configurations/mac-builder/tailscale.nix');
  const config = evaluateBuilder(modulePath);
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
