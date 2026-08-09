'use strict';

const lockfile = require('proper-lockfile');

const [targetPath, lockfilePath, holdText] = process.argv.slice(2);
const holdMs = Number(holdText);

if (!targetPath || !Number.isFinite(holdMs) || holdMs <= 0) {
  throw new Error('usage: hold-proper-lock TARGET [LOCKFILE] HOLD_MS');
}

const options = { realpath: false };
if (lockfilePath) {
  options.lockfilePath = lockfilePath;
}

lockfile
  .lock(targetPath, options)
  .then((release) => {
    process.stdout.write('locked\n');
    return new Promise((resolve) => setTimeout(resolve, holdMs)).then(release);
  })
  .catch((error) => {
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
