'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const sandboxPath = path.join(repoRoot, 'configurations/fabro-vm/sandbox.nix');

// Host-store sharing is declared as a global Podman containers.conf setting in
// sandbox.nix (the module that also owns the loader/reconciler units). NixOS
// renders `virtualisation.containers.containersConf.settings` into
// /etc/containers/containers.conf, so the mounts apply to every container
// Podman creates without per-environment configuration. These assertions read
// the module source so they need neither a Linux builder nor a full NixOS
// evaluation; the rendered-config assertion lives in the eval/wiring checks.
const MOUNTS_PATH = 'virtualisation.containers.containersConf.settings.containers.mounts';
const STORE_MOUNT = 'type=bind,source=/nix/store,destination=/nix/store,ro';
const DAEMON_MOUNT = 'type=bind,source=/nix/var/nix/daemon-socket,destination=/nix/var/nix/daemon-socket';

function sandboxSource() {
  return fs.readFileSync(sandboxPath, 'utf8');
}

// The mounts list as written in the module: everything between the `= [`
// opener and the first `];`, from which the quoted entries are extracted.
function mountsBlock() {
  const src = sandboxSource();
  const marker = `${MOUNTS_PATH} = [`;
  const start = src.indexOf(marker);
  assert.notEqual(start, -1, `sandbox.nix must set ${MOUNTS_PATH}`);
  const bodyStart = start + marker.length;
  const end = src.indexOf('];', bodyStart);
  assert.notEqual(end, -1, 'the containers mounts list must be terminated with ];');
  return src.slice(bodyStart, end);
}

function mountEntries() {
  return [...mountsBlock().matchAll(/"([^"]*)"/g)].map((match) => match[1]);
}

test('sandbox.nix sets the global containers mounts list', () => {
  // The setting is a global `[containers]` mount list, not a per-environment
  // one: Fabro's environment schema has no mount field, so sharing must happen
  // at the container-engine layer for every container.
  assert.match(sandboxSource(), /virtualisation\.containers\.containersConf\.settings\.containers\.mounts = \[/);
});

test('containers mounts carry exactly the host store and daemon socket binds', () => {
  assert.deepEqual(
    mountEntries().slice().sort(),
    [STORE_MOUNT, DAEMON_MOUNT].sort(),
  );
});

test('the host store bind is read-only', () => {
  const store = mountEntries().find((entry) => entry.includes('source=/nix/store,'));
  assert.notEqual(store, undefined, 'a bind mount sourcing /nix/store must be declared');
  assert.equal(store, STORE_MOUNT);
  // Read-only is what keeps sandbox containers from writing to the guest store.
  assert.match(store, /,ro$/);
});

test('the daemon socket bind is writable', () => {
  const daemon = mountEntries().find((entry) => entry.includes('source=/nix/var/nix/daemon-socket,'));
  assert.notEqual(daemon, undefined, 'a bind mount sourcing the nix daemon socket dir must be declared');
  assert.equal(daemon, DAEMON_MOUNT);
  // The socket directory must stay writable, or the mounted socket is unusable.
  assert.doesNotMatch(daemon, /(^|,)(ro|readonly)(,|$)/);
});
