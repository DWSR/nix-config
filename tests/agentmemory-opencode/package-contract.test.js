'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const overlayPath = path.join(repoRoot, 'overlays', 'agentmemory.nix');
const manifestPath = path.join(repoRoot, 'overlays', 'agentmemory-deps', 'package.json');
const lockPath = path.join(repoRoot, 'overlays', 'agentmemory-deps', 'package-lock.json');
const overlaysPath = path.join(repoRoot, 'overlays', 'default.nix');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

test('dependency manifest and lock retain the selected upstream package contract', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));

  assert.equal(manifest.name, '@agentmemory/agentmemory');
  assert.equal(manifest.version, '0.9.29');
  assert.equal(manifest.type, 'module');
  assert.equal(manifest.license, 'Apache-2.0');
  assert.equal(manifest.dependencies['iii-sdk'], '0.11.2');
  assert.deepEqual(manifest.files, [
    'dist/',
    'plugin/',
    'integrations/pi/',
    'iii-config.yaml',
    'iii-config.docker.yaml',
    'docker-compose.yml',
    '.env.example',
    'LICENSE',
    'README.md',
    'AGENTS.md',
  ]);

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
  assert.equal(lock.packages['node_modules/iii-sdk'].version, '0.11.2');
});

test('overlay pins both Darwin dependency revisions and preserves upstream assets', () => {
  const overlay = read('overlays/agentmemory.nix');

  assert.match(overlay, /e04ba88819c365c9acf9d6661ea802143e728bd6/);
  assert.match(overlay, /iii-engine v0\.11\.2/);
  assert.match(overlay, /iii-aarch64-apple-darwin/);
  assert.match(overlay, /iii-x86_64-apple-darwin/);
  assert.match(overlay, /aarch64-darwin/);
  assert.match(overlay, /x86_64-darwin/);
  assert.match(overlay, /Unsupported agentmemory system/);
  assert.match(overlay, /buildNpmPackage/);
  assert.match(overlay, /importNpmLock/);
  assert.match(overlay, /plugin/);
  assert.match(overlay, /integrations\/pi/);
  assert.match(overlay, /iii-config\.yaml/);
  assert.match(overlay, /docker-compose\.yml/);
  assert.match(overlay, /LICENSE/);
  assert.match(overlay, /README\.md/);
  assert.match(overlay, /AGENTS\.md/);
});

test('custom package overlay exposes the AgentMemory package closure', () => {
  const overlays = read('overlays/default.nix');

  assert.match(overlays, /agentmemory = import \.\/agentmemory\.nix/);
  assert.match(overlays, /\(agentmemory final prev\)/);
});

test('runtime package exposes stock daemon and MCP commands with pinned iii on PATH', () => {
  const overlay = read('overlays/agentmemory.nix');

  assert.match(overlay, /nativeBuildInputs = \[ final\.makeWrapper \];/);
  assert.match(overlay, /makeWrapper \$\{final\.nodejs\}\/bin\/node ["']?\$out\/bin\/agentmemory/);
  assert.match(overlay, /--prefix PATH : \$\{iiiEngine\}\/bin/);
  assert.match(overlay, /--set AGENTMEMORY_III_VERSION \$\{iiiVersion\}/);
  assert.match(overlay, /makeWrapper ["']?\$out\/bin\/agentmemory["']? ["']?\$out\/bin\/agentmemory-mcp/);
  assert.match(overlay, /--add-flags mcp/);
});

test('runtime package keeps upstream configurable loopback configuration and stock assets', () => {
  const overlay = read('overlays/agentmemory.nix');

  assert.match(overlay, /iii-config\.yaml/);
  assert.match(overlay, /grep -q 'host: 127\.0\.0\.1'/);
  assert.doesNotMatch(overlay, /--set III_(?:REST|STREAM|VIEWER|ENGINE)_PORT/);
  assert.match(overlay, /plugin\/opencode\/agentmemory-capture\.ts/);
  assert.match(overlay, /patches = \[ \.\/agentmemory-patches\/opencode-capture\.patch \];/);
  assert.match(overlay, /integrations\/pi\/index\.ts/);
  assert.match(overlay, /! grep -q 'host: 0\.0\.0\.0'/);
});

test('runtime wrapper keeps a high REST port valid without overriding engine endpoints', () => {
  const overlay = read('overlays/agentmemory.nix');
  const restPort = 35111;
  const upstreamEnginePort = restPort + 46023;
  const derivedEnginePort = ((upstreamEnginePort - 1024) % 64512) + 1024;

  assert.equal(upstreamEnginePort, 81134);
  assert.ok(derivedEnginePort > 1023 && derivedEnginePort <= 65535);
  assert.match(overlay, /III_REST_PORT/);
  assert.match(overlay, /III_ENGINE_PORT/);
  assert.match(overlay, /enginePort=\$\(\(restPort \+ 46023\)\)/);
  assert.match(overlay, /% 64512/);
  assert.match(overlay, /III_ENGINE_URL/);
});
