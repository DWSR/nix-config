'use strict';

// Runbook and declaration-agreement checks for the builder OAuth credential
// (mac-builder-for-fabro-nix-darwin-builds, task 4.1; design "Operator
// Provisioning" and "Builder Secret Store Addition"; requirements 4.3, 4.4,
// 4.6, 4.7).
//
// `secrets/README.md` is the operator's only instruction for this credential,
// so the assertions pin every element the operator needs: the 1Password source,
// the console-side `auth_keys` scope and `tag:mac-builder` tag, the edit
// command, the `sops -d --extract` verification, and the runtime path, mode,
// owner, and consumer that the design and the evaluated host declaration share.
// No assertion reads, decrypts, or prints a credential value.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const runbookPath = path.join(repoRoot, 'secrets/README.md');
const designPath = path.join(
  repoRoot,
  '.kiro/specs/mac-builder-for-fabro-nix-darwin-builds/design.md',
);
const NIX_TIMEOUT_MS = 600_000;

const secretName = 'builder-tailscale-oauth-secret';
const sourceUri = 'op://Infrastructure/Mac Builder Tailscale Credentials/Client Secret';
const runtimePath = '/run/secrets/builder-tailscale-oauth-secret';
const consumer = 'mac-builder-tailscale-auth';

// The runbook section between its heading and the next sibling heading.
function runbookSection() {
  const runbook = fs.readFileSync(runbookPath, 'utf8');
  const start = runbook.indexOf('### Builder OAuth credential');
  assert.notEqual(start, -1, 'missing the "### Builder OAuth credential" runbook section');

  const store = runbook.indexOf('## Builder host store');
  assert.ok(store >= 0 && store < start, 'the OAuth section must live under the builder host store');

  const end = runbook.indexOf('\n### ', start + 1);
  assert.notEqual(end, -1, 'the OAuth section must end at the next subsection');
  return runbook.slice(start, end);
}

let cachedDeclaration = null;

function evalDeclaration() {
  if (cachedDeclaration) return cachedDeclaration;

  const expr = `
let
  flake = builtins.getFlake (toString ${repoRoot});
  config = flake.darwinConfigurations."mac-builder".config;
  secret = config.sops.secrets.${secretName};
in
{
  secret = {
    path = secret.path;
    mode = secret.mode;
    owner = secret.owner;
    group = secret.group;
    sopsFile = toString secret.sopsFile;
  };
  daemons = builtins.attrNames config.launchd.daemons;
  authDaemon =
    if config.launchd.daemons ? ${consumer} then
      config.launchd.daemons.${consumer}.serviceConfig.ProgramArguments
    else
      null;
}
`;

  cachedDeclaration = JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    },
  ));
  return cachedDeclaration;
}

