'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalJson, repoRoot } = require('./helpers');

// Evaluate the guest's `fabro.sandboxImage` option tree through the flake, so
// the assertions read the NixOS-evaluated image (OCI config, contents, archive,
// and digest derivation) rather than the module source. The guest is
// `aarch64-linux`, but the option tree is evaluable on any host — the same
// `nixEvalJson` pattern tests/fabro-service uses.
function sandboxImage() {
  return nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      cfg = flake.nixosConfigurations.fabro-vm.config.fabro.sandboxImage;
    in
    {
      enable = cfg.enable;
      name = cfg.name;
      tag = cfg.tag;
      env = cfg.imageConfig.Env;
      cmd = cfg.imageConfig.Cmd;
      workingDir = cfg.imageConfig.WorkingDir;
      contentNames = map (p: p.pname or p.name) cfg.contents;
      copyToRootName = cfg.copyToRoot.name;
      copyToRootNames = map (p: p.pname or p.name) cfg.copyToRoot.paths;
      copyToRootPathsToLink = cfg.copyToRoot.pathsToLink;
      archiveOutPath = cfg.archive.outPath;
      archiveSystem = cfg.archive.system;
      digestBuildCommand = cfg.digest.buildCommand;
    }
  `);
}

test('the sandbox image is enabled and pinned to the local name and tag', () => {
  const image = sandboxImage();
  assert.equal(image.enable, true);
  assert.equal(image.name, 'localhost/fabro-sandbox');
  assert.equal(image.tag, 'latest');
});

test('the image config puts bash on PATH and points nix at the host daemon', () => {
  const { env, cmd, workingDir } = sandboxImage();
  // Requirements 1.3, 1.4: the Docker provider runs a non-login shell, so
  // PATH must come from the image config rather than a login profile.
  assert.ok(env.includes('PATH=/bin'), `Env must contain PATH=/bin: ${JSON.stringify(env)}`);
  assert.ok(
    env.includes('NIX_REMOTE=daemon'),
    `Env must contain NIX_REMOTE=daemon: ${JSON.stringify(env)}`,
  );
  // The in-container nix client must enable the experimental features:
  // containers see neither the guest's /etc/nix/nix.conf nor a per-user
  // config, and every nix-command (e.g. the `nix store ping` smoke daemon
  // probe) is gated on them before the daemon is ever reached.
  assert.ok(
    env.includes('NIX_CONFIG=experimental-features = nix-command flakes'),
    `Env must contain NIX_CONFIG with nix-command and flakes: ${JSON.stringify(env)}`,
  );
  // The container has no /etc/passwd-derived home, so HOME is empty unless the
  // image sets it. Nix then resolves the flake registry and fetcher/eval
  // caches relative to the working directory: `nix registry list` fails with
  // `error: not an absolute path: ".cache/nix/flake-registry.json"` and the
  // caches land in /workspace. /tmp matches the proven workaround and is
  // writable in the container.
  assert.ok(
    env.includes('HOME=/tmp'),
    `Env must contain HOME=/tmp: ${JSON.stringify(env)}`,
  );
  assert.ok(
    env.includes('XDG_CACHE_HOME=/tmp/nix-cache'),
    `Env must contain XDG_CACHE_HOME=/tmp/nix-cache: ${JSON.stringify(env)}`,
  );
  // Containers see neither the guest's /etc/ssl nor its CA configuration, so
  // https clients (git's libcurl via OpenSSL, gh via Go's crypto/x509) must
  // be pointed at the CA bundle linked into the image root or every TLS
  // connection fails certificate validation.
  assert.ok(
    env.includes('SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt'),
    `Env must contain SSL_CERT_FILE pointing at the CA bundle: ${JSON.stringify(env)}`,
  );
  assert.deepEqual(cmd, ['/bin/bash']);
  assert.equal(workingDir, '/');
});

test('copyToRoot exposes the tools on /bin, the CA bundle, and /usr/bin/env', () => {
  const image = sandboxImage();
  // Requirements 1.1, 1.2, 1.5: the tools are linked into the image's /bin.
  // `bashInteractive` reports `bash-interactive` as its pname. `util-linux`
  // carries `setsid`, which the Fabro sandbox driver requires before it will
  // run a command node (its absence exits 127 with `sandbox-driver: the
  // container image must provide setsid and env`). `gh` is the GitHub CLI
  // sandbox runs use; `findutils` and `gnugrep` carry `find` and `grep`,
  // which Pebble (the agent harness) probes for in the execution scope before
  // it builds a session; `python3` runs the DWSR/fabro workflow command
  // nodes' scripts (dispatch, oneshot, kiro-*: without it command nodes fail
  // with `env: 'python3': No such file or directory`). `cacert` reports
  // `nss-cacert` as its pname and carries the
  // `/etc/ssl/certs/ca-bundle.crt` the SSL_CERT_FILE env points at.
  // ripgrep/gawk/jq/curl are the developer tools workflow agents expect, and
  // `fabro-sandbox-usr-bin-env` puts `/usr/bin/env` in the root so
  // `#!/usr/bin/env node` shims from npm-installed packages run.
  for (const name of [
    'bash',
    'git',
    'gh',
    'coreutils',
    'findutils',
    'gnugrep',
    'python3',
    'nix',
    'util-linux',
    'nss-cacert',
    'ripgrep',
    'gawk',
    'jq',
    'curl',
    'fabro-sandbox-usr-bin-env',
  ]) {
    assert.ok(
      image.copyToRootNames.some(
        (candidate) => candidate === name || candidate.startsWith(`${name}-`),
      ),
      `copyToRoot must carry ${name}: ${JSON.stringify(image.copyToRootNames)}`,
    );
  }
  assert.equal(image.copyToRootName, 'fabro-sandbox-root');
  assert.ok(image.copyToRootPathsToLink.includes('/bin'));
  assert.ok(
    image.copyToRootPathsToLink.includes('/etc/ssl/certs'),
    `pathsToLink must expose the CA bundle: ${JSON.stringify(image.copyToRootPathsToLink)}`,
  );
  assert.ok(
    image.copyToRootPathsToLink.includes('/usr/bin'),
    `pathsToLink must expose /usr/bin/env: ${JSON.stringify(image.copyToRootPathsToLink)}`,
  );
  // The declared contents and the built root carry the same packages.
  assert.deepEqual([...image.contentNames].sort(), [...image.copyToRootNames].sort());
});

test('the archive is an aarch64-linux OCI image tarball', () => {
  const image = sandboxImage();
  // Requirement 2.1: the image is built for the guest's architecture and the
  // archive is the `nix-image-*.tar` OCI image layout.
  assert.equal(image.archiveSystem, 'aarch64-linux');
  assert.match(image.archiveOutPath, /nix-image-.*\.tar$/);
});

test('the digest derivation reads index.json and writes a sha256 line', () => {
  const { digestBuildCommand } = sandboxImage();
  // Requirements 2.5, 2.6: extract the manifest digest from the archive's
  // index.json and emit a single sha256:<hex> line to $out, failing the build
  // when the value is not a sha256 digest.
  assert.match(digestBuildCommand, /tar -xOf .* index\.json/);
  assert.match(digestBuildCommand, /jq -r '\.manifests\[0\]\.digest'/);
  assert.match(digestBuildCommand, /sha256:/);
  assert.match(digestBuildCommand, /"\$out"/);
});
