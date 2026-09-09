'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

function parameters() {
  if (process.env.RECORDING_EXEC_MODE === 'environment') {
    return {
      recordPath: process.env.RECORDING_EXEC_RECORD_PATH,
      identityCommand: process.env.RECORDING_EXEC_IDENTITY_COMMAND,
      sessionToken: process.env.RECORDING_EXEC_SESSION_TOKEN,
      wrapperRole: process.env.RECORDING_EXEC_WRAPPER_ROLE,
      childRole: process.env.RECORDING_EXEC_CHILD_ROLE,
      expectedChildExecutable: process.env.RECORDING_EXEC_EXPECTED_CHILD_EXECUTABLE,
      command: process.env.RECORDING_EXEC_COMMAND,
      args: process.argv.slice(2),
      truncate: false,
    };
  }

  const [
    recordPath,
    identityCommand,
    sessionToken,
    wrapperRole,
    childRole,
    expectedChildExecutable,
    command,
    ...args
  ] = process.argv.slice(2);
  return {
    recordPath,
    identityCommand,
    sessionToken,
    wrapperRole,
    childRole,
    expectedChildExecutable,
    command,
    args,
    truncate: true,
  };
}

function inspect(identityCommand, pid) {
  const result = childProcess.spawnSync(identityCommand, [String(pid)], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`cannot inspect process ${pid}: ${result.stderr || `status ${result.status}`}`);
  }
  const [observedPid, processGroup, startSeconds, startMicroseconds, executable] = result.stdout
    .trim()
    .split('\t');
  return {
    pid: Number(observedPid),
    processGroup: Number(processGroup),
    startSeconds: Number(startSeconds),
    startMicroseconds: Number(startMicroseconds),
    executable,
  };
}

function ownershipRecord(identityCommand, pid, expectedExecutable, role, sessionToken) {
  const identity = inspect(identityCommand, pid);
  if (identity.executable !== expectedExecutable) {
    throw new Error(
      `${role} executable mismatch: expected ${expectedExecutable}, observed ${identity.executable}`,
    );
  }
  return { ...identity, expectedExecutable, role, sessionToken };
}

function appendRecord(recordPath, record, truncate = false) {
  fs.writeFileSync(
    recordPath,
    `${JSON.stringify(record)}\n`,
    { encoding: 'utf8', flag: truncate ? 'w' : 'a', mode: 0o600 },
  );
}

async function waitForChildIdentity(config, child) {
  let lastError;
  for (let attempt = 0; attempt < 300; attempt += 1) {
    try {
      return ownershipRecord(
        config.identityCommand,
        child.pid,
        config.expectedChildExecutable,
        config.childRole,
        config.sessionToken,
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw lastError;
}

void (async () => {
  const config = parameters();
  for (const [name, value] of Object.entries(config)) {
    if (name !== 'args' && name !== 'truncate' && !value) {
      throw new Error(`recording-exec missing ${name}`);
    }
  }

  appendRecord(
    config.recordPath,
    ownershipRecord(
      config.identityCommand,
      process.pid,
      process.execPath,
      config.wrapperRole,
      config.sessionToken,
    ),
    config.truncate,
  );
  const child = childProcess.spawn(config.command, config.args, { stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  appendRecord(config.recordPath, await waitForChildIdentity(config, child));
  const { code, signal } = await childExit;
  if (signal) {
    const signalNumber = os.constants.signals[signal];
    process.exit(Number.isInteger(signalNumber) ? 128 + signalNumber : 1);
  } else process.exit(code ?? 1);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