// Splits a launchd command into words, tolerating the quoting
// `escapeShellArgs` adds.
function commandWords(command) {
  assert.equal(typeof command, 'string', 'the auth daemon must set a command string');
  return command
    .match(/'[^']*'|"[^"]*"|\S+/g)
    .map((word) => word.replace(/^['"]|['"]$/g, ''));
}

// `launchd.daemons.<name>.command` is wrapped by the nix-darwin module as
// `/bin/wait4path /nix/store && exec <command>`; the words after `exec` are the
// arguments launchd really runs.
function execWords(programArguments) {
  assert.ok(Array.isArray(programArguments), 'the auth daemon must declare ProgramArguments');
  assert.equal(programArguments[0], '/bin/sh');
  assert.equal(programArguments[1], '-c');
  const script = programArguments[2];
  const execIndex = script.indexOf('exec ');
  assert.notEqual(execIndex, -1, `expected an exec wrapper, got: ${script}`);
  return commandWords(script.slice(execIndex + 'exec '.length));
}

test('the runbook names the 1Password source, its scope, and its tag', () => {
  const section = runbookSection();

  assert.ok(section.includes(sourceUri), `missing 1Password source ${sourceUri}`);
  assert.match(section, /`auth_keys` scope/);
  assert.match(section, /`tag:mac-builder`/);
  assert.match(
    section,
    /console/i,
    'the operator must learn that the scope and tag are set on the OAuth client in the console',
  );
  assert.match(
    section,
    /dedicated|own OAuth client/i,
    'the builder credential must be a different OAuth client from the guest one',
  );
});

test('the runbook documents the builder-key edit command', () => {
  const section = runbookSection();

  assert.match(section, /sops set --value-file/);
  assert.ok(
    section.includes(`'["${secretName}"]'`),
    'the edit command must target the builder OAuth key',
  );
  assert.ok(
    section.includes('secrets/remote-builder.mac-builder.yaml'),
    'the edit command must target the builder store',
  );
  assert.match(section, /SOPS_AGE_KEY_FILE=\/var\/lib\/sops-nix\/key\.txt/);
  assert.match(
    section,
    /never\s+reaches shell history|by file/i,
    'the edit flow must keep the value out of shell history',
  );
});

test('the runbook documents the sops -d --extract verification', () => {
  const section = runbookSection();

  assert.ok(section.includes(`sops -d --extract '["${secretName}"]'`));
  assert.match(section, /\| wc -c/, 'verification must inspect the value shape without printing it');
  assert.match(section, /never print|without printing/i);
});

test('the runbook documents the runtime path, mode, owner, and consumer', () => {
  const section = runbookSection();

  assert.ok(section.includes(runtimePath), `missing runtime path ${runtimePath}`);
  assert.match(section, /`0400`/);
  assert.match(section, /root:wheel|group\s+`wheel`|owner\s+`root`/);
  assert.ok(section.includes(consumer), `missing consumer ${consumer}`);
});

test('the design, the runbook, and the evaluated declaration agree', () => {
  const design = fs.readFileSync(designPath, 'utf8');
  const provisioning = design.indexOf('## Operator Provisioning');
  assert.notEqual(provisioning, -1, 'design must carry the Operator Provisioning section');

  const provisioningTable = design.slice(provisioning, design.indexOf('\n## ', provisioning + 1));
  assert.match(
    provisioningTable,
    new RegExp(`\\| \`${secretName}\` \\| \`${sourceUri.replace(/[.]/g, '\\.')}\` \\|`),
    'the Operator Provisioning table must name the builder credential and its 1Password source',
  );

  assert.ok(design.includes(runtimePath), `design must name the runtime path ${runtimePath}`);
  assert.match(design, /`builder-tailscale-oauth-secret`[^\n]*`0400` root:wheel[^\n]*`mac-builder-tailscale-auth`/);
  assert.ok(design.includes(consumer), `design must name the consumer ${consumer}`);

  const report = evalDeclaration();
  assert.equal(report.secret.path, runtimePath);
  assert.equal(report.secret.mode, '0400');
  assert.equal(report.secret.owner, 'root');
  assert.equal(report.secret.group, 'wheel');
  assert.match(report.secret.sopsFile, /remote-builder\.mac-builder\.yaml$/);

  assert.ok(report.daemons.includes(consumer), `daemons: ${report.daemons}`);
  const words = execWords(report.authDaemon);
  const flagIndex = words.indexOf('--auth-key-file');
  assert.notEqual(flagIndex, -1, `missing --auth-key-file in ${JSON.stringify(words)}`);
  assert.equal(words[flagIndex + 1], runtimePath);
});

test('no plaintext OAuth credential is checked into the tree', () => {
  const files = [
    runbookPath,
    designPath,
    path.join(repoRoot, 'configurations/mac-builder/tailscale.nix'),
    path.join(repoRoot, 'secrets/remote-builder.mac-builder.yaml'),
  ];

  for (const file of files) {
    const contents = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(
      contents,
      /tskey-[A-Za-z0-9_-]{12,}/,
      `${path.relative(repoRoot, file)} must not contain a plaintext OAuth secret`,
    );
  }

  const store = fs.readFileSync(
    path.join(repoRoot, 'secrets/remote-builder.mac-builder.yaml'),
    'utf8',
  );
  assert.match(store, /ENC\[AES256_GCM/, 'the builder store must stay encrypted');
  assert.doesNotMatch(store, new RegExp(`^${secretName}:\\s*tskey-`, 'm'));
});
