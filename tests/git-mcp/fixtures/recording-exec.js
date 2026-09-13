'use strict';

const childProcess = require('node:child_process');
const os = require('node:os');

function parameters() {
  if (process.env.RECORDING_EXEC_MODE === 'environment') {
    return {
      recordPath: process.env.RECORDING_EXEC_RECORD_PATH,
      processControlCommand: process.env.RECORDING_EXEC_PROCESS_CONTROL,
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
    processControlCommand,
    sessionToken,
    wrapperRole,
    childRole,
    expectedChildExecutable,
    command,
    ...args
  ] = process.argv.slice(2);
  return {
    recordPath,
    processControlCommand,
    sessionToken,
    wrapperRole,
    childRole,
    expectedChildExecutable,
    command,
    args,
    truncate: true,
  };
}

function recordOwnership(config, pid, expectedExecutable, role, truncate = false) {
  const result = childProcess.spawnSync(config.processControlCommand, [
    'record',
    '--file', config.recordPath,
    '--token', config.sessionToken,
    '--pid', String(pid),
    '--expected-executable', expectedExecutable,
    '--role', role,
    ...(truncate ? ['--truncate'] : []),
    ...(pid === process.pid ? [] : ['--wait-ms', '3_000']),
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `process-control could not record ${role} ${pid}: ${result.stderr || `status ${result.status}`}`,
    );
  }
}

void (async () => {
  const config = parameters();
  for (const [name, value] of Object.entries(config)) {
    if (name !== 'args' && name !== 'truncate' && !value) {
      throw new Error(`recording-exec missing ${name}`);
    }
  }

  recordOwnership(config, process.pid, process.execPath, config.wrapperRole, config.truncate);
  const child = childProcess.spawn(config.command, config.args, { stdio: 'inherit' });
  child.once('error', (error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });
  const childExit = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  recordOwnership(config, child.pid, config.expectedChildExecutable, config.childRole);
  const { code, signal } = await childExit;
  if (signal) {
    const signalNumber = os.constants.signals[signal];
    process.exit(Number.isInteger(signalNumber) ? 128 + signalNumber : 1);
  } else process.exit(code ?? 1);
})().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
