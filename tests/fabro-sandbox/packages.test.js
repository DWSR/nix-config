'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

// Evaluate the flake's `packages.aarch64-linux` bindings alongside the guest's
// own derivations, so the assertions prove the exposed packages resolve to the
// guest's sandbox image, digest, and smoke script rather than to lookalikes
// (Requirements 2.6, 6.3). The guest is `aarch64-linux`, but the package
// attributes evaluate on any host — the same `nixEvalJson` pattern the other
// fabro-sandbox tests use.
function sandboxPackages() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm;
      cfg = vm.config.fabro.sandboxImage;
      packages = flake.packages.aarch64-linux;
      smokeInstalled = builtins.head (
        builtins.filter (p: (p.name or "") == "fabro-sandbox-smoke")
          vm.config.environment.systemPackages
      );
    in
    {
      image = {
        present = packages ? fabro-sandbox-image;
        path = builtins.unsafeDiscardStringContext packages.fabro-sandbox-image.outPath;
        system = packages.fabro-sandbox-image.system;
      };
      digest = {
        present = packages ? fabro-sandbox-image-digest;
        path = builtins.unsafeDiscardStringContext packages.fabro-sandbox-image-digest.outPath;
        system = packages.fabro-sandbox-image-digest.system;
      };
      smoke = {
        present = packages ? fabro-sandbox-smoke;
        name = packages.fabro-sandbox-smoke.name;
        path = builtins.unsafeDiscardStringContext packages.fabro-sandbox-smoke.outPath;
        system = packages.fabro-sandbox-smoke.system;
      };
      guest = {
        archivePath = builtins.unsafeDiscardStringContext cfg.archive.outPath;
        digestPath = builtins.unsafeDiscardStringContext cfg.digest.outPath;
        smokePath = builtins.unsafeDiscardStringContext smokeInstalled.outPath;
      };
    }
  `);
}

test('fabro-sandbox-image is exposed and bound to the guest image archive', () => {
  const { image, guest } = sandboxPackages();
  // Requirement 2.6: the guest's sandbox image archive is reachable as a flake
  // package so it can be built outside a full guest switch.
  assert.equal(image.present, true, 'packages.aarch64-linux.fabro-sandbox-image must exist');
  assert.equal(image.system, 'aarch64-linux');
  assert.equal(
    image.path,
    guest.archivePath,
    'fabro-sandbox-image must resolve to the guest fabro.sandboxImage.archive',
  );
});

test('fabro-sandbox-image-digest is exposed and bound to the guest digest', () => {
  const { digest, guest } = sandboxPackages();
  // Requirement 2.6: the content digest derivation is exposed alongside the
  // archive it identifies.
  assert.equal(
    digest.present,
    true,
    'packages.aarch64-linux.fabro-sandbox-image-digest must exist',
  );
  assert.equal(digest.system, 'aarch64-linux');
  assert.equal(
    digest.path,
    guest.digestPath,
    'fabro-sandbox-image-digest must resolve to the guest fabro.sandboxImage.digest',
  );
});

test('fabro-sandbox-smoke is exposed and resolves to the smoke script', () => {
  const { smoke, guest } = sandboxPackages();
  // Requirement 6.3: the runtime smoke check is exposed as a flake package and
  // resolves to the same derivation the guest installs into systemPackages.
  assert.equal(smoke.present, true, 'packages.aarch64-linux.fabro-sandbox-smoke must exist');
  assert.equal(smoke.name, 'fabro-sandbox-smoke');
  assert.equal(smoke.system, 'aarch64-linux');
  assert.equal(
    smoke.path,
    guest.smokePath,
    'fabro-sandbox-smoke must resolve to the guest environment.systemPackages smoke script',
  );
});
