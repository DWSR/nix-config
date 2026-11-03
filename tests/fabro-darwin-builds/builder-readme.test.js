'use strict';

// Operator-facing contract checks for the builder README
// (mac-builder-for-fabro-nix-darwin-builds, task 4.3; design "Data Models →
// Tailnet Names and Tags", "Operator Provisioning", and "Component Contracts →
// Verification → Darwin Build Smoke"; requirements 3.4, 3.7, 3.8, 6.4, 6.5).
//
// `configurations/mac-builder/README.md` is the only operator instruction for
// the console-side tailnet change and the dispatch path, so the assertions pin
// every element the task promises: the `tagOwners` entry, the `tag:fabro` →
// `tag:mac-builder` grant on `tcp:22`, the reachability-versus-session split,
// the builder identity and MagicDNS name, the dedicated OAuth client's scope,
// tag, and runtime path, the pointer to `secrets/README.md`, and the
// `fabro-darwin-build-smoke` invocation.
//
// The cross-checks read the owning Nix modules and the secrets runbook, so a
// drift in the hostname, image name, credential path, or SSH port fails here
// instead of during a live Darwin build. No assertion reads a secret value.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const readmePath = path.join(repoRoot, 'configurations/mac-builder/README.md');
const tailscaleModulePath = path.join(repoRoot, 'configurations/mac-builder/tailscale.nix');
const builderModulePath = path.join(repoRoot, 'configurations/mac-builder/default.nix');
const dispatchModulePath = path.join(repoRoot, 'configurations/fabro-vm/darwin-dispatch.nix');
const sandboxImageModulePath = path.join(repoRoot, 'configurations/fabro-vm/sandbox-image.nix');
const secretsRunbookPath = path.join(repoRoot, 'secrets/README.md');

const builderHostname = 'mac-builder';
const builderTailnetName = 'mac-builder.tuxedo-musical.ts.net';
const oauthSecretName = 'builder-tailscale-oauth-secret';
const oauthRuntimePath = `/run/secrets/${oauthSecretName}`;

function readFile(file) {
  return fs.readFileSync(file, 'utf8');
}

function readme() {
  assert.ok(
    fs.existsSync(readmePath),
    'missing configurations/mac-builder/README.md (task 4.3 deliverable)',
  );
  return readFile(readmePath);
}

// Fenced code blocks whose info string starts with `info`.
function fencedBlocks(text, info) {
  const blocks = [];
  const pattern = new RegExp('```' + info + '\\n([\\s\\S]*?)```', 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) blocks.push(match[1]);
  return blocks;
}

// The console policy snippet must stay valid JSON so the operator can paste it
// into the tailnet policy file without transcribing it by hand.
function policySnippet() {
  for (const block of fencedBlocks(readme(), 'json')) {
    let parsed;
    try {
      parsed = JSON.parse(block);
    } catch {
      continue;
    }
    if (parsed && typeof parsed === 'object' && parsed.tagOwners) return parsed;
  }
  assert.fail('missing a JSON `tagOwners` policy snippet in the README');
}

test('the README carries the console-side tagOwners entry and the tcp:22 grant', () => {
  const text = readme();
  const policy = policySnippet();

  assert.match(text, /tagOwners/, 'the README must name the `tagOwners` console change');

  const owners = policy.tagOwners['tag:mac-builder'];
  assert.ok(Array.isArray(owners), 'tagOwners must declare `tag:mac-builder`');
  assert.ok(owners.length > 0, '`tag:mac-builder` must have at least one owner');
  for (const owner of owners) {
    assert.equal(typeof owner, 'string', 'tag owners must be console identities');
  }

  assert.ok(Array.isArray(policy.grants), 'the snippet must carry a `grants` list');
  const grants = policy.grants.filter(
    (grant) => Array.isArray(grant.dst) && grant.dst.includes('tag:mac-builder'),
  );
  assert.equal(grants.length, 1, `expected exactly one grant to tag:mac-builder, got ${grants.length}`);

  const [grant] = grants;
  assert.deepEqual(grant.src, ['tag:fabro'], 'only the guest tag may reach the builder');
  assert.deepEqual(grant.dst, ['tag:mac-builder']);
  assert.deepEqual(grant.ip, ['tcp:22'], 'the grant must open exactly the sshd port, not more');

  // The builder's sshd keeps the stock port, so `tcp:22` is the port the grant
  // must name. A module that moved sshd would make the documented grant wrong.
  const builderModule = readFile(builderModulePath);
  assert.match(builderModule, /services\.openssh\.enable = true;/);
  assert.doesNotMatch(builderModule, /services\.openssh\.ports/, 'the README grant assumes sshd on tcp:22');
  assert.doesNotMatch(builderModule, /^\s*Port\s+\d+/m, 'the README grant assumes sshd on tcp:22');
});

test('the README states that the ACL is reachability only and SSH keys authenticate the session', () => {
  const text = readme();

  assert.match(text, /reachability/i, 'the README must scope the ACL to reachability');
  assert.match(
    text,
    /SSH (client )?keys? (authenticate|prove|establish)/i,
    'the README must say the build session authenticates with the SSH keys',
  );
  assert.match(
    text,
    /(not|never|does not|do not)[^\n]*(authenticat|admit|authori[sz])/i,
    'the README must say tailnet admission does not authenticate a build session',
  );
  assert.match(text, /Tailscale SSH/i, 'the README must state that Tailscale SSH stays off');
  assert.match(
    text,
    /Tailscale SSH[^\n]*(not|never|off|disabled)|(not|never|no)[^\n]*Tailscale SSH/i,
  );
});

