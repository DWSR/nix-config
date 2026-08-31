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
      renderAgentText = agent:
        if agent == null then null
        else if builtins.isPath agent then builtins.readFile agent
        else agent;
      summarize = host:
        let
          config = flake.darwinConfigurations.\${host}.config.home-manager.users.brandonmcnama;
          files = config.xdg.configFile;
          commands = config.programs.opencode.commands;
          renderedMcp = builtins.fromJSON (builtins.unsafeDiscardStringContext config.xdg.configFile."mcpproxy/mcp_config.json".text);
          mcpServers = builtins.listToAttrs (map (server: { name = server.name; value = server; }) renderedMcp.mcpServers);
          packagePaths = map
            (package: builtins.unsafeDiscardStringContext "\${package}")
            (builtins.filter
              (package: (builtins.parseDrvName package.name).name == "binks-review")
              config.home.packages);
          commandPath = commands."binks-review" or null;
          commandText = if commandPath == null then null else builtins.readFile commandPath;
          ybBacklogCommandPath = commands."validate-yb-backlog" or null;
          ybBacklogCommandText = if ybBacklogCommandPath == null then null else builtins.readFile ybBacklogCommandPath;
          skillPresent = builtins.hasAttr "opencode/skills/binks-pr-review" files;
          skillSource = if skillPresent then files."opencode/skills/binks-pr-review".source else null;
          skillText = if skillPresent then builtins.readFile (skillSource + "/SKILL.md") else null;
          ybValidationSkillPresent = builtins.hasAttr "opencode/skills/validate-yb-issue" files;
          ybValidationSkillSource = if ybValidationSkillPresent then files."opencode/skills/validate-yb-issue".source else null;
          ybValidationSkillText = if ybValidationSkillPresent then builtins.readFile (ybValidationSkillSource + "/SKILL.md") else null;
          binksReviewer = config.programs.opencode.agents."binks-reviewer" or null;
          binksReviewerText = renderAgentText binksReviewer;
          ybBacklogValidator = config.programs.opencode.agents."yb-backlog-validator" or null;
          ybBacklogValidatorText = renderAgentText ybBacklogValidator;
          ybIssueValidator = config.programs.opencode.agents."yb-issue-validator" or null;
          ybIssueValidatorText = renderAgentText ybIssueValidator;
          ybBacklogMcp = mcpServers."yugabyte-gh-issue-backlog-review" or null;
          kiroReviewSource = files."opencode/skills/kiro-review".source;
          kiroVerifySource = files."opencode/skills/kiro-verify-completion".source;
          kiroImplSource = files."opencode/skills/kiro-impl".source;
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
          inherit packagePaths commandText ybBacklogCommandText skillPresent skillText ybValidationSkillPresent ybValidationSkillText binksReviewerText ybBacklogValidatorText ybIssueValidatorText ybBacklogMcp stateActivation binksXdgFiles piBinksFiles;
          skillsPackagePath = builtins.unsafeDiscardStringContext "\${config.programs.cc-sdd.skillsPackage}";
          kiroReviewText = builtins.readFile (kiroReviewSource + "/SKILL.md");
          kiroVerifyText = builtins.readFile (kiroVerifySource + "/SKILL.md");
          kiroImplText = builtins.readFile (kiroImplSource + "/SKILL.md");
          kiroReviewerPromptText = builtins.readFile (kiroImplSource + "/templates/reviewer-prompt.md");
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

