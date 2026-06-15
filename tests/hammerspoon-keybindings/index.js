'use strict';

// Entry point for `node --test tests/hammerspoon-keybindings/` (mirrors
// tests/git-mcp/index.js). Node resolves the directory to this module and
// requires the test files, which register their suites with `node:test`.
require('./render.test.js');
require('./validation.test.js');