test('the README records the builder machine name, MagicDNS name, and OAuth identity', () => {
  const text = readme();
  const dispatchModule = readFile(dispatchModulePath);
  const tailscaleModule = readFile(tailscaleModulePath);

  // The README and the guest dispatch module must agree on the tailnet FQDN.
  const defaultHost = dispatchModule.match(/default = "([^"]+)";/);
  assert.ok(defaultHost, 'the dispatch module must declare its default machine hostName');
  assert.equal(defaultHost[1], builderTailnetName, 'dispatch default hostName drifted');

  assert.ok(text.includes(builderTailnetName), `missing the MagicDNS name ${builderTailnetName}`);
  assert.match(text, /MagicDNS/i);
  assert.match(text, new RegExp('--hostname[` \\t]+' + builderHostname + '\\b'));
  assert.ok(
    tailscaleModule.includes(`"${builderHostname}"`),
    'the auth daemon must still join as mac-builder',
  );

  assert.match(text, /auth_keys/);
  assert.match(text, /`tag:mac-builder`/);
  assert.match(text, /OAuth client/i);
  assert.match(text, /(dedicated|separate|distinct|own) OAuth client/i);
  assert.ok(text.includes(oauthRuntimePath), `missing the runtime path ${oauthRuntimePath}`);
  assert.ok(
    tailscaleModule.includes(`"${oauthSecretName}"`),
    'the builder module must still declare the OAuth credential',
  );
  assert.match(text, /`0400`/);
  assert.match(text, /root:wheel/);

  // The builder's credential must stay distinct from the guest's.
  assert.match(text, /tailscale-oauth-secret/);
  assert.match(text, /(different|separate|distinct)[^\n]*(guest|fabro)/i);
  assert.ok(
    readFile(secretsRunbookPath).includes(oauthRuntimePath),
    'the builder module and secrets/README.md must agree on the runtime path',
  );
});

test('the README links the secrets runbook instead of duplicating key provisioning', () => {
  const text = readme();

  assert.ok(text.includes('secrets/README.md'), 'the README must link the secrets runbook');
  assert.match(text, /(provision|generat)[^\n]*keys?|keys?[^\n]*(provision|generat)/i);
  assert.match(text, /rotat/i);
  assert.doesNotMatch(text, /ssh-keygen/, 'key generation belongs to secrets/README.md');
  assert.doesNotMatch(
    text,
    /sops set --value-file/,
    'the builder-store edit flow belongs to secrets/README.md',
  );
});

test('the README documents the fabro-darwin-build-smoke invocation and its steps', () => {
  const text = readme();
  const sandboxImageModule = readFile(sandboxImageModulePath);

  const defaultImage = sandboxImageModule.match(/default = "(localhost\/[^"]+)";/);
  assert.ok(defaultImage, 'the sandbox image module must declare its default name');
  assert.ok(
    text.includes(defaultImage[1]),
    `the README must name the default sandbox image ${defaultImage[1]}`,
  );

  assert.match(text, /fabro-darwin-build-smoke/);
  assert.match(
    text,
    /fabro-darwin-build-smoke \[[^\]]*IMAGE_REF[^\]]*\]/,
    'the README must show the optional IMAGE_REF argument',
  );
  assert.ok(text.includes('/run/fabro-sandbox/digest'), 'missing the default digest path');
  assert.match(text, /podman/);
  assert.match(text, /preflight/i, 'the README must describe the preflight step');
  assert.match(text, /aarch64-darwin/);
  assert.match(text, /store path/i, 'the README must describe the reported store path');
  assert.match(text, /\/run\/secrets\/build-client-key/);
  assert.match(text, /\/run\/secrets\/build-host-key/);
  assert.match(text, /sudo/, 'the smoke runs as root on the guest');
});

test('the README keeps the LAN forward and DHCP addresses off the dispatch path', () => {
  const text = readme();

  assert.match(text, /LAN forward/i);
  assert.match(text, /DHCP/i);
  assert.ok(text.includes('127.0.0.1:2222'), 'the README must name the LAN forward it does not use');
  assert.match(
    text,
    /(never|not|no)[^\n]*(LAN forward|DHCP)/i,
    'the README must say the dispatch path never uses the LAN forward or a DHCP address',
  );
  assert.match(text, /mac-builder-readiness/, 'the readiness check stays the LAN-forward endpoint check');
});

test('the README gives the operator an apply order for the console and both hosts', () => {
  const text = readme();

  assert.match(text, /nix run '\.#mac-builder-deploy'|mac-builder-deploy/);
  assert.match(text, /lima-vm-deploy/, 'the README must say how the guest is switched');
  assert.match(text, /darwin-rebuild|mac-builder-deploy/, 'the builder switch must be documented');
  assert.match(text, /console/i);
  assert.match(
    text,
    /(first|before)[^\n]*(console|grant|tag)|(console|grant|tag)[^\n]*(first|before)/i,
    'the README must put the console change before the host switches',
  );
});

test('the README carries no plaintext credential value', () => {
  const text = readme();

  assert.doesNotMatch(text, /tskey-[A-Za-z0-9_-]{12,}/);
  assert.doesNotMatch(text, /AGE-SECRET-KEY-/);
  assert.doesNotMatch(text, /BEGIN OPENSSH PRIVATE KEY/);
});