test('repository eligibility accepts only Shopify and shop organizations on github.com', {
  skip: !canExecuteShopifyPackage,
}, () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'binks-review-eligibility-test-'));
  const outPath = nixBuildOutPath(isolatedPackageBuildExpr(tempDir));
  const executable = path.join(outPath, 'bin', 'binks-review');

  function check(remoteUrl, { extraConfig = '', extraEnv = {}, worktreeConfig = null } = {}) {
    const repository = fs.mkdtempSync(path.join(tempDir, 'repo-'));
    const escapedRemoteUrl = remoteUrl.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    fs.mkdirSync(path.join(repository, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(repository, '.git', 'refs', 'heads'), { recursive: true });
    fs.writeFileSync(path.join(repository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(
      path.join(repository, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n\tbare = false\n[remote "origin"]\n\turl = "${escapedRemoteUrl}"\n${extraConfig}`,
    );
    if (worktreeConfig !== null) {
      fs.writeFileSync(path.join(repository, '.git', 'config.worktree'), worktreeConfig);
    }
    return childProcess.spawnSync(executable, ['--check-repository-eligibility'], {
      cwd: repository,
      encoding: 'utf8',
      env: {
        HOME: tempDir,
        PATH: process.env.PATH,
        ...extraEnv,
      },
      timeout: NIX_COMMAND_TIMEOUT_MS,
    });
  }

  for (const remoteUrl of [
    'https://github.com/Shopify/shopify.git',
    'git@github.com:shop/shopify.git',
    'ssh://git@github.com/ShOpIfY/example.git',
  ]) {
    const result = check(remoteUrl);
    assert.equal(result.status, 0, `${remoteUrl}: ${result.stderr}`);
    assert.match(result.stdout, /^ELIGIBLE: github\.com\/(Shopify|shop|ShOpIfY)\//);
  }

  for (const remoteUrl of [
    'https://github.com/DWSR/nix-config.git',
    'https://gitlab.com/Shopify/example.git',
    'git@github.example.com:Shopify/example.git',
    'https://user:credential-secret@github.com/Shopify/example.git',
    'https://github.com/Shopify/example.git?access_token=credential-secret',
    'https://github.com/Shopify/example.git#credential-secret',
    'https://github.com/Shopify/.',
    'git@github.com:shop/..',
    'ssh://git@github.com/Shopify/.',
    'https://github.com/Shopify',
    'https://github.com/Shopify/example/extra.git',
    'https://github.com/Shopifyevil/example.git',
  ]) {
    const result = check(remoteUrl);
    assert.equal(result.status, 1, `${remoteUrl}: ${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /^INELIGIBLE:/);
    assert.equal(result.stderr.includes(remoteUrl), false);
    assert.doesNotMatch(result.stderr, /credential-secret/);
  }

  const environmentSpoof = check('https://github.com/DWSR/nix-config.git', {
    extraEnv: {
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.url',
      GIT_CONFIG_VALUE_0: 'https://github.com/Shopify/spoofed.git',
      GIT_CONFIG_GLOBAL: '/tmp/attacker-gitconfig',
    },
  });
  assert.equal(environmentSpoof.status, 1);
  assert.match(environmentSpoof.stderr, /organization is not Shopify or shop/);

  const localRewrite = check('https://github.com/Shopify/example.git', {
    extraConfig: '[url "https://gitlab.com/Shopify/"]\n\tinsteadOf = https://github.com/Shopify/\n',
  });
  assert.equal(localRewrite.status, 1);
  assert.match(localRewrite.stderr, /local Git includes or URL rewrite rules are present/);

  const localInclude = check('https://github.com/Shopify/example.git', {
    extraConfig: '[include]\n\tpath = /tmp/attacker-gitconfig\n',
  });
  assert.equal(localInclude.status, 1);
  assert.match(localInclude.stderr, /local Git includes or URL rewrite rules are present/);

  const duplicateOrigin = check('https://github.com/Shopify/example.git', {
    extraConfig: '[remote "origin"]\n\turl = https://gitlab.com/Shopify/example.git\n',
  });
  assert.equal(duplicateOrigin.status, 1);
  assert.match(duplicateOrigin.stderr, /remote\.origin\.url is missing or ambiguous/);

  const worktreeOverride = check('https://github.com/Shopify/example.git', {
    extraConfig: '[extensions]\n\tworktreeConfig = true\n',
    worktreeConfig: '[remote "origin"]\n\turl = https://gitlab.com/Shopify/example.git\n',
  });
  assert.equal(worktreeOverride.status, 1);
  assert.match(worktreeOverride.stderr, /remote\.origin\.url is missing or ambiguous/);

  const noOriginRepository = fs.mkdtempSync(path.join(tempDir, 'repo-no-origin-'));
  fs.mkdirSync(path.join(noOriginRepository, '.git', 'objects'), { recursive: true });
  fs.mkdirSync(path.join(noOriginRepository, '.git', 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(noOriginRepository, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(noOriginRepository, '.git', 'config'), '[core]\n\tbare = false\n');
  const noOrigin = childProcess.spawnSync(executable, ['--check-repository-eligibility'], {
    cwd: noOriginRepository,
    encoding: 'utf8',
    env: { HOME: tempDir, PATH: process.env.PATH },
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(noOrigin.status, 1);
  assert.match(noOrigin.stderr, /remote\.origin\.url is missing/);
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
printf 'args:'
printf ' <%s>' "$@"
printf '\\nuser=%s password=%s base_url=%s\\n' "$BINKS_API_USER" "$BINKS_API_PASSWORD" "$BINKS_BASE_URL"
`,
    { mode: 0o755 },
  );

  const uploadResult = childProcess.spawnSync(executable, ['--provider', 'local'], {
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

  const localOnlyResult = childProcess.spawnSync(executable, ['--no-upload', '--provider', 'local'], {
    cwd: tempDir,
    encoding: 'utf8',
    env: {
      HOME: tempDir,
      PATH: process.env.PATH,
      BINKS_AI_PROXY_KEY: 'proxy-key',
      BINKS_REVIEW_UPLOAD: '1',
      BINKS_API_USER: 'inherited-user',
      BINKS_API_PASSWORD: 'upload-password',
    },
    timeout: NIX_COMMAND_TIMEOUT_MS,
  });

  fs.rmSync(tempDir, { recursive: true, force: true });
  assert.equal(uploadResult.status, 0, `${uploadResult.stderr}\n${uploadResult.stdout}`);
  assert.match(uploadResult.stdout, /args: <--provider> <local>/);
  assert.match(uploadResult.stdout, /user=binks-api-upload-prod password=upload-password base_url=https:\/\/binks\.shopify\.io/);
  assert.doesNotMatch(uploadResult.stdout, /attacker\.invalid/);
  assert.equal(localOnlyResult.status, 0, `${localOnlyResult.stderr}\n${localOnlyResult.stdout}`);
  assert.match(localOnlyResult.stdout, /args: <--provider> <local>/);
  assert.doesNotMatch(localOnlyResult.stdout, /--no-upload/);
  assert.match(localOnlyResult.stdout, /user= password= base_url=https:\/\/binks\.shopify\.io/);
  assert.doesNotMatch(localOnlyResult.stdout, /upload-password|inherited-user/);
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

test('Shopify alone renders Binks and its Kiro review integration', () => {
  const rendered = nixEvalJson(hostRenderExpr());

  assert.equal(rendered.personal.packagePaths.length, 0);
  assert.equal(rendered.personal.commandText, null);
  assert.equal(rendered.personal.ybBacklogCommandText, null);
  assert.equal(rendered.personal.skillPresent, false);
  assert.equal(rendered.personal.ybValidationSkillPresent, false);
  assert.equal(rendered.personal.stateActivation, null);
  assert.deepEqual(rendered.personal.binksXdgFiles, []);
  assert.equal(rendered.personal.binksReviewerText, null);
  assert.equal(rendered.personal.ybBacklogValidatorText, null);
  assert.equal(rendered.personal.ybIssueValidatorText, null);
  assert.equal(rendered.personal.ybBacklogMcp, null);
  assert.equal(rendered.personal.agentNames.includes('binks-reviewer'), false);
  assert.equal(rendered.personal.agentNames.includes('yb-backlog-validator'), false);
  assert.doesNotMatch(rendered.personal.kiroReviewText, /binks-reviewer/);
  assert.doesNotMatch(rendered.personal.kiroVerifyText, /binks-reviewer/);
  assert.doesNotMatch(rendered.personal.kiroImplText, /External Review Handoff/);
  assert.doesNotMatch(rendered.personal.kiroReviewerPromptText, /Binks Review/);

  assert.equal(rendered.shopify.packagePaths.length, 1);
  assert.match(rendered.shopify.packagePaths[0], /-binks-review$/);
  assert.equal(rendered.shopify.commandNames.includes('binks-review'), true);
  assert.match(rendered.shopify.commandText, /Load the `binks-pr-review` skill/);
  assert.match(rendered.shopify.commandText, /\$ARGUMENTS/);
  assert.equal(rendered.shopify.commandNames.includes('validate-yb-backlog'), true);
  assert.match(rendered.shopify.ybBacklogCommandText, /agent: yb-backlog-validator/);
  assert.match(rendered.shopify.ybBacklogCommandText, /waves of four until the active unreviewed queue/);
  assert.match(rendered.shopify.ybBacklogCommandText, /uploaded to that\s+issue and verified in Quick/);
  assert.match(rendered.shopify.ybBacklogCommandText, /`2024\.2`, `2025\.1`, `2025\.2`,\s+and `2026\.1`, plus the latest preview corresponding to `master`/);
  assert.match(rendered.shopify.ybBacklogCommandText, /presence is\s+not runtime proof/);
  assert.match(rendered.shopify.ybBacklogCommandText, /OPENCODE_NONO=disabled opencode/);
  assert.match(rendered.shopify.ybBacklogCommandText, /\$ARGUMENTS/);
  assert.equal(rendered.shopify.skillPresent, true);
  assert.equal(rendered.shopify.ybValidationSkillPresent, true);
  assert.match(rendered.shopify.ybValidationSkillText, /Backlog attachment staging \(when requested\)/);
  assert.match(rendered.shopify.ybValidationSkillText, /path\.join\(os\.tmpdir\(\), "opencode"\)/);
  assert.match(rendered.shopify.ybValidationSkillText, /never omit a referenced file/);
  assert.match(rendered.shopify.ybValidationSkillText, /current required targets are `2024\.2`, `2025\.1`, `2025\.2`,\s+`2026\.1`, and `master`/);
  assert.match(rendered.shopify.ybValidationSkillText, /newest published release from each in-support\s+branch/);
  assert.match(rendered.shopify.ybValidationSkillText, /backport commit does not\s+satisfy a cell/);
  assert.match(rendered.shopify.skillText, /^---\nname: binks-pr-review\n/);
  assert.match(rendered.shopify.skillText, /performs no hourly or periodic update/);
  assert.match(rendered.shopify.skillText, /--provider local/);
  assert.match(rendered.shopify.skillText, /Review authorization does not authorize edits or result upload/);
  assert.match(rendered.shopify.skillText, /dispatch from the Shopify-host `kiro-review`/);
  assert.match(rendered.shopify.skillText, /--check-repository-eligibility/);
  assert.match(rendered.shopify.skillText, /wrapper-only `--no-upload` argument/);
  assert.match(rendered.shopify.skillText, /BINKS_REVIEW_UPLOAD=1/);
  assert.match(rendered.shopify.skillsPackagePath, /-cc-sdd-skills-shopify-3\.0\.2$/);
  assert.match(rendered.shopify.binksReviewerText, /mode: subagent/);
  assert.match(rendered.shopify.binksReviewerText, /Load the `binks-pr-review` skill/);
  assert.match(rendered.shopify.binksReviewerText, /exact host is `github\.com`/);
  assert.match(rendered.shopify.binksReviewerText, /binks-review --no-upload/);
  assert.match(rendered.shopify.binksReviewerText, /## External Review Handoff/);
  assert.match(rendered.shopify.binksReviewerText, /WORKTREE_FINGERPRINT/);
  assert.match(rendered.shopify.binksReviewerText, /DISPOSITION: VALID \| FALSE_POSITIVE \| NEEDS_CONTEXT/);
  assert.equal(rendered.shopify.agentNames.includes('yb-backlog-validator'), true);
  assert.equal(rendered.shopify.agentNames.includes('yb-issue-validator'), true);
  assert.match(rendered.shopify.ybIssueValidatorText, /Backlog attachment staging/);
  assert.match(rendered.shopify.ybIssueValidatorText, /every local file referenced by the Quick fields/);
  assert.match(rendered.shopify.ybIssueValidatorText, /Complete support matrix/);
  assert.match(rendered.shopify.ybIssueValidatorText, /A backport commit is provenance, not runtime proof/);
  assert.match(rendered.shopify.ybIssueValidatorText, /resolution time and authoritative freshness evidence/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /mode: all/);
  assert.doesNotMatch(rendered.shopify.ybBacklogValidatorText, /^model:/m);
  assert.match(rendered.shopify.ybBacklogValidatorText, /waves of exactly four/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /blocked_this_run/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /"\*": deny/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /podman info --format json/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /starts with `chrome-devtools:`/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /GitHub comments and pull requests are explicitly prohibited/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /## Backlog Handoff/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Require exactly one `## Backlog Handoff` block/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /require exactly one authoritative record/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /review\.reviewed == true/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Resume the same task ID once/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /dispatch one fresh validator/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /All review writes use the browser form/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Never defer file\s+collection to a later archival pass/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /SUPPORTED_TARGETS: 2024\.2, 2025\.1, 2025\.2, 2026\.1, master/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /If an executable reproduction exists and any required target could\s+not be run, the handoff is not ready/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /presence of a backport\s+commit cannot\s+replace a runtime matrix cell/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /resolve one authoritative `resolved_targets` map/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Re-resolve for the next wave/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /A historical issue or known\s+backport is not a reason to use `N\/A`/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /remains affected and therefore requires a backport/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /must exactly match the controller's `resolved_targets`/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /## Quick Attachments/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Only after every required attachment is authoritatively present/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /whose `original_name` equals the manifest name/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /require exactly one selected `File`/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /crypto\.subtle\.digest\("SHA-256"/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /non-attachment review field to still match the pre-write snapshot/);
  assert.match(rendered.shopify.ybBacklogValidatorText, /Review changes saved\./);
  assert.match(rendered.shopify.ybBacklogValidatorText, /RETRYABLE_NO_GO/);
  assert.equal(rendered.shopify.ybBacklogMcp.name, 'yugabyte-gh-issue-backlog-review');
  assert.equal(rendered.shopify.ybBacklogMcp.protocol, 'stdio');
  assert.equal(rendered.shopify.ybBacklogMcp.enabled, true);
  assert.equal(rendered.shopify.ybBacklogMcp.quarantined, false);
  assert.equal(
    rendered.shopify.ybBacklogMcp.command,
    '/Users/brandonmcnama/.local/state/tec/profiles/base/current/global/bin/quick',
  );
  assert.deepEqual(rendered.shopify.ybBacklogMcp.args, [
    'mcp',
    'yugabyte-gh-issue-backlog-review',
  ]);
  assert.match(rendered.shopify.kiroReviewText, /one local Binks review per task/);
  assert.match(rendered.shopify.kiroReviewText, /BINKS: REUSED/);
  assert.match(rendered.shopify.kiroReviewText, /Never write a marker/);
  assert.match(rendered.shopify.kiroVerifyText, /Every invocation of this Shopify-host skill/);
  assert.match(rendered.shopify.kiroVerifyText, /runs in main\/controller context/);
  assert.match(rendered.shopify.kiroVerifyText, /reuses a handoff from an earlier reviewer/);
  assert.match(rendered.shopify.kiroVerifyText, /every other Git forge/);
  assert.match(rendered.shopify.kiroImplText, /retain its first `## External Review Handoff` in session context/);
  assert.match(rendered.shopify.kiroImplText, /Before spawning the task reviewer/);
  assert.match(rendered.shopify.kiroReviewerPromptText, /parent owns eligibility and dispatch/);
  assert.match(rendered.shopify.kiroReviewerPromptText, /not launch a nested `binks-reviewer`/);
  assert.match(rendered.shopify.stateActivation, /install -d -m 0700/);
  assert.match(rendered.shopify.stateActivation, /\.local\/share\/binks-review/);
  includesAll(rendered.shopify.binksXdgFiles, [
    'opencode/agents/binks-overrider.md',
    'opencode/agents/binks-reviewer.md',
    'opencode/commands/binks-review.md',
    'opencode/skills/binks-pr-review',
  ]);
  assert.equal(rendered.shopify.agentNames.includes('binks-pr-review'), false);
  assert.equal(rendered.shopify.agentNames.includes('binks-overrider'), true);
  assert.equal(rendered.shopify.agentNames.includes('binks-reviewer'), true);
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
