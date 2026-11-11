'use strict';

/*
 * End-to-end publication, state, and credential-safety tests for the Fly app
 * deployment runtime (spec nix-module-for-fly-io-app, Task 5.2; Requirements
 * 3.1, 3.3, 3.4, 3.5, 3.8, 4.3, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3).
 *
 * The real `scripts/fly-app-deploy.nix` wrapper and the real
 * `scripts/fly-app-publish.nix` publisher run against an in-process fake Fly
 * registry, a stub `nix2container` image publisher, and a stub reconciler.
 * That keeps publication, state, and credential handling real while stubbing
 * the two external interfaces the task names (the Fly registry and the image
 * publisher). No Fly account, token, or network access is used.
 */

const { after, before, test } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const fixture = path.join(repoRoot, 'tests/fly-app/fixture');
const deployScript = path.join(repoRoot, 'scripts/fly-app-deploy.nix');
const publishScript = path.join(repoRoot, 'scripts/fly-app-publish.nix');

const TOKEN = 'fly-app-test-token-not-a-real-credential-4c81a2';
const AUTH = 'Basic ' + Buffer.from('x:' + TOKEN).toString('base64');
const TOKEN_BASE64 = Buffer.from(TOKEN).toString('base64');
const DOCKER_AUTH = Buffer.from('x:' + TOKEN).toString('base64');
const NIX_BUILD_TIMEOUT_MS = 600_000;
const DEPLOY_TIMEOUT_MS = 120_000;

/*
 * Stub image publisher. It records the invocation, checks the private Docker
 * credentials it receives, can pause or fail on demand, and writes the
 * manifest body the fake registry serves. `FLY_API_TOKEN` must not be present
 * in this process environment: the real publisher strips it before invoking
 * `nix2container`.
 */
const STUB_PUBLISHER = `
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function sleep(milliseconds) {
  if (milliseconds > 0) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  }
}

function fail(message, status) {
  process.stderr.write('stub nix2container: ' + message + '\\n');
  process.exit(status);
}

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== 'push' || args[1] !== '--ref') {
  fail('unexpected arguments', 64);
}
const reference = args[2];
const archive = args[3];
if (!fs.existsSync(archive) || !fs.statSync(archive).isFile()) {
  fail('image archive is not realized', 65);
}

let configPath = null;
let configMode = null;
let directoryMode = null;
let auth = null;
let literalToken = false;
const dockerConfig = process.env.DOCKER_CONFIG || '';
if (dockerConfig) {
  configPath = path.join(dockerConfig, 'config.json');
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    const config = JSON.parse(raw);
    const registry = Object.keys(config.auths)[0];
    auth = config.auths[registry].auth;
    configMode = fs.statSync(configPath).mode & 0o777;
    directoryMode = fs.statSync(dockerConfig).mode & 0o777;
    const sentinel = process.env.FLY_TEST_TOKEN_SENTINEL || '';
    literalToken = sentinel.length > 0 && raw.includes(sentinel);
  }
}

const entry = {
  argv: args,
  reference: reference,
  archive: archive,
  docker_config_set: Boolean(dockerConfig),
  docker_config_path: configPath,
  docker_config_mode: configMode,
  docker_config_directory_mode: directoryMode,
  docker_auth_sha256: auth
    ? crypto.createHash('sha256').update(auth).digest('hex')
    : null,
  token_in_environment: Object.prototype.hasOwnProperty.call(
    process.env,
    'FLY_API_TOKEN'
  ),
  literal_token_in_config: literalToken,
};
fs.appendFileSync(
  process.env.FLY_TEST_PUSH_LOG,
  JSON.stringify(entry) + '\\n'
);

sleep(Number(process.env.FLY_TEST_PUSH_DELAY || '0'));

const remainder = reference.slice(reference.indexOf('/') + 1);
const separator = remainder.lastIndexOf(':');
const app = remainder.slice(0, separator);
const tag = remainder.slice(separator + 1);
const gate = process.env.FLY_TEST_PUSH_GATE_DIR;
if (gate) {
  fs.writeFileSync(path.join(gate, app + '.entered'), '');
  const deadline =
    Date.now() + Number(process.env.FLY_TEST_PUSH_GATE_TIMEOUT || '60000');
  while (!fs.existsSync(path.join(gate, app + '.release'))) {
    if (Date.now() > deadline) {
      fail('push gate timed out', 70);
    }
    sleep(20);
  }
}

if (process.env.FLY_TEST_PUSH_FAIL) {
  const decoded = auth
    ? Buffer.from(auth, 'base64').toString('utf8').replace(/^x:/, '')
    : '';
  process.stdout.write(
    'stub nix2container: simulated push failure token=' + decoded + '\\n'
  );
  process.stderr.write(
    'stub nix2container: simulated push failure auth=' + (auth || '') + '\\n'
  );
  process.exit(9);
}

const body = JSON.stringify({
  schemaVersion: 2,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  reference: reference,
});
fs.writeFileSync(
  path.join(process.env.FLY_TEST_REGISTRY_DIR, app + '@@' + tag + '.json'),
  body
);
`;

