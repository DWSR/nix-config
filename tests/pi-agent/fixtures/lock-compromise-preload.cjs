'use strict';

const fs = require('node:fs');
const path = require('node:path');
const lockfile = require('proper-lockfile');

const readFile = fs.promises.readFile.bind(fs.promises);
let compromised = false;

fs.promises.readFile = async (file, ...args) => {
  if (
    !compromised &&
    process.env.PI_AGENT_LOCK_COMPROMISE_PROBE === 'integration-during-state-read' &&
    path.basename(String(file)) === 'settings.json'
  ) {
    compromised = true;
    lockfile.compromise(0);
  }
  return readFile(file, ...args);
};
