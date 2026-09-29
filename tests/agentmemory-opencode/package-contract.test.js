'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const read = (relativePath) => fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');

test('dependency manifest and lock retain the selected upstream package contract', () => {
  const manifest = JSON.parse(read('overlays/agentmemory-deps/package.json'));
  const lock = JSON.parse(read('overlays/agentmemory-deps/package-lock.json'));

  assert.equal(manifest.name, '@agentmemory/agentmemory');
  assert.equal(manifest.version, '0.9.29');
  assert.equal(manifest.repository.url, 'https://github.com/DWSR/agentmemory');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.dependencies['iii-sdk'], '0.11.5');
  for (const requiredFile of [
    'dist/', 'plugin/', 'integrations/', 'iii-config.yaml',
    'iii-config.docker.yaml', 'docker-compose.yml', '.env.example',
    'LICENSE', 'README.md', 'AGENTS.md',
  ]) {
    assert.ok(manifest.files.includes(requiredFile), `${requiredFile} is missing from the package manifest`);
  }

  assert.equal(lock.lockfileVersion, 3);
  const lockRoot = lock.packages[''];
  assert.equal(lockRoot.name, manifest.name);
  assert.equal(lockRoot.version, manifest.version);
  assert.equal(lockRoot.license, manifest.license);
  assert.deepEqual(lockRoot.dependencies, manifest.dependencies);
  assert.deepEqual(lockRoot.optionalDependencies, manifest.optionalDependencies);
  assert.deepEqual(lockRoot.devDependencies, manifest.devDependencies);
  assert.deepEqual(lockRoot.engines, manifest.engines);
  assert.deepEqual(lockRoot.bin, manifest.bin);
  assert.equal(lock.packages['node_modules/iii-sdk'].version, '0.11.5');
});

test('the effective AgentMemory package comes from the flake and retains its patches', () => {
  const flake = read('flake.nix');
  const overlays = read('overlays/default.nix');
  const module = read('home-manager/common/agentmemory.nix');

  assert.match(flake, /agentmemory\s*=\s*\{\s*url = "github:DWSR\/agentmemory"/s);
  assert.match(overlays, /agentmemory =\s*inputs\.agentmemory\.packages\.\$\{final\.stdenv\.hostPlatform\.system\}\.agentmemory\.overrideAttrs/);
  assert.match(module, /default = pkgs\.agentmemory/);

  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    pkgs = import flake.inputs.nixpkgs {
      system = "aarch64-darwin";
      overlays = [ flake.outputs.overlays.custom-packages ];
    };
    package = pkgs.agentmemory;
  in builtins.toJSON {
    inherit (package) pname version sourceRevision iiiVersion iiiRevision;
    upstreamVersion = flake.inputs.agentmemory.packages.aarch64-darwin.agentmemory.version;
    patches = map (p: builtins.baseNameOf (toString p)) package.patches;
  }`;
  const effective = JSON.parse(execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000,
  }));

  assert.equal(effective.pname, 'agentmemory');
  assert.equal(effective.version, effective.upstreamVersion);
  assert.equal(effective.sourceRevision, '0d9306db408b1243a5b27dfa0d0c3c2790d9f6a6');
  assert.equal(effective.iiiVersion, '0.11.5');
  assert.equal(effective.iiiRevision, 'iii/v0.11.5');
  assert.deepEqual(effective.patches, [
    'opencode-capture.patch', 'opencode-cache-stability.patch',
    'bm25-index-cap.patch', 'disable-otel.patch',
  ]);
  assert.match(overlays, /cp \$\{\.\/agentmemory-deps\/package\.json\} package\.json/);
  assert.match(overlays, /cp \$\{\.\/agentmemory-deps\/package-lock\.json\} package-lock\.json/);
  assert.match(overlays, /npmDeps = final\.importNpmLock/);
  assert.match(overlays, /npmConfigHook = final\.importNpmLock\.npmConfigHook/);
  assert.match(overlays, /input\.name or ""\) != "npm-config-hook"/);
  assert.match(flake, /agentMemoryPackage = pkgs\.agentmemory/);
});

test('the separate iii-engine overlay pins both Darwin releases without a second AgentMemory definition', () => {
  const overlay = read('overlays/agentmemory.nix');
  const overlays = read('overlays/default.nix');

  assert.match(overlays, /iiiEngine = import \.\/agentmemory\.nix/);
  assert.match(overlays, /\(iiiEngine final prev\)/);
  assert.match(overlay, /iii-engine = iiiEngine/);
  assert.match(overlay, /pname = "iii-engine"/);
  assert.match(overlay, /iiiVersion = "0\.11\.5"/);
  assert.match(overlay, /iii-aarch64-apple-darwin/);
  assert.match(overlay, /iii-x86_64-apple-darwin/);
  assert.match(overlay, /Unsupported iii-engine system/);
  assert.doesNotMatch(overlay, /buildNpmPackage|agentmemory =/);

  const expression = `let
    flake = builtins.getFlake ${JSON.stringify(repoRoot)};
    system = name: let pkgs = import flake.inputs.nixpkgs {
      inherit (name) system;
      overlays = [ flake.outputs.overlays.custom-packages ];
    }; in {
      inherit (pkgs.iii-engine) pname version sourceRevision;
      src = builtins.baseNameOf (toString pkgs.iii-engine.src);
    };
  in builtins.toJSON {
    arm = system { system = "aarch64-darwin"; };
    intel = system { system = "x86_64-darwin"; };
  }`;
  const engine = JSON.parse(execFileSync('nix', ['eval', '--impure', '--raw', '--expr', expression], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 600_000,
  }));
  for (const variant of Object.values(engine)) {
    assert.equal(variant.pname, 'iii-engine');
    assert.equal(variant.version, '0.11.5');
    assert.equal(variant.sourceRevision, 'iii/v0.11.5');
  }
  assert.match(engine.arm.src, /iii-aarch64-apple-darwin/);
  assert.match(engine.intel.src, /iii-x86_64-apple-darwin/);
});

test('the runtime patch keeps iii exporters disabled and BM25 bounds enforced', () => {
  const otel = read('overlays/agentmemory-patches/disable-otel.patch');
  const bm25 = read('overlays/agentmemory-patches/bm25-index-cap.patch');

  assert.match(otel, /enabled: false/);
  assert.match(otel, /metrics_enabled: false/);
  assert.match(otel, /logs_enabled: false/);
  assert.match(bm25, /AGENTMEMORY_BM25_MAX_ENTRIES/);
  assert.match(bm25, /AGENTMEMORY_BM25_PERSIST_MAX_ENTRIES/);
  assert.match(bm25, /this\.entries\.size >= this\.maxEntries/);
  assert.match(bm25, /persistence limit/);
  assert.match(bm25, /evicts the oldest entries/);
});