/*
 * Stub reconciler. It records the selected specification and resolved image
 * payload and deliberately prints the runtime token and its Docker-compatible
 * base64 form so the deploy wrapper's redaction can be asserted. The real
 * reconciler is covered by reconcile.test.py; this task isolates publication
 * and credential behavior.
 */
const STUB_RECONCILER = `
const fs = require('node:fs');

const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--spec' || args[2] !== '--images') {
  process.stderr.write('stub reconciler: unexpected arguments\\n');
  process.exit(64);
}
const specPath = args[1];
const imagesPath = args[3];
const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
const images = JSON.parse(fs.readFileSync(imagesPath, 'utf8'));
const token = process.env.FLY_API_TOKEN || '';
const entry = {
  argv: args,
  spec_path: specPath,
  spec: spec,
  images_path: imagesPath,
  images: images,
  token_present: Boolean(token),
  token_in_argv: args.some(function (argument) {
    return token.length > 0 && argument.includes(token);
  }),
};
fs.appendFileSync(
  process.env.FLY_TEST_RECONCILE_LOG,
  JSON.stringify(entry) + '\\n'
);
const auth = Buffer.from('x:' + token).toString('base64');
process.stdout.write(
  'stub reconciler accepted deployment token=' + token + ' auth=' + auth + '\\n'
);
process.stderr.write(
  'stub reconciler diagnostics token=' + token + ' auth=' + auth + '\\n'
);
const status = Number(process.env.FLY_TEST_RECONCILE_STATUS || '0');
if (status !== 0) {
  process.stderr.write('stub reconciler rejected deployment\\n');
  process.exit(status);
}
`;

function nixLiteral(value) {
  return JSON.stringify(value);
}

function runNixBuild(expression) {
  let result;
  try {
    result = childProcess.execFileSync(
      'nix',
      [
        'build',
        '--impure',
        '--no-link',
        '--print-out-paths',
        '--expr',
        expression,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: NIX_BUILD_TIMEOUT_MS,
        env: process.env,
      },
    );
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr) : '';
    throw new Error(
      'nix build failed:\n' + stderr + '\n' + String(error.message)
    );
  }
  const lines = result
    .trim()
    .split('\n')
    .filter((line) => line.length > 0);
  assert.ok(lines.length > 0, 'nix build printed no output path');
  return lines[lines.length - 1];
}

function buildDeployPackage(registryHost) {
  const expression = `
    let
      flake = builtins.getFlake ${nixLiteral('path:' + fixture)};
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      nix2containerProgram = pkgs.writeText "stub-nix2container.js" ${nixLiteral(STUB_PUBLISHER)};
      nix2container = pkgs.writeShellScriptBin "nix2container" ''
        exec \${pkgs.nodejs}/bin/node \${nix2containerProgram} "$@"
      '';
      snapshotter = pkgs.runCommand "stub-nix-snapshotter" { } ''
        mkdir -p "$out/bin"
        ln -s "\${nix2container}/bin/nix2container" "$out/bin/nix2container"
      '';
      publisher = import ${publishScript} {
        inherit pkgs;
        nixSnapshotter = snapshotter;
        registryScheme = "http";
        registryHost = ${nixLiteral(registryHost)};
      };
      reconcilerProgram = pkgs.writeText "stub-reconciler.js" ${nixLiteral(STUB_RECONCILER)};
      reconciler = pkgs.writeShellScriptBin "fly-app-reconcile" ''
        exec \${pkgs.nodejs}/bin/node \${reconcilerProgram} "$@"
      '';
    in
    import ${deployScript} { inherit pkgs publisher reconciler; }
  `;
  return path.join(runNixBuild(expression), 'bin/fly-app-deploy');
}

