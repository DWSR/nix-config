'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const repoRoot = path.resolve(__dirname, '../..');
const HOSTS = ['Brandons-MacBook-Pro', 'ShopifyLaptop'];

function renderHostWrapper(host) {
  const expression = `(let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    hm = flake.darwinConfigurations.${JSON.stringify(host)}.config.home-manager.users.brandonmcnama;
  in builtins.toJSON {
    wrapperDrv = hm.programs.agentmemory.rollbackPackage.drvPath;
  })`;

  return JSON.parse(
    execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 600_000,
    }),
  );
}

function realize(drvPath) {
  return execFileSync('nix-store', ['--realise', drvPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000,
  }).trim().split('\n').at(-1);
}

function createGenerationFixture(generationVersion = '1') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cavemem-rollback-'));
  const stateHome = path.join(directory, 'state');
  const generation = path.join(directory, 'home-manager-generation');
  const rollbackGeneration = path.join(generation, 'specialisation', 'opencode-cavemem-rollback');
  const argsLog = path.join(directory, 'activation-args.log');

  fs.mkdirSync(path.join(stateHome, 'home-manager', 'gcroots'), { recursive: true });
  fs.mkdirSync(rollbackGeneration, { recursive: true });
  fs.writeFileSync(path.join(rollbackGeneration, 'gen-version'), `${generationVersion}\n`);
  fs.writeFileSync(
    path.join(rollbackGeneration, 'activate'),
    '#!/bin/sh\nprintf "%s\\n" "$*" > "$ROLLBACK_ACTIVATION_ARGS_LOG"\n',
    { mode: 0o755 },
  );
  fs.symlinkSync(generation, path.join(stateHome, 'home-manager', 'gcroots', 'current-home'));

  return {
    argsLog,
    directory,
    rollbackGeneration: fs.realpathSync(rollbackGeneration),
    stateHome,
    cleanup() {
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('both hosts generate an executable rollback wrapper for their driver-v1 specialisation', () => {
  for (const host of HOSTS) {
    const rendered = renderHostWrapper(host);
    const command = path.join(realize(rendered.wrapperDrv), 'bin/opencode-cavemem-rollback');
    const fixture = createGenerationFixture();

    try {
      const env = {
        ...process.env,
        ROLLBACK_ACTIVATION_ARGS_LOG: fixture.argsLog,
        XDG_STATE_HOME: fixture.stateHome,
      };
      const result = spawnSync(command, ['--check'], { encoding: 'utf8', env });

      assert.equal(result.status, 0, `${host}: ${result.stderr}`);
      assert.match(result.stdout, /^opencode_cavemem_rollback=available$/m);
      assert.match(result.stdout, new RegExp(`^rollback_generation=${fixture.rollbackGeneration}$`, 'm'));
      assert.match(result.stdout, /^driver_version=1$/m);

      const activation = spawnSync(command, [], { encoding: 'utf8', env });
      assert.equal(activation.status, 0, `${host}: ${activation.stderr}`);
      assert.equal(fs.readFileSync(fixture.argsLog, 'utf8'), '--driver-version 1\n');
      assert.doesNotMatch(fs.readFileSync(command, 'utf8'), /\/Users\//);
    } finally {
      fixture.cleanup();
    }
  }
});

test('rollback wrapper fails actionably when its generated activation is absent', () => {
  const rendered = renderHostWrapper(HOSTS[0]);
  const command = path.join(realize(rendered.wrapperDrv), 'bin/opencode-cavemem-rollback');
  const stateHome = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-cavemem-rollback-missing-'));
  const result = spawnSync(command, ['--check'], {
    encoding: 'utf8',
    env: { ...process.env, XDG_STATE_HOME: stateHome },
  });

  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rollback activation is unavailable/i);
    assert.match(result.stderr, /rebuild the host/i);
  } finally {
    fs.rmSync(stateHome, { recursive: true, force: true });
  }
});

test('rollback wrapper rejects a generation without driver-v1 support', () => {
  const rendered = renderHostWrapper(HOSTS[0]);
  const command = path.join(realize(rendered.wrapperDrv), 'bin/opencode-cavemem-rollback');
  const fixture = createGenerationFixture('0');

  try {
    const result = spawnSync(command, ['--check'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: fixture.stateHome },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not support Home Manager driver version 1/i);
  } finally {
    fixture.cleanup();
  }
});
