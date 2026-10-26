'use strict';

const fs = require('node:fs');
const path = require('node:path');

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

test('evaluated mac-builder host is an aarch64-darwin builder host', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      cfg = flake.darwinConfigurations.mac-builder.config;
    in
    {
      hostPlatform = cfg.nixpkgs.hostPlatform.system;
      trustedUsers = cfg.nix.settings.trusted-users;
      opensshEnable = cfg.services.openssh.enable;
      user = cfg.users.users.nix-builder;
      gcAutomatic = cfg.nix.gc.automatic;
      gcInterval = cfg.nix.gc.interval;
      gcOptions = cfg.nix.gc.options;
      sopsSecrets = builtins.attrNames cfg.sops.secrets;
      sopsSecret = cfg.sops.secrets."builder-authorized-keys";
      defaultSopsFile = cfg.sops.defaultSopsFile;
      hasLimaVM = cfg ? virtualisation.limaVM;
      hasVirtualisation = cfg ? virtualisation;
    }
  `);

  assert.equal(rendered.hostPlatform, 'aarch64-darwin');

  assert.equal(rendered.opensshEnable, true);

  assert.ok(
    rendered.trustedUsers.includes('nix-builder'),
    `expected nix-builder in trusted-users, got: ${JSON.stringify(rendered.trustedUsers)}`,
  );

  assert.equal(rendered.user.name, 'nix-builder');
  assert.equal(rendered.user.uid, 502);
  assert.equal(rendered.user.gid, 20);
  assert.equal(rendered.user.isHidden, true);
  assert.equal(rendered.user.createHome, true);
  assert.equal(rendered.user.home, '/Users/nix-builder');
  assert.equal(rendered.user.shell, '/bin/bash');
  assert.deepStrictEqual(rendered.user.extraGroups ?? [], []);
  assert.ok(
    !(rendered.user.extraGroups ?? []).includes('admin'),
    `nix-builder must not be an admin, got extraGroups: ${JSON.stringify(rendered.user.extraGroups)}`,
  );
  assert.ok(
    !(rendered.user.extraGroups ?? []).includes('wheel'),
    `nix-builder must not be in wheel, got extraGroups: ${JSON.stringify(rendered.user.extraGroups)}`,
  );

  assert.equal(rendered.gcAutomatic, true);
  assert.equal(rendered.gcInterval.Weekday, 0);
  assert.equal(rendered.gcInterval.Hour, 3);
  assert.equal(rendered.gcInterval.Minute, 15);
  assert.equal(rendered.gcOptions, '--delete-older-than 7d');

  assert.ok(
    rendered.sopsSecrets.includes('builder-authorized-keys'),
    `expected builder-authorized-keys sops secret, got: ${JSON.stringify(rendered.sopsSecrets)}`,
  );
  assert.equal(rendered.sopsSecret.mode, '0644');
  assert.equal(rendered.sopsSecret.owner, 'root');
  assert.equal(rendered.sopsSecret.group, 'root');
  assert.match(rendered.defaultSopsFile, /remote-builder\.mac-builder\.yaml$/);

  assert.equal(rendered.hasLimaVM, false);
  assert.equal(rendered.hasVirtualisation, false);
});

test('mac-builder configuration source has no Lima/image/provisioning/boot/FRE reference', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'configurations/mac-builder/default.nix'), 'utf8');
  assert.doesNotMatch(source, /lima/i);
  assert.doesNotMatch(source, /first[\s-]*run/i);
  assert.doesNotMatch(source, /\bFRE\b/);
  assert.doesNotMatch(source, /provision/i);
  assert.doesNotMatch(source, /boot/i);
});