function buildArchive(name, marker) {
  const script = 'printf ' + marker + ' > $out';
  const expression = `
    derivation {
      name = ${nixLiteral(name)};
      system = builtins.currentSystem;
      builder = "/bin/sh";
      args = [ "-c" ${nixLiteral(script)} ];
    }
  `;
  return runNixBuild(expression);
}

class FakeRegistry {
  constructor() {
    this.manifestsDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'fly-app-registry-')
    );
    this.requests = [];
    this.mode = 'normal';
    this.server = http.createServer((request, response) => {
      this.handle(request, response);
    });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
    this.host = '127.0.0.1:' + this.server.address().port;
  }

  async stop() {
    if (this.server.listening) {
      await new Promise((resolve, reject) => {
        this.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
    fs.rmSync(this.manifestsDir, { recursive: true, force: true });
  }

  reset() {
    this.requests = [];
    this.mode = 'normal';
    for (const name of fs.readdirSync(this.manifestsDir)) {
      fs.rmSync(path.join(this.manifestsDir, name), { force: true });
    }
  }

  manifestFile(app, reference) {
    return path.join(this.manifestsDir, app + '@@' + reference + '.json');
  }

  readManifest(app, reference) {
    const file = this.manifestFile(app, reference);
    return fs.existsSync(file) ? fs.readFileSync(file) : null;
  }

  respond(response, status, body, headers) {
    const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': String(payload.length),
      ...(headers || {}),
    });
    response.end(payload);
  }

  handle(request, response) {
    const url = new URL(
      request.url,
      'http://' + (request.headers.host || 'localhost')
    );
    const parts = url.pathname.split('/');
    if (parts.length !== 5 || parts[1] !== 'v2' || parts[3] !== 'manifests') {
      this.respond(response, 404, '{"errors":[{"code":"NOT_FOUND"}]}');
      return;
    }
    const app = decodeURIComponent(parts[2]);
    const reference = decodeURIComponent(parts[4]);
    const authenticated = request.headers.authorization === AUTH;
    this.requests.push({ app, reference, authenticated });
    if (!authenticated || this.mode === 'auth') {
      this.respond(response, 401, '{"errors":[{"code":"UNAUTHORIZED"}]}', {
        'WWW-Authenticate': 'Basic realm="registry"',
      });
      return;
    }
    if (this.mode === 'server-error') {
      this.respond(response, 500, '{"errors":[{"code":"UNKNOWN"}]}');
      return;
    }
    const manifest = this.readManifest(app, reference);
    if (manifest === null) {
      this.respond(response, 404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}');
      return;
    }
    const digest =
      'sha256:' + crypto.createHash('sha256').update(manifest).digest('hex');
    this.respond(response, 200, manifest, {
      'Content-Type': 'application/vnd.oci.image.manifest.v1+json',
      'Docker-Content-Digest': digest,
    });
  }
}

function makeWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fly-app-deploy-test-'));
  workspaces.push(root);
  return {
    root,
    specPath: path.join(root, 'spec.json'),
    pushLog: path.join(root, 'push.log'),
    reconcileLog: path.join(root, 'reconcile.log'),
    stateDir: path.join(root, 'state'),
  };
}

function writeSpec(workspace, spec) {
  fs.writeFileSync(
    workspace.specPath,
    JSON.stringify(spec, null, 2) + '\n',
    'utf8'
  );
}

