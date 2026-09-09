'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const secret = 'preflight-test-bearer-value';

function renderIntegration() {
  const expression = `(let
  flake = builtins.getFlake ${JSON.stringify(repoRoot)};
  pkgs = import flake.inputs.nixpkgs {
    system = "aarch64-darwin";
    overlays = [ flake.outputs.overlays.custom-packages ];
    config.allowUnfree = true;
  };
  hm = (flake.inputs.home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/agentmemory.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/common/opencode-nono.nix'))}
      ${JSON.stringify(path.join(repoRoot, 'home-manager/mcp'))}
      "\${flake.inputs.home-manager}/modules/programs/opencode.nix"
      {
        home.username = "brandonmcnama";
        home.homeDirectory = "/Users/brandonmcnama";
        home.stateVersion = "26.05";
        home.opencode.memoryBackend = "agentmemory";
        home.mcp = {
          obsidianVaultPath = "/tmp/agentmemory/vault";
          githubToken = builtins.concatStringsSep "" [ "$" "{env:MCP_GITHUB_TOKEN}" ];
          keychainSecrets."agentmemory-bearer" = "op://Private/AgentMemory/Bearer";
        };
        programs.agentmemory = {
          enable = true;
          restPort = 35111;
          bearerReference = "agentmemory-bearer";
        };
        programs.opencode-nono.enable = true;
      }
    ];
  }).config;
in builtins.toJSON {
  preflight = hm.home.opencode.preflightScript;
  wrapperCommands = hm.home.opencode.wrapperCommands;
  profiles = builtins.mapAttrs (_: file: file.text) {
    managed = hm.xdg.configFile."nono/profiles/opencode-managed.json";
    audit = hm.xdg.configFile."nono/profiles/opencode-audit.json";
    review = hm.xdg.configFile."nono/profiles/opencode-review.json";
  };
})`;

  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--impure', '--raw', '--expr', expression],
    { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
  ));
}

function makeFakeCommands(directory) {
  const securityPath = path.join(directory, 'security');
  const curlPath = path.join(directory, 'curl');
  fs.writeFileSync(
    securityPath,
    `#!/bin/sh\nprintf '%s' '${secret}'\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    curlPath,
    `#!/bin/sh
url=""
authorization=""
if [ -n "\${CURL_REQUEST_LOG:-}" ]; then
  printf '%s\n' "$@" > "\${CURL_REQUEST_LOG}"
fi
for arg in "$@"; do
  case "$arg" in
    Authorization:*) authorization="$arg" ;;
    http://*) url="$arg" ;;
  esac
done
case "$url" in
  */api/v1/servers)
    if [ "\${PREFLIGHT_MODE:-healthy}" = obsidian-fail ]; then
      printf '%s' '{"data":{"servers":[{"name":"obsidian","connected":false}]}}'
    else
      printf '%s' '{"data":{"servers":[{"name":"obsidian","connected":true}]}}'
    fi
    ;;
  */agentmemory/health)
    if [ "$authorization" != 'Authorization: Bearer ${secret}' ]; then
      printf '%s' '{"status":"unauthorized"}'
      exit 22
    fi
    if [ "\${PREFLIGHT_MODE:-healthy}" = healthy ]; then
      printf '%s' '{"status":"healthy"}'
    elif [ "$PREFLIGHT_MODE" = degraded ]; then
      printf '%s' '{"status":"degraded"}'
    else
      printf '%s' '{"status":"fallback"}'
    fi
    ;;
esac
`,
    { mode: 0o755 },
  );
  return { securityPath, curlPath };
}

function runPreflight(preflight, mode = 'healthy') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentmemory-preflight-'));
  try {
    const fake = makeFakeCommands(directory);
    const requestLog = path.join(directory, 'curl-args');
    const script = preflight
      .replaceAll('/usr/bin/security', fake.securityPath)
      .replaceAll('/usr/bin/curl', fake.curlPath);
    const result = childProcess.spawnSync('/bin/bash', ['-c', `${script}\nprintf launched\n`], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CURL_REQUEST_LOG: requestLog, PREFLIGHT_MODE: mode },
      timeout: 30_000,
    });
    return {
      ...result,
      curlArgs: fs.existsSync(requestLog) ? fs.readFileSync(requestLog, 'utf8') : '',
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('AgentMemory preflight follows the independent Obsidian check and exports no secret text', () => {
  const rendered = renderIntegration();
  const obsidianIndex = rendered.preflight.indexOf('obsidian MCP server not connected');
  const agentMemoryIndex = rendered.preflight.indexOf('AgentMemory daemon');

  assert.match(rendered.preflight, /export AGENTMEMORY_URL="http:\/\/127\.0\.0\.1:35111"/);
  assert.ok(obsidianIndex >= 0, 'the existing Obsidian preflight must remain present');
  assert.ok(agentMemoryIndex > obsidianIndex, 'AgentMemory health must run after the Obsidian check');

  for (const [name, text] of Object.entries(rendered.profiles)) {
    const profile = JSON.parse(text);
    assert.ok(profile.network.open_port.includes(8080), `${name} must preserve mcpproxy access`);
    assert.ok(profile.network.open_port.includes(35111), `${name} must allow AgentMemory REST access`);
    assert.ok(profile.environment.allow_vars.includes('AGENTMEMORY_SECRET'), `${name} must allow the bearer name`);
    assert.doesNotMatch(JSON.stringify(profile.filesystem), /agentmemory/i);
    assert.doesNotMatch(text, /\.agentmemory/i);
    assert.doesNotMatch(text, /op:\/\/Private\/AgentMemory\/Bearer/);
    assert.doesNotMatch(text, new RegExp(secret));
  }

  const result = runPreflight(rendered.preflight, 'healthy');
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /launched/);
  assert.match(result.curlArgs, /Authorization: Bearer preflight-test-bearer-value/);
  assert.match(result.curlArgs, /http:\/\/127\.0\.0\.1:35111\/agentmemory\/health/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
});

test('AgentMemory preflight rejects standalone fallback and does not launch OpenCode', () => {
  const rendered = renderIntegration();
  const result = runPreflight(rendered.preflight, 'fallback');

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /launched/);
  assert.match(result.stderr, /AgentMemory daemon preflight failed/);
  assert.equal((result.stderr.match(/Recover AgentMemory with:/g) || []).length, 1);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
});

test('AgentMemory preflight accepts a degraded but available full daemon', () => {
  const rendered = renderIntegration();
  const result = runPreflight(rendered.preflight, 'degraded');

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /launched/);
  assert.doesNotMatch(result.stderr, /AgentMemory daemon preflight failed/);
});

test('the preserved Obsidian preflight still stops before AgentMemory when upstream is disconnected', () => {
  const rendered = renderIntegration();
  const result = runPreflight(rendered.preflight, 'obsidian-fail');

  assert.equal(result.status, 1, `${result.stderr}\n${result.stdout}`);
  assert.doesNotMatch(result.stdout, /launched/);
  assert.match(result.stderr, /obsidian MCP server not connected/);
  assert.doesNotMatch(result.stderr, /AgentMemory daemon preflight failed/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, new RegExp(secret));
});
