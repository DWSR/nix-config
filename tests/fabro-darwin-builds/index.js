'use strict';

// Suite entry point for `node --test tests/fabro-darwin-builds/`.
//
// Node resolves a directory argument through this package's `main`, so this
// file requires every `*.test.js` beside it. That keeps the documented
// directory invocation (design "Repository Checks": copy the source and run
// `node --test tests/fabro-darwin-builds/`) covering the whole suite, including
// suites added later, instead of only the first file named in package.json.

const fs = require('node:fs');
const path = require('node:path');

for (const file of fs.readdirSync(__dirname).sort()) {
  if (file.endsWith('.test.js')) require(path.join(__dirname, file));
}