function deployEnvironment(workspace, options = {}) {
  const token = Object.prototype.hasOwnProperty.call(options, 'token')
    ? options.token
    : TOKEN;
  const env = {
    ...process.env,
    TMPDIR: workspace.root,
    FLY_APP_STATE_DIR: workspace.stateDir,
    FLY_TEST_PUSH_LOG: workspace.pushLog,
    FLY_TEST_RECONCILE_LOG: workspace.reconcileLog,
    FLY_TEST_REGISTRY_DIR: registry.manifestsDir,
    FLY_TEST_TOKEN_SENTINEL: TOKEN,
  };
  delete env.DOCKER_CONFIG;
  delete env.FLY_API_TOKEN;
  if (token !== null) {
    env.FLY_API_TOKEN = token;
  }
  Object.assign(env, options.extraEnv || {});
  return env;
}

async function runDeploy(workspace, options = {}) {
  const { done } = startDeploy(workspace, options);
  return await done;
}

function startDeploy(workspace, options = {}) {
  if (options.spec !== undefined) {
    writeSpec(workspace, options.spec);
  }
  const child = childProcess.spawn(
    deployPackage,
    ['--spec', workspace.specPath],
    {
      cwd: workspace.root,
      env: deployEnvironment(workspace, options),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, options.timeout || DEPLOY_TIMEOUT_MS);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr });
    });
  });
  return { child, done };
}

async function waitFor(predicate, description, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for ' + description);
}

