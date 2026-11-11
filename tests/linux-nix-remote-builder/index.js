'use strict';

// Entry point for `node --test tests/linux-nix-remote-builder/`. Node resolves
// a directory argument to this module, so require every focused suite here to
// register it with node:test. The flake check registered by task 6.4 supplies
// a pre-evaluated JSON snapshot and runs only the hermetic combined suite; the
// remaining suites need the host's Nix store/builders or a network-enabled
// nested evaluator and are run directly during implementation validation.
if (process.env.LINUX_NIX_REMOTE_BUILDER_DATA_FILE) {
  require('./combined-check.test.js');
} else {
  require('./builder-host.test.js');
  require('./fabro-dispatch.test.js');
  require('./lima-render.test.js');
  require('./personal-dispatch.test.js');
  require('./negative-fixtures.test.js');
  require('./combined-check.test.js');
  require('./readme-contract.test.js');
  require('./secret-sync.test.js');
  require('./flake-check.test.js');
  require('./live-validate.test.js');
}
