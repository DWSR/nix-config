'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

// Evaluate the guest's systemd units, containers.conf mounts, and Fabro
// settings through the flake, so the assertions read the NixOS-evaluated
// wiring rather than the module source. The loader/reconciler scripts are read
// as text (they are shell bodies embedded in Nix) for the behavioural flow
// assertions.
function guest() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.config;
      cfg = vm.fabro.sandboxImage;
    in
    {
      mounts = vm.virtualisation.containers.containersConf.settings.containers.mounts;
      loader = {
        type = vm.systemd.services."fabro-sandbox-image-load".serviceConfig.Type;
        remainAfterExit = vm.systemd.services."fabro-sandbox-image-load".serviceConfig.RemainAfterExit;
        wantedBy = vm.systemd.services."fabro-sandbox-image-load".wantedBy;
        after = vm.systemd.services."fabro-sandbox-image-load".after;
        requires = vm.systemd.services."fabro-sandbox-image-load".requires;
        runtimeDirectory = vm.systemd.services."fabro-sandbox-image-load".serviceConfig.RuntimeDirectory;
        execStart = toString vm.systemd.services."fabro-sandbox-image-load".serviceConfig.ExecStart;
      };
      fabro = {
        after = vm.systemd.services.fabro.after;
        wants = vm.systemd.services.fabro.wants;
      };
      keeper = {
        type = vm.systemd.services."fabro-sandbox-image-keep".serviceConfig.Type;
        restart = vm.systemd.services."fabro-sandbox-image-keep".serviceConfig.Restart;
        restartSec = vm.systemd.services."fabro-sandbox-image-keep".serviceConfig.RestartSec;
        wantedBy = vm.systemd.services."fabro-sandbox-image-keep".wantedBy;
        after = vm.systemd.services."fabro-sandbox-image-keep".after;
        requires = vm.systemd.services."fabro-sandbox-image-keep".requires;
        execStart = toString vm.systemd.services."fabro-sandbox-image-keep".serviceConfig.ExecStart;
      };
      reconciler = {
        type = vm.systemd.services."fabro-sandbox-env".serviceConfig.Type;
        remainAfterExit = vm.systemd.services."fabro-sandbox-env".serviceConfig.RemainAfterExit;
        wantedBy = vm.systemd.services."fabro-sandbox-env".wantedBy;
        after = vm.systemd.services."fabro-sandbox-env".after;
        requires = vm.systemd.services."fabro-sandbox-env".requires;
        environmentFile = toString vm.systemd.services."fabro-sandbox-env".serviceConfig.EnvironmentFile;
        execStart = toString vm.systemd.services."fabro-sandbox-env".serviceConfig.ExecStart;
        user = vm.systemd.services."fabro-sandbox-env".serviceConfig.User or null;
      };
      sopsFabroEnv = toString vm.sops.templates."fabro-env".path;
      archivePath = builtins.unsafeDiscardStringContext (toString cfg.archive);
      digestPath = builtins.unsafeDiscardStringContext (toString cfg.digest);
      reconcilerScript = builtins.readFile (toString ${repoRoot} + "/scripts/fabro-sandbox-env-reconcile.nix");
      fabroModule = builtins.readFile (toString ${repoRoot} + "/configurations/fabro-vm/fabro.nix");
    }
  `);
}

// The reconciler is a `writeShellApplication`; extract the rendered shell body
// (between `text = ''` and the closing `'';`) so the behavioural assertions
// ignore the surrounding Nix and the file's header comments.
function reconcilerBody(moduleSource) {
  const marker = "text = ''";
  const start = moduleSource.indexOf(marker);
  assert.notEqual(start, -1, 'reconciler must define a writeShellApplication text block');
  const bodyStart = start + marker.length;
  const end = moduleSource.indexOf("'';", bodyStart);
  assert.notEqual(end, -1, "reconciler text block must be terminated with '';");
  return moduleSource.slice(bodyStart, end);
}

test('the loader unit is a podman-gated oneshot embedding both store paths', () => {
  const { loader, archivePath, digestPath } = guest();
  // Requirements 3.1, 3.2, 3.6: a oneshot that runs before Fabro and fails the
  // switch on error.
  assert.equal(loader.type, 'oneshot');
  assert.equal(loader.remainAfterExit, true);
  assert.ok(loader.wantedBy.includes('multi-user.target'));
  assert.ok(loader.after.includes('podman.socket'));
  assert.ok(loader.requires.includes('podman.socket'));
  assert.equal(loader.runtimeDirectory, 'fabro-sandbox');
  // The archive and digest store paths are embedded in ExecStart so a contents
  // change rewrites the unit (reloading the image) and an unchanged image
  // leaves it untouched.
  assert.ok(
    loader.execStart.includes(archivePath),
    `ExecStart must embed the archive store path: ${loader.execStart}`,
  );
  assert.ok(
    loader.execStart.includes(digestPath),
    `ExecStart must embed the digest store path: ${loader.execStart}`,
  );
});

test('fabro.service is ordered after and wants the loader', () => {
  const { fabro } = guest();
  // Requirement 3.4: the image is loaded before Fabro can use it.
  assert.ok(fabro.after.includes('fabro-sandbox-image-load.service'));
  assert.ok(fabro.wants.includes('fabro-sandbox-image-load.service'));
});

test('the keeper unit re-pins the loaded image against the store prune', () => {
  const { keeper, digestPath } = guest();
  // The hourly `podman system prune -af` reaper (autoPrune) removes every
  // image not referenced by a running container; the keeper's long-running
  // container is that running reference, and the restart policy keeps the pin
  // alive across crashes.
  assert.equal(keeper.type, 'simple');
  assert.equal(keeper.restart, 'always');
  assert.equal(keeper.restartSec, 5);
  assert.ok(keeper.wantedBy.includes('multi-user.target'));
  // The image and the recorded digest come from the loader.
  assert.ok(keeper.after.includes('fabro-sandbox-image-load.service'));
  assert.ok(keeper.requires.includes('fabro-sandbox-image-load.service'));
  // The digest store path is embedded so a contents change rewrites the unit
  // and the switch restarts the keeper on the new digest.
  assert.ok(
    keeper.execStart.includes(digestPath),
    `ExecStart must embed the digest store path: ${keeper.execStart}`,
  );
});

test('the reconciler unit is a oneshot after fabro.service and the loader', () => {
  const { reconciler, sopsFabroEnv } = guest();
  // Requirements 4.3, 4.5, 4.6: ordered after and requiring both the Fabro API
  // (fabro.service) and the loader (the declared digest), running as root and
  // reading FABRO_DEV_TOKEN from the sops-rendered fabro-env file.
  assert.equal(reconciler.type, 'oneshot');
  assert.equal(reconciler.remainAfterExit, true);
  assert.ok(reconciler.wantedBy.includes('multi-user.target'));
  assert.ok(reconciler.after.includes('fabro.service'));
  assert.ok(reconciler.after.includes('fabro-sandbox-image-load.service'));
  assert.ok(reconciler.requires.includes('fabro.service'));
  assert.ok(reconciler.requires.includes('fabro-sandbox-image-load.service'));
  assert.equal(reconciler.environmentFile, sopsFabroEnv);
  assert.equal(reconciler.user, null);
});

test('containers.conf mounts the host store read-only and the daemon socket', () => {
  const { mounts } = guest();
  // Requirements 5.1-5.5: global engine-level mounts, the store read-only.
  assert.ok(
    mounts.includes('type=bind,source=/nix/store,destination=/nix/store,ro'),
    `mounts must carry the read-only host store bind: ${JSON.stringify(mounts)}`,
  );
  assert.ok(
    mounts.includes(
      'type=bind,source=/nix/var/nix/daemon-socket,destination=/nix/var/nix/daemon-socket',
    ),
    `mounts must carry the daemon socket bind: ${JSON.stringify(mounts)}`,
  );
});

test('the fabro settings target the default environment', () => {
  const { fabroModule } = guest();
  // The persisted environment reconciled by the reconciler is `default`.
  assert.match(fabroModule, /run = \{\s*environment\.id = "default";/);
});

test('the reconciler script GETs, compares, and PUTs with If-Match', () => {
  const { reconcilerScript } = guest();
  const body = reconcilerBody(reconcilerScript);
  // Requirement 4.1, 4.2: GET the default environment with the dev token.
  assert.match(body, /curl -sS -o "\$body_file"/);
  assert.match(body, /Authorization: Bearer \$FABRO_DEV_TOKEN/);
  assert.match(body, /\/environments\/default/);
  // Requirement 4.4: compare the persisted image.docker reference and exit 0
  // unchanged when it already matches.
  assert.match(body, /\.image\.docker/);
  assert.match(body, /"\$persisted" = "\$ref"/);
  assert.match(body, /exit 0/);
  // Requirement 4.5: PUT the replaced reference guarded by the quoted
  // If-Match revision.
  assert.match(body, /-X PUT/);
  assert.match(body, /If-Match: \\"\$revision\\"/);
  assert.match(body, /del\(\.id, \.revision\) \| \.image\.docker = \$ref/);
});