function readJsonLines(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function assertNoToken(text, label) {
  for (const secret of [TOKEN, TOKEN_BASE64, DOCKER_AUTH]) {
    assert.ok(
      !text.includes(secret),
      label + ' must not contain the fixture token or its base64 forms'
    );
  }
}

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) {
    return files;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

function assertWorkspaceSecretFree(root, label) {
  for (const file of walkFiles(root)) {
    assertNoToken(fs.readFileSync(file, 'utf8'), label + ': ' + file);
  }
}

function identityOf(archive) {
  return path.basename(archive).slice(0, 32);
}

function tagOf(archive) {
  return 'nix-' + identityOf(archive);
}

function referenceOf(app, archive) {
  return registry.host + '/' + app + ':' + tagOf(archive);
}

function stateFile(workspace, app = 'fly-alpha') {
  return path.join(workspace.stateDir, app + '.json');
}

function readState(workspace, app = 'fly-alpha') {
  return JSON.parse(fs.readFileSync(stateFile(workspace, app), 'utf8'));
}

function derivationSpec(archive, app = 'fly-alpha') {
  return {
    name: app,
    settings: { primary_region: 'ord' },
    machines: {
      web: { image: { derivation: archive } },
    },
  };
}

const registry = new FakeRegistry();
const workspaces = [];
let deployPackage;
let archiveOne;
let archiveTwo;

before(async () => {
  await registry.start();
  deployPackage = buildDeployPackage(registry.host);
  archiveOne = buildArchive('fly-app-test-archive-one', 'archive-one');
  archiveTwo = buildArchive('fly-app-test-archive-two', 'archive-two');
});

after(async () => {
  await registry.stop();
  for (const root of workspaces) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('first deployment publishes, records non-secret state, and reconciles the resolved image', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const result = await runDeploy(workspace, { spec });
  assert.equal(result.status, 0, result.stderr);
  assertNoToken(result.stdout + result.stderr, 'deploy output');

  const pushes = readJsonLines(workspace.pushLog);
  assert.equal(pushes.length, 1);
  const push = pushes[0];
  assert.equal(push.reference, referenceOf('fly-alpha', archiveOne));
  assert.equal(push.archive, archiveOne);
  assert.equal(push.docker_config_set, true);
  assert.equal(fs.existsSync(push.docker_config_path), false);
  assert.equal(push.docker_config_mode, 0o600);
  assert.equal(push.docker_config_directory_mode, 0o700);
  assert.equal(
    push.docker_auth_sha256,
    crypto.createHash('sha256').update(DOCKER_AUTH).digest('hex')
  );
  assert.equal(push.token_in_environment, false);
  assert.equal(push.literal_token_in_config, false);
  assert.ok(!push.argv.some((argument) => argument.includes(TOKEN)));

  const statePath = stateFile(workspace);
  assert.ok(fs.existsSync(statePath));
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(workspace.stateDir).mode & 0o777, 0o700);
  const state = readState(workspace);
  assert.equal(state.app, 'fly-alpha');
  const record = state.images[identityOf(archiveOne)];
  assert.equal(record.identity, identityOf(archiveOne));
  assert.equal(record.reference, referenceOf('fly-alpha', archiveOne));
  assert.match(record.digest, /^sha256:[0-9a-f]{64}$/);

  const manifest = registry.readManifest('fly-alpha', tagOf(archiveOne));
  assert.ok(manifest !== null);
  const expectedDigest =
    'sha256:' + crypto.createHash('sha256').update(manifest).digest('hex');
  assert.equal(record.digest, expectedDigest);

  const lockPath = path.join(workspace.stateDir, 'fly-alpha.lock');
  assert.ok(fs.existsSync(lockPath));
  assert.equal(fs.statSync(lockPath).mode & 0o777, 0o600);
  assertNoToken(fs.readFileSync(lockPath, 'utf8'), 'publication lock');

  const reconciles = readJsonLines(workspace.reconcileLog);
  assert.equal(reconciles.length, 1);
  const reconcile = reconciles[0];
  assert.deepEqual(reconcile.argv, [
    '--spec',
    workspace.specPath,
    '--images',
    reconcile.images_path,
  ]);
  assert.equal(reconcile.spec.name, 'fly-alpha');
  assert.equal(reconcile.images.app, 'fly-alpha');
  assert.equal(reconcile.images.images.length, 1);
  assert.equal(reconcile.images.images[0].kind, 'derivation');
  assert.equal(
    reconcile.images.images[0].reference,
    referenceOf('fly-alpha', archiveOne)
  );
  assert.equal(reconcile.images.images[0].digest, expectedDigest);
  assert.equal(reconcile.images.images[0].published, true);
  assert.equal(
    reconcile.images.machines.web.image.reference,
    referenceOf('fly-alpha', archiveOne)
  );
  assert.equal(reconcile.images.machines.web.image.digest, expectedDigest);
  assert.equal(reconcile.token_present, true);
  assert.equal(reconcile.token_in_argv, false);
  assert.equal(fs.existsSync(reconcile.images_path), false);

  assertWorkspaceSecretFree(workspace.root, 'deployment workspace');
  assert.deepEqual(
    fs.readdirSync(workspace.root).filter((name) => name.startsWith('fly-app-')),
    []
  );
});

test('an unchanged recorded image is not republished', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const first = await runDeploy(workspace, { spec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];

  const second = await runDeploy(workspace, { spec });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /unchanged and still available; not republishing/);
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  const reconciles = readJsonLines(workspace.reconcileLog);
  assert.equal(reconciles.length, 2);
  const secondPayload = reconciles[1].images.images[0];
  assert.equal(secondPayload.published, false);
  assert.equal(secondPayload.reference, firstPayload.reference);
  assert.equal(secondPayload.digest, firstPayload.digest);
  assertNoToken(second.stdout + second.stderr, 'second deploy output');
});

test('an app settings change reuses the unchanged image without republishing', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const firstSpec = derivationSpec(archiveOne);
  firstSpec.settings.primary_region = 'ord';
  const first = await runDeploy(workspace, { spec: firstSpec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];

  const changedSpec = derivationSpec(archiveOne);
  changedSpec.settings.primary_region = 'sjc';
  const second = await runDeploy(workspace, { spec: changedSpec });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  const reconciles = readJsonLines(workspace.reconcileLog);
  assert.equal(reconciles.length, 2);
  assert.equal(reconciles[1].spec.settings.primary_region, 'sjc');
  assert.equal(reconciles[1].images.images[0].published, false);
  assert.equal(reconciles[1].images.images[0].digest, firstPayload.digest);
});

