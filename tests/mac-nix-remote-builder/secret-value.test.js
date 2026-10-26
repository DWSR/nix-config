'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

const POISONED_VALUE = 'POISONED_BUILDER_SECRET_VALUE';

test('rendered builder artifacts expose secret paths but never the poisoned value', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      cfg = flake.darwinConfigurations.mac-builder.config;
      hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
    in
    {
      activationText =
        cfg.system.activationScripts.postActivation.text;
      deployText =
        builtins.readFile (hm.virtualisation.limaMacGuest._deploy + "/bin/mac-builder-deploy");
      guestYaml =
        builtins.readFile hm.virtualisation.limaMacGuest._configYaml;
    }
    `,
    { timeout: 600_000 },
  );

  assert.match(rendered.activationText, /secret_file="\/run\/secrets\/builder-authorized-keys"/);
  assert.match(rendered.activationText, /ssh_dir="\/Users\/nix-builder\/\.ssh"/);
  assert.match(rendered.activationText, /authorized_keys="\$ssh_dir\/authorized_keys"/);

  assert.match(rendered.deployText, /\/var\/lib\/sops-nix\/key\.txt/);

  for (const artifact of [rendered.activationText, rendered.deployText, rendered.guestYaml]) {
    assert.ok(
      !artifact.includes(POISONED_VALUE),
      'poisoned secret value leaked into a rendered artifact',
    );
  }
});

test('no rendered builder artifact contains the poisoned secret value', { timeout: 600_000 }, () => {
  const rendered = nixEvalJson(
    `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      cfg = flake.darwinConfigurations.mac-builder.config;
      hm = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
    in
    {
      activationText = cfg.system.activationScripts.postActivation.text;
      deployText = builtins.readFile (hm.virtualisation.limaMacGuest._deploy + "/bin/mac-builder-deploy");
      guestYaml = builtins.readFile hm.virtualisation.limaMacGuest._configYaml;
    }
    `,
    { timeout: 600_000 },
  );

  const artifacts = {
    activationText: rendered.activationText,
    deployText: rendered.deployText,
    guestYaml: rendered.guestYaml,
  };

  for (const [name, value] of Object.entries(artifacts)) {
    assert.equal(
      value.includes(POISONED_VALUE),
      false,
      `${POISONED_VALUE} leaked into ${name}`,
    );
  }

  assert.match(artifacts.activationText, /builder-authorized-keys/);
  assert.match(artifacts.deployText, /key\.txt/);
});
