'use strict';

// Entry point for `node --test tests/linux-nix-remote-builder/`. Node resolves
// a directory argument to this module, so require the host/Lima render suites
// here to register them with node:test. Further suites in this directory are
// added by their own tasks and can be required here when the combined flake
// check (task 6.4) is registered.
require('./builder-host.test.js');
require('./fabro-dispatch.test.js');
require('./lima-render.test.js');