test('a changed derivation identity publishes a new image before reconciliation', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const first = await runDeploy(workspace, { spec: derivationSpec(archiveOne) });
  assert.equal(first.status, 0, first.stderr);
  const second = await runDeploy(workspace, { spec: derivationSpec(archiveTwo) });
  assert.equal(second.status, 0, second.stderr);

  const pushes = readJsonLines(workspace.pushLog);
  assert.equal(pushes.length, 2);
  assert.deepEqual(
    pushes.map((push) => push.reference).sort(),
    [
      referenceOf('fly-alpha', archiveOne),
      referenceOf('fly-alpha', archiveTwo),
    ].sort()
  );
  const reconciles = readJsonLines(workspace.reconcileLog);
  assert.equal(reconciles.length, 2);
  assert.equal(reconciles[0].images.images[0].published, true);
  assert.equal(reconciles[1].images.images[0].published, true);
  assert.notEqual(
    reconciles[0].images.images[0].reference,
    reconciles[1].images.images[0].reference
  );
  const state = readState(workspace);
  assert.deepEqual(
    Object.keys(state.images).sort(),
    [identityOf(archiveOne), identityOf(archiveTwo)].sort()
  );
});

test('intact state with a missing remote image fails without republishing', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const first = await runDeploy(workspace, { spec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];
  fs.unlinkSync(registry.manifestFile('fly-alpha', tagOf(archiveOne)));

  const second = await runDeploy(workspace, { spec });
  assert.notEqual(second.status, 0);
  assert.equal(second.stdout, '');
  assert.match(second.stderr, /missing from the Fly registry/);
  assert.match(second.stderr, /refusing to republish/);
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 1);
  assert.equal(
    readState(workspace).images[identityOf(archiveOne)].digest,
    firstPayload.digest
  );
  assertNoToken(second.stderr, 'failed deploy output');
});

test('intact state with a wrong remote digest fails without republishing', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const first = await runDeploy(workspace, { spec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];
  fs.writeFileSync(
    registry.manifestFile('fly-alpha', tagOf(archiveOne)),
    JSON.stringify({ schemaVersion: 2, tampered: true })
  );

  const second = await runDeploy(workspace, { spec });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /does not match the recorded publication/);
  assert.match(second.stderr, /refusing to republish/);
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  assert.equal(
    readState(workspace).images[identityOf(archiveOne)].digest,
    firstPayload.digest
  );
});

test('state loss publishes an absent image automatically', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const first = await runDeploy(workspace, { spec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];
  fs.rmSync(workspace.stateDir, { recursive: true, force: true });
  fs.unlinkSync(registry.manifestFile('fly-alpha', tagOf(archiveOne)));

  const second = await runDeploy(workspace, { spec });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readJsonLines(workspace.pushLog).length, 2);
  const secondPayload = readJsonLines(workspace.reconcileLog)[1].images.images[0];
  assert.equal(secondPayload.published, true);
  assert.equal(secondPayload.digest, firstPayload.digest);
  assert.ok(fs.existsSync(stateFile(workspace)));
});

test('state loss adopts an existing confirmed image without republishing', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const spec = derivationSpec(archiveOne);
  const first = await runDeploy(workspace, { spec });
  assert.equal(first.status, 0, first.stderr);
  const firstPayload = readJsonLines(workspace.reconcileLog)[0].images.images[0];
  fs.rmSync(workspace.stateDir, { recursive: true, force: true });

  const second = await runDeploy(workspace, { spec });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  const secondPayload = readJsonLines(workspace.reconcileLog)[1].images.images[0];
  assert.equal(secondPayload.published, false);
  assert.equal(secondPayload.digest, firstPayload.digest);
  assert.ok(fs.existsSync(stateFile(workspace)));
});

test('an existing image is deployed without registry inspection or publication', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const reference = 'registry.fly.io/fly-alpha:customer-7';
  const spec = {
    name: 'fly-alpha',
    machines: { web: { image: { existingImage: reference } } },
  };
  const result = await runDeploy(workspace, { spec });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readJsonLines(workspace.pushLog).length, 0);
  assert.equal(registry.requests.length, 0);
  assert.equal(fs.existsSync(workspace.stateDir), false);
  const reconcile = readJsonLines(workspace.reconcileLog)[0];
  assert.equal(reconcile.images.images.length, 1);
  assert.equal(reconcile.images.images[0].kind, 'existingImage');
  assert.equal(reconcile.images.images[0].reference, reference);
  assert.equal(reconcile.images.images[0].published, false);
  assert.equal(reconcile.images.machines.web.image.reference, reference);
  assertNoToken(result.stdout + result.stderr, 'existing-image deploy output');
});

