'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const NIX_COMMAND_TIMEOUT_MS = 600_000;
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});
const canExecuteShopifyPackage = process.platform === 'darwin' && process.arch === 'arm64';

function sourcePrelude() {
  return `
    source = builtins.path {
      path = ${repoRoot};
      name = "nix-config-binks-test-source";
      filter = path: type:
        let name = builtins.baseNameOf path;
        in !(builtins.elem name [ ".git" ".direnv" ".ruff_cache" "result" ]);
    };
    flake = builtins.getFlake ("path:" + builtins.unsafeDiscardStringContext (toString source));
  `;
}

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ));
}

function nixBuildOutPath(expr) {
  return childProcess.execFileSync(
    'nix',
    ['build', '--no-link', '--print-out-paths', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  ).trim();
}

function packageBuildExpr() {
  return `
    let
      ${sourcePrelude()}
      config = flake.darwinConfigurations.${HOSTS.shopify}.config.home-manager.users.brandonmcnama;
      isBinksPackage = package:
        (builtins.parseDrvName package.name).name == "binks-review";
    in
      builtins.head (builtins.filter isBinksPackage config.home.packages)
  `;
}

function isolatedPackageBuildExpr(homeDirectory, { fakeUv = false } = {}) {
  const fakeUvLog = JSON.stringify(path.join(homeDirectory, 'uv-install.log'));
  const fakeUvBinding = fakeUv
    ? `
      fakeUv = pkgs.writeShellApplication {
        name = "uv";
        runtimeInputs = [ pkgs.coreutils ];
        text = ''
          if [[ "$1" == "tool" && "$2" == "install" ]]; then
            printf '%s\\n%s\\n%s\\n' "$*" "$UV_EXTRA_INDEX_URL" "$PATH" > ${fakeUvLog}
            mkdir -p "$UV_TOOL_BIN_DIR"
            cat > "$UV_TOOL_BIN_DIR/binks-pr-review" <<'EOF'
#!/bin/sh
if [ "$1" = "--version" ]; then
  if [ -n "$UV_EXTRA_INDEX_URL$UV_CONFIG_FILE$UV_FIND_LINKS$UV_INDEX$UV_DEFAULT_INDEX$UV_INDEX_OTHER_PASSWORD$UV_INDEX_CLOUDSMITH_PASSWORD$UV_INDEX_CLOUDSMITH_USERNAME$BINKS_API_PASSWORD$BINKS_API_USER$BINKS_AI_PROXY_KEY$OPENCODE_API_KEY$OPENAI_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then
    printf '%s\\n' 'credential leaked into version probe' >&2
    exit 9
  fi
  printf '%s\\n' 'binks-pr-review 0.13.3'
  exit 0
fi
printf 'args:'
printf ' <%s>' "$@"
printf '\\nuv_extra=%s base_url=%s\\n' "$UV_EXTRA_INDEX_URL" "$BINKS_BASE_URL"
EOF
            chmod +x "$UV_TOOL_BIN_DIR/binks-pr-review"
            exit 0
          fi

          exit 64
        '';
      };
    `
    : '';
  const uvOverride = fakeUv ? 'uv = fakeUv;' : '';

  return `
    let
      ${sourcePrelude()}
      pkgs = flake.darwinConfigurations.${HOSTS.shopify}.pkgs;
      ${fakeUvBinding}
    in
      pkgs.callPackage (source + "/scripts/binks-review.nix") {
        homeDirectory = ${JSON.stringify(homeDirectory)};
        ${uvOverride}
      }
  `;
}

function hostRenderExpr() {
  return `
    let
      ${sourcePrelude()}
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          files = config.xdg.configFile;
          commands = config.programs.opencode.commands;
          packagePaths = map
            (package: builtins.unsafeDiscardStringContext "\${package}")
            (builtins.filter
              (package: (builtins.parseDrvName package.name).name == "binks-review")
              config.home.packages);
          commandPath = commands."binks-review" or null;
          commandText = if commandPath == null then null else builtins.readFile commandPath;
          skillPresent = builtins.hasAttr "opencode/skills/binks-pr-review" files;
          skillSource = if skillPresent then files."opencode/skills/binks-pr-review".source else null;
          skillText = if skillPresent then builtins.readFile (skillSource + "/SKILL.md") else null;
          stateActivation = config.home.activation.createBinksReviewState.data or null;
          binksXdgFiles = builtins.filter
            (name: builtins.match ".*binks.*" name != null)
            (builtins.attrNames files);
          piBinksFiles = builtins.filter
            (name: builtins.match ".*[.]pi/.*binks.*" name != null)
            (builtins.attrNames config.home.file);
          managedName = config.programs.opencode-nono.managedProfile;
          auditName = config.programs.opencode-nono.auditProfile;
          managed = config.programs.opencode-nono.profiles.\${managedName};
          audit = config.programs.opencode-nono.profiles.\${auditName};
        in
        {
          inherit packagePaths commandText skillPresent skillText stateActivation binksXdgFiles piBinksFiles;
          commandNames = builtins.attrNames commands;
          agentNames = builtins.attrNames config.programs.opencode.agents;
          skillNames = builtins.filter
            (name: builtins.match "opencode/skills/.*" name != null)
            (builtins.attrNames files);
          sandbox = {
            managedAllow = managed.filesystem.allow;
            managedRead = managed.filesystem.read;
            managedReadFile = managed.filesystem.readFile;
            managedDeny = managed.filesystem.deny;
            managedAllowVars = managed.environment.allowVars;
            auditAllow = audit.filesystem.allow;
            auditRead = audit.filesystem.read;
            auditReadFile = audit.filesystem.readFile;
            auditDeny = audit.filesystem.deny;
            auditAllowVars = audit.environment.allowVars;
          };
        };
    in
    {
      personal = summarize "${HOSTS.personal}";
      shopify = summarize "${HOSTS.shopify}";
    }
  `;
}

function includesAll(actual, expected) {
  for (const entry of expected) {
    assert.equal(actual.includes(entry), true, `expected ${entry}`);
  }
}

test('wrapper builds with a Nix-controlled pin and no periodic updater', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const outPath = nixBuildOutPath(packageBuildExpr());
  const executable = path.join(outPath, 'bin', 'binks-review');
  const wrapper = fs.readFileSync(executable, 'utf8');

  assert.equal(fs.statSync(executable).mode & 0o111, 0o111);
  assert.match(wrapper, /package_version="0\.13\.3"/);
  assert.match(wrapper, /\/bin\/uv" tool install/);
  assert.match(wrapper, /--upgrade/);
  assert.match(wrapper, /"\$package_spec"/);
  assert.match(wrapper, /UV_PYTHON_DOWNLOADS=never/);
  assert.match(wrapper, /\.local\/share\/binks-review\/tools/);
  assert.match(wrapper, /UV_EXTRA_INDEX_URL \\/);
  assert.match(wrapper, /\/bin\/env"\n\s+-i/);
  assert.doesNotMatch(wrapper, /UPDATE_TTL/);
  assert.doesNotMatch(wrapper, /upgrade-last-run/);
  assert.doesNotMatch(wrapper, /date \+%s/);
  assert.doesNotMatch(wrapper, /stat -c/);
});

test('wrapper executes an already-pinned tool without credential leakage', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binks-review-test-'));
  const outPath = nixBuildOutPath(isolatedPackageBuildExpr(tempDir));
  const executable = path.join(outPath, 'bin', 'binks-review');
  const toolBinDir = path.join(tempDir, '.local', 'share', 'binks-review', 'bin');
  const probeLog = path.join(tempDir, 'probe.log');
  fs.mkdirSync(toolBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolBinDir, 'binks-pr-review'),
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf 'uv_extra=%s uv_config=%s uv_find=%s uv_index=%s uv_default=%s uv_named=%s binks_password=%s binks_user=%s binks_key=%s opencode=%s openai=%s anthropic=%s anthropic_auth=%s\\n' \
    "$UV_EXTRA_INDEX_URL" "$UV_CONFIG_FILE" "$UV_FIND_LINKS" "$UV_INDEX" "$UV_DEFAULT_INDEX" "$UV_INDEX_OTHER_PASSWORD" \
    "$BINKS_API_PASSWORD" "$BINKS_API_USER" "$BINKS_AI_PROXY_KEY" "$OPENCODE_API_KEY" \
    "$OPENAI_API_KEY" "$ANTHROPIC_API_KEY" "$ANTHROPIC_AUTH_TOKEN" > "$BINKS_FAKE_PROBE_LOG"
  printf '%s\\n' 'binks-pr-review 0.13.3'
  exit 0
fi
printf 'args:'
printf ' <%s>' "$@"
printf '\\nproxy=%s user=%s password=%s uv_extra=%s base_url=%s\\n' "$BINKS_AI_PROXY_KEY" "$BINKS_API_USER" "$BINKS_API_PASSWORD" "$UV_EXTRA_INDEX_URL" "$BINKS_BASE_URL"
`,
    { mode: 0o755 },
  );

  const result = childProcess.spawnSync(
    executable,
    ['--provider', 'local', '--base', 'origin/main'],
    {
      cwd: tempDir,
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: process.env.PATH,
        OPENCODE_API_KEY: 'proxy-from-opencode',
        UV_EXTRA_INDEX_URL: 'https://token:cloudsmith-secret@example.invalid/simple',
        UV_CONFIG_FILE: '/tmp/attacker-uv.toml',
        UV_FIND_LINKS: '/tmp/attacker-wheels',
        UV_INDEX: 'https://token:uv-index-secret@example.invalid/simple',
        UV_DEFAULT_INDEX: 'https://token:uv-default-secret@example.invalid/simple',
        UV_INDEX_OTHER_PASSWORD: 'uv-named-secret',
        OPENAI_API_KEY: 'openai-secret',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-secret',
        BINKS_API_USER: 'inherited-user',
        BINKS_API_PASSWORD: 'upload-password',
        BINKS_BASE_URL: 'https://attacker.invalid',
        BINKS_FAKE_PROBE_LOG: probeLog,
      },
      timeout: NIX_COMMAND_TIMEOUT_MS,
    },
  );

  const probeEnvironment = fs.readFileSync(probeLog, 'utf8');
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /args: <--provider> <local> <--base> <origin\/main>/);
  assert.match(result.stdout, /proxy=proxy-from-opencode/);
  assert.match(result.stdout, /user= password= uv_extra= base_url=https:\/\/binks\.shopify\.io/);
  assert.doesNotMatch(result.stdout, /secret|upload-password|inherited-user/);
  assert.doesNotMatch(result.stdout, /attacker\.invalid/);
  assert.doesNotMatch(result.stderr, /Cloudsmith index not configured/);
  assert.equal(probeEnvironment.trim(), 'uv_extra= uv_config= uv_find= uv_index= uv_default= uv_named= binks_password= binks_user= binks_key= opencode= openai= anthropic= anthropic_auth=');
});

test('wrapper preserves upload credentials only after explicit authorization', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binks-review-upload-test-'));
  const outPath = nixBuildOutPath(isolatedPackageBuildExpr(tempDir));
  const executable = path.join(outPath, 'bin', 'binks-review');
  const toolBinDir = path.join(tempDir, '.local', 'share', 'binks-review', 'bin');
  fs.mkdirSync(toolBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolBinDir, 'binks-pr-review'),
    `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  if [ -n "$UV_EXTRA_INDEX_URL$UV_CONFIG_FILE$UV_FIND_LINKS$UV_INDEX$UV_DEFAULT_INDEX$UV_INDEX_OTHER_PASSWORD$UV_INDEX_CLOUDSMITH_PASSWORD$UV_INDEX_CLOUDSMITH_USERNAME$BINKS_API_PASSWORD$BINKS_API_USER$BINKS_AI_PROXY_KEY$OPENCODE_API_KEY$OPENAI_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then
    printf '%s\\n' 'credential leaked into version probe' >&2
    exit 9
  fi
  printf '%s\\n' 'binks-pr-review 0.13.3'
  exit 0
fi
printf 'user=%s password=%s base_url=%s\\n' "$BINKS_API_USER" "$BINKS_API_PASSWORD" "$BINKS_BASE_URL"
`,
    { mode: 0o755 },
  );

  const result = childProcess.spawnSync(executable, ['--provider', 'local'], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: process.env.PATH,
      BINKS_AI_PROXY_KEY: 'proxy-key',
      BINKS_REVIEW_UPLOAD: '1',
      BINKS_API_PASSWORD: 'upload-password',
      BINKS_BASE_URL: 'https://attacker.invalid',
    },
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(result.stdout, /user=binks-api-upload-prod password=upload-password base_url=https:\/\/binks\.shopify\.io/);
  assert.doesNotMatch(result.stdout, /attacker\.invalid/);
});

test('wrapper reconciles a mismatched tool once and clears the index credential', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binks-review-reconcile-test-'));
  const outPath = nixBuildOutPath(isolatedPackageBuildExpr(tempDir, { fakeUv: true }));
  const executable = path.join(outPath, 'bin', 'binks-review');
  const toolBinDir = path.join(tempDir, '.local', 'share', 'binks-review', 'bin');
  const uvLog = path.join(tempDir, 'uv-install.log');
  fs.mkdirSync(toolBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolBinDir, 'binks-pr-review'),
    `#!/bin/sh
  if [ -n "$UV_EXTRA_INDEX_URL$UV_CONFIG_FILE$UV_FIND_LINKS$UV_INDEX$UV_DEFAULT_INDEX$UV_INDEX_OTHER_PASSWORD$UV_INDEX_CLOUDSMITH_PASSWORD$UV_INDEX_CLOUDSMITH_USERNAME$BINKS_API_PASSWORD$BINKS_API_USER$BINKS_AI_PROXY_KEY$OPENCODE_API_KEY$OPENAI_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then
  printf '%s\\n' 'credential leaked into version probe' >&2
  exit 9
fi
printf '%s\\n' 'binks-pr-review 0.12.0'
`,
    { mode: 0o755 },
  );

  const result = childProcess.spawnSync(executable, ['--provider', 'local'], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: `/tmp/attacker-bin:${process.env.PATH}`,
      BINKS_AI_PROXY_KEY: 'proxy-key',
      UV_EXTRA_INDEX_URL: 'https://token:attacker@example.invalid/simple',
      UV_CONFIG_FILE: '/tmp/attacker-uv.toml',
      UV_FIND_LINKS: '/tmp/attacker-wheels',
      UV_INDEX_CLOUDSMITH_USERNAME: 'token',
      UV_INDEX_CLOUDSMITH_PASSWORD: 'cloudsmith-secret',
    },
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });

  const [uvInvocation, uvIndex, uvPath] = fs.readFileSync(uvLog, 'utf8').trim().split('\n');
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  assert.match(uvInvocation, /^tool install --quiet --upgrade --python \/nix\/store\/[^/]+\/bin\/python3 binks-pr-review==0\.13\.3$/);
  assert.equal(uvIndex, 'https://token:cloudsmith-secret@pkgs.shopify.io/basic/data/python/simple/');
  assert.doesNotMatch(uvIndex, /example\.invalid/);
  for (const entry of uvPath.split(':')) {
    assert.match(entry, /^\/nix\/store\/[^/]+\/bin$/);
  }
  assert.doesNotMatch(uvPath, /attacker/);
  assert.match(result.stdout, /args: <--provider> <local>/);
  assert.match(result.stdout, /uv_extra= base_url=https:\/\/binks\.shopify\.io$/m);
  assert.doesNotMatch(result.stdout, /cloudsmith-secret/);
});

test('wrapper refuses reconciliation from an OpenCode session', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binks-review-sandbox-test-'));
  const outPath = nixBuildOutPath(isolatedPackageBuildExpr(tempDir, { fakeUv: true }));
  const executable = path.join(outPath, 'bin', 'binks-review');
  const toolBinDir = path.join(tempDir, '.local', 'share', 'binks-review', 'bin');
  const uvLog = path.join(tempDir, 'uv-install.log');
  fs.mkdirSync(toolBinDir, { recursive: true });
  fs.writeFileSync(
    path.join(toolBinDir, 'binks-pr-review'),
    `#!/bin/sh
if [ -n "$UV_EXTRA_INDEX_URL$UV_CONFIG_FILE$UV_FIND_LINKS$UV_INDEX$UV_DEFAULT_INDEX$UV_INDEX_OTHER_PASSWORD$UV_INDEX_CLOUDSMITH_PASSWORD$UV_INDEX_CLOUDSMITH_USERNAME$BINKS_API_PASSWORD$BINKS_API_USER$BINKS_AI_PROXY_KEY$OPENCODE_API_KEY$OPENAI_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN" ]; then
  printf '%s\\n' 'credential leaked into version probe' >&2
  exit 9
fi
printf '%s\\n' 'binks-pr-review 0.12.0'
`,
    { mode: 0o755 },
  );

  const result = childProcess.spawnSync(executable, ['--version'], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: process.env.PATH,
      OPENCODE_SESSION_ID: 'test-session',
      BINKS_AI_PROXY_KEY: 'proxy-key',
    },
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });

  const installAttempted = fs.existsSync(uvLog);
  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Run binks-review --version once from a normal host shell/);
  assert.equal(installAttempted, false);
});

test('Shopify alone renders the package, explicit command, and new OpenCode skill', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  assert.equal(rendered.personal.packagePaths.length, 0);
  assert.equal(rendered.personal.commandText, null);
  assert.equal(rendered.personal.skillPresent, false);
  assert.equal(rendered.personal.stateActivation, null);
  assert.deepEqual(rendered.personal.binksXdgFiles, []);

  assert.equal(rendered.shopify.packagePaths.length, 1);
  assert.match(rendered.shopify.packagePaths[0], /-binks-review$/);
  assert.equal(rendered.shopify.commandNames.includes('binks-review'), true);
  assert.match(rendered.shopify.commandText, /Load the `binks-pr-review` skill/);
  assert.match(rendered.shopify.commandText, /\$ARGUMENTS/);
  assert.equal(rendered.shopify.skillPresent, true);
  assert.match(rendered.shopify.skillText, /^---\nname: binks-pr-review\n/);
  assert.match(rendered.shopify.skillText, /performs no hourly or periodic update/);
  assert.match(rendered.shopify.skillText, /--provider local/);
  assert.match(rendered.shopify.skillText, /Review authorization does not authorize edits or result upload/);
  assert.match(rendered.shopify.skillText, /BINKS_REVIEW_UPLOAD=1/);
  assert.match(rendered.shopify.stateActivation, /install -d -m 0700/);
  assert.match(rendered.shopify.stateActivation, /\.local\/share\/binks-review/);
  includesAll(rendered.shopify.binksXdgFiles, [
    'opencode/agents/binks-overrider.md',
    'opencode/commands/binks-review.md',
    'opencode/skills/binks-pr-review',
  ]);
  assert.equal(rendered.shopify.agentNames.includes('binks-pr-review'), false);
  assert.equal(rendered.shopify.agentNames.includes('binks-overrider'), true);
  assert.equal(rendered.shopify.skillNames.includes('opencode/skills/binks-pr-review'), true);
  assert.deepEqual(rendered.shopify.piBinksFiles, []);
});

test('OpenCode receives read-only Binks state and preserves credential denials', () => {
  const { personal, shopify } = nixEvalJson(hostRenderExpr());
  const binksStatePath = '$HOME/.local/share/binks-review';

  for (const profile of ['managed', 'audit']) {
    const allow = shopify.sandbox[`${profile}Allow`];
    const read = shopify.sandbox[`${profile}Read`];
    const readFile = shopify.sandbox[`${profile}ReadFile`];
    const deny = shopify.sandbox[`${profile}Deny`];
    const allowVars = shopify.sandbox[`${profile}AllowVars`];

    assert.equal(read.includes(binksStatePath), true);
    assert.equal(allow.includes(binksStatePath), false);
    assert.equal(allow.includes('$HOME/.local/share/uv'), false);
    assert.equal(allow.includes('$HOME/.local/bin'), false);
    assert.equal(readFile.includes('$HOME/.config/uv/uv.toml'), false);
    assert.equal(deny.includes('$HOME/.config/gcloud'), true);
    assert.equal(deny.includes('$HOME/.config/uv'), true);
    assert.equal(deny.includes('$HOME/.cache/binks-review'), true);
    assert.equal(allowVars.includes('BINKS_AI_PROXY_KEY'), false);
    assert.equal(allowVars.includes('BINKS_API_PASSWORD'), false);
    assert.equal(allowVars.includes('SHOPIFY_PROXY_KEY'), false);
  }

  for (const profile of ['managed', 'audit']) {
    const allow = personal.sandbox[`${profile}Allow`];
    const read = personal.sandbox[`${profile}Read`];
    const readFile = personal.sandbox[`${profile}ReadFile`];
    assert.equal(allow.includes('$HOME/.local/share/uv'), false);
    assert.equal(read.includes(binksStatePath), false);
    assert.equal(readFile.includes('$HOME/.config/uv/uv.toml'), false);
  }
});