test('a missing or empty token fails before publication and reconciliation', async () => {
  for (const token of [null, '']) {
    registry.reset();
    const workspace = makeWorkspace();
    const result = await runDeploy(workspace, {
      spec: derivationSpec(archiveOne),
      token,
    });
    assert.notEqual(result.status, 0, 'token=' + JSON.stringify(token));
    assert.match(result.stderr, /FLY_API_TOKEN is required/);
    assert.equal(readJsonLines(workspace.pushLog).length, 0);
    assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
    assert.equal(fs.existsSync(workspace.stateDir), false);
    assertNoToken(result.stdout + result.stderr, 'token rejection output');
    assert.deepEqual(
      fs.readdirSync(workspace.root).filter((name) =>
        name.startsWith('fly-app-')
      ),
      []
    );
  }
});

test('a token with line breaks fails before publication', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const result = await runDeploy(workspace, {
    spec: derivationSpec(archiveOne),
    token: TOKEN + '\n',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FLY_API_TOKEN must not contain line breaks/);
  assert.equal(readJsonLines(workspace.pushLog).length, 0);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
  assert.equal(fs.existsSync(workspace.stateDir), false);
  assertNoToken(result.stdout + result.stderr, 'line-break token output');
});

test('a token rejected by the registry fails with redacted diagnostics', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const rejected = 'fly-app-test-token-rejected-9e2f1b';
  const result = await runDeploy(workspace, {
    spec: derivationSpec(archiveOne),
    token: rejected,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication failed/);
  assert.match(result.stderr, /check FLY_API_TOKEN/);
  assert.ok(!result.stdout.includes(rejected));
  assert.ok(!result.stderr.includes(rejected));
  assert.ok(!result.stdout.includes(Buffer.from(rejected).toString('base64')));
  assert.ok(!result.stderr.includes(Buffer.from(rejected).toString('base64')));
  assert.ok(
    !result.stdout.includes(Buffer.from('x:' + rejected).toString('base64'))
  );
  assert.ok(
    !result.stderr.includes(Buffer.from('x:' + rejected).toString('base64'))
  );
  assert.equal(readJsonLines(workspace.pushLog).length, 0);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
  assert.equal(fs.existsSync(stateFile(workspace)), false);
  assert.ok(registry.requests.length > 0);
  assert.ok(registry.requests.every((request) => !request.authenticated));
});

test('a registry authentication rejection fails with a redacted authentication error', async () => {
  registry.reset();
  registry.mode = 'auth';
  const workspace = makeWorkspace();
  const result = await runDeploy(workspace, { spec: derivationSpec(archiveOne) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication failed/);
  assert.match(result.stderr, /check FLY_API_TOKEN/);
  assert.equal(readJsonLines(workspace.pushLog).length, 0);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
  assert.equal(fs.existsSync(stateFile(workspace)), false);
  if (fs.existsSync(workspace.stateDir)) {
    assert.equal(fs.statSync(workspace.stateDir).mode & 0o777, 0o700);
  }
  assertNoToken(result.stdout + result.stderr, 'authentication failure output');
  assert.ok(registry.requests.length > 0);
  assert.ok(registry.requests.every((request) => request.authenticated));
});

test('publication failure diagnostics are redacted and no state is written', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  const result = await runDeploy(workspace, {
    spec: derivationSpec(archiveOne),
    extraEnv: { FLY_TEST_PUSH_FAIL: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /publication failed/);
  assert.match(result.stderr, /\[REDACTED\]/);
  assertNoToken(result.stdout + result.stderr, 'publication failure output');
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
  assert.equal(fs.existsSync(stateFile(workspace)), false);
  assertWorkspaceSecretFree(workspace.root, 'failed publication workspace');
});

test('a registry server error is a failure, not a missing image', async () => {
  registry.reset();
  registry.mode = 'server-error';
  const workspace = makeWorkspace();
  const result = await runDeploy(workspace, { spec: derivationSpec(archiveOne) });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 500/);
  assert.match(result.stderr, /not known to be absent/);
  assert.equal(readJsonLines(workspace.pushLog).length, 0);
  assert.equal(readJsonLines(workspace.reconcileLog).length, 0);
});

test('concurrent same-app deployments publish once and both reconcile', async () => {
  registry.reset();
  const workspace = makeWorkspace();
  writeSpec(workspace, derivationSpec(archiveOne));
  const delay = { FLY_TEST_PUSH_DELAY: '1000' };
  const first = startDeploy(workspace, { extraEnv: delay });
  const second = startDeploy(workspace, { extraEnv: delay });
  const results = await Promise.all([first.done, second.done]);
  for (const result of results) {
    assert.equal(result.status, 0, result.stderr);
    assertNoToken(result.stdout + result.stderr, 'concurrent deploy output');
  }
  assert.equal(readJsonLines(workspace.pushLog).length, 1);
  const reconciles = readJsonLines(workspace.reconcileLog);
  assert.equal(reconciles.length, 2);
  const payloads = reconciles.map((entry) => entry.images.images[0]);
  assert.equal(new Set(payloads.map((payload) => payload.reference)).size, 1);
  assert.equal(new Set(payloads.map((payload) => payload.digest)).size, 1);
  assert.deepEqual(
    payloads.map((payload) => payload.published).sort(),
    [false, true]
  );
  assert.equal(
    readState(workspace).images[identityOf(archiveOne)].digest,
    payloads[0].digest
  );
  assertWorkspaceSecretFree(workspace.root, 'concurrent deployment workspace');
});

test('deployments for different apps do not serialize on one app lock', async () => {
  registry.reset();
  const alphaWorkspace = makeWorkspace();
  const betaWorkspace = makeWorkspace();
  const gate = path.join(alphaWorkspace.root, 'gate');
  fs.mkdirSync(gate);
  writeSpec(alphaWorkspace, derivationSpec(archiveOne, 'fly-alpha'));
  writeSpec(betaWorkspace, derivationSpec(archiveOne, 'fly-beta'));
  const alpha = startDeploy(alphaWorkspace, {
    extraEnv: { FLY_TEST_PUSH_GATE_DIR: gate },
  });
  try {
    await waitFor(
      () => fs.existsSync(path.join(gate, 'fly-alpha.entered')),
      'the alpha publication to enter its push gate'
    );
    const beta = await runDeploy(betaWorkspace, {
      spec: derivationSpec(archiveOne, 'fly-beta'),
      timeout: 60_000,
    });
    assert.equal(beta.status, 0, beta.stderr);
    assert.equal(readJsonLines(betaWorkspace.pushLog).length, 1);
    assert.equal(alpha.child.exitCode, null);
  } finally {
    fs.writeFileSync(path.join(gate, 'fly-alpha.release'), '');
  }
  const alphaResult = await alpha.done;
  assert.equal(alphaResult.status, 0, alphaResult.stderr);
  assert.equal(readJsonLines(alphaWorkspace.pushLog).length, 1);
  assert.equal(readJsonLines(alphaWorkspace.reconcileLog).length, 1);
  assert.equal(readJsonLines(betaWorkspace.reconcileLog).length, 1);
  assert.equal(
    readJsonLines(alphaWorkspace.reconcileLog)[0].images.app,
    'fly-alpha'
  );
  assert.equal(
    readJsonLines(betaWorkspace.reconcileLog)[0].images.app,
    'fly-beta'
  );
});

test('the built deployment program embeds no fixture token', async () => {
  const files = walkFiles(path.dirname(deployPackage));
  assert.ok(files.length > 0);
  for (const file of files) {
    assert.ok(
      !fs.readFileSync(file).includes(Buffer.from(TOKEN)),
      file + ' must not embed the fixture token'
    );
  }
});
