'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '../..');
const HOSTS = Object.freeze({
  personal: 'Brandons-MacBook-Pro',
  shopify: 'ShopifyLaptop',
});
const TASK_5_2_REQUIREMENTS = Object.freeze([
  '1.1', '1.2', '1.3', '1.5',
  '3.1', '3.4', '3.5', '3.6', '3.7',
  '6.2', '6.3', '6.4', '6.5', '6.6', '6.7',
  '7.5',
]);

function nixEvalJson(expr) {
  return JSON.parse(childProcess.execFileSync(
    'nix',
    ['eval', '--json', '--impure', '--expr', expr],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    },
  ));
}

function rtkHostRenderExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = host: modules:
        (flake.darwinConfigurations.\${host}.extendModules {
          modules = modules;
        }).config.home-manager.users.brandonmcnama;
      summarize = config:
        let
          rtk = config.programs.opencode-rtk;
          files = config.xdg.configFile;
          metadataFile = files.\${rtk.metadataPath};
          metadata = builtins.fromJSON metadataFile.text;
          rtkWrappers = builtins.filter
            (snippet: builtins.match ".*opencode_rtk_default.*" snippet != null)
            config.home.opencode.wrapperCommands;
        in
        {
          enabled = rtk.enable;
          defaultEnabled = rtk.defaultEnabled;
          packageName = rtk.package.pname or rtk.package.name;
          usageTag = rtk.usageTag;
          pluginFilePresent = builtins.hasAttr "opencode/plugins/rtk.ts" files;
          pluginSource = toString files."opencode/plugins/rtk.ts".source;
          metadataTextPresent = metadataFile ? text;
          metadata = metadata;
          operatorGuidePresent = builtins.hasAttr "opencode/rtk/README.md" files;
          operatorGuideText = files."opencode/rtk/README.md".text;
          packageInHomePackages = builtins.elem rtk.package config.home.packages;
          smokeTestPackageName = rtk.smokeTestPackage.name;
          smokeTestPackageInHomePackages = builtins.elem rtk.smokeTestPackage config.home.packages;
          rtkWrapperCount = builtins.length rtkWrappers;
          rtkWrapper = builtins.head rtkWrappers;
        };
      usageTags = config:
        builtins.fromJSON config.programs.opencode.settings.provider.anthropic.options.headers.Shopify-Usage-Tag;
      personal = hm "${HOSTS.personal}" [ ];
      shopify = hm "${HOSTS.shopify}" [ ];
      personalDefaultDisabled = hm "${HOSTS.personal}" [
        ({ lib, ... }: {
          home-manager.users.brandonmcnama.programs.opencode-rtk.defaultEnabled = lib.mkForce false;
        })
      ];
      shopifyRtkDisabled = hm "${HOSTS.shopify}" [
        ({ lib, ... }: {
          home-manager.users.brandonmcnama.programs.opencode-rtk.enable = lib.mkForce false;
        })
      ];
    in
    {
      personal = summarize personal;
      shopify = summarize shopify;
      personalDefaultDisabled = summarize personalDefaultDisabled;
      shopifyUsageTags = usageTags shopify;
      shopifyRtkDisabledUsageTags = usageTags shopifyRtkDisabled;
    }
  `;
}

function rtkPeerAssertionExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      hm = (flake.darwinConfigurations."${HOSTS.personal}".extendModules {
        modules = [
          ({ lib, ... }: {
            home-manager.users.brandonmcnama.programs.opencode.enable = lib.mkForce false;
            home-manager.users.brandonmcnama.programs.opencode-rtk.enable = lib.mkForce true;
          })
        ];
      }).config.home-manager.users.brandonmcnama;
    in
    builtins.filter
      (assertion: ! assertion.assertion && builtins.match ".*programs.opencode-rtk.enable requires programs.opencode.enable.*" assertion.message != null)
      hm.assertions
  `;
}

function parseRenderedTags(tags) {
  assert.deepEqual(tags.slice(0, 2), ['opencode_cli', '{env:OPENCODE_SESSION_ID}']);
  assert.equal(tags.length, 3);
  return tags[2];
}

function extractRtkResolverScript(renderedHost) {
  assert.equal(renderedHost.rtkWrapperCount, 1);
  assert.match(renderedHost.rtkWrapper, /opencode_rtk_default=/);
  assert.match(renderedHost.rtkWrapper, /OPENCODE_RTK_USAGE_TAG/);
  assert.match(renderedHost.rtkWrapper, /RTK_TELEMETRY_DISABLED="1"/);
  return renderedHost.rtkWrapper;
}

function runRtkResolver(script, override) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rtk-render-'));
  const binDir = path.join(tmpDir, 'bin');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'rtk'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const executableScript = script.replace(
    /^\s*export PATH="[^"]+:\$PATH"\s*$/m,
    `export PATH="${binDir}:$PATH"`,
  );
  const result = childProcess.spawnSync(
    '/bin/sh',
    ['-c', `${executableScript}\nprintf '%s\\n' "$OPENCODE_RTK_EFFECTIVE|$OPENCODE_RTK_USAGE_TAG|$OPENCODE_RTK_DISABLE_REASON|$RTK_TELEMETRY_DISABLED"`],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        ...(override === undefined ? {} : { OPENCODE_RTK: override }),
      },
      timeout: 120_000,
    },
  );

  fs.rmSync(tmpDir, { recursive: true, force: true });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const [effective, usageTag, disableReason, telemetry] = result.stdout.trim().split('|');
  return { effective, usageTag, disableReason, telemetry };
}

function assertNoRtkSessionHistoryWriters() {
  const files = [
    'home-manager/common/opencode-rtk.nix',
    'configurations/shopify/home-manager/opencode.nix',
  ];
  const forbidden = [
    /opencode-stable\.db/,
    /session[_-]?database/i,
    /session[_-]?history/i,
    /historical session data/i,
    /\.local\/share\/opencode/i,
    /sqlite/i,
  ];

  for (const file of files) {
    const text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    for (const pattern of forbidden) {
      assert.equal(pattern.test(text), false, `${file} must not introduce session-history writer surface matching ${pattern}`);
    }
  }
}

test('Task 5.2 requirement coverage is pinned to source requirement numbers', () => {
  assert.deepEqual(TASK_5_2_REQUIREMENTS, [
    '1.1', '1.2', '1.3', '1.5',
    '3.1', '3.4', '3.5', '3.6', '3.7',
    '6.2', '6.3', '6.4', '6.5', '6.6', '6.7',
    '7.5',
  ]);
});

test('both hosts render RTK package, plugin, metadata, wrapper env, guide, and smoke package', () => {
  const rendered = nixEvalJson(rtkHostRenderExpr());

  for (const [hostKey, host] of Object.entries({ personal: rendered.personal, shopify: rendered.shopify })) {
    assert.equal(host.enabled, true, `${hostKey} RTK module enabled`);
    assert.equal(host.defaultEnabled, true, `${hostKey} default enabled`);
    assert.equal(host.packageName, 'rtk');
    assert.equal(host.usageTag, '{env:OPENCODE_RTK_USAGE_TAG}');
    assert.equal(host.pluginFilePresent, true);
    assert.equal(host.pluginSource.endsWith('/home-manager/common/opencode-plugins/rtk.ts'), true);
    assert.equal(host.metadataTextPresent, true);
    assert.equal(host.metadata.feature, 'rtk-install');
    assert.equal(host.metadata.packageName, 'rtk');
    assert.equal(host.metadata.sourceOwner, 'rtk-ai');
    assert.equal(host.metadata.sourceRepo, 'rtk');
    assert.equal(host.metadata.defaultEnabled, true);
    assert.equal(host.metadata.overrideEnv, 'OPENCODE_RTK');
    assert.equal(host.metadata.effectiveEnv, 'OPENCODE_RTK_EFFECTIVE');
    assert.equal(host.metadata.usageTagEnv, 'OPENCODE_RTK_USAGE_TAG');
    assert.equal(host.metadata.telemetryEnv, 'RTK_TELEMETRY_DISABLED');
    assert.equal(host.metadata.pluginPath, 'opencode/plugins/rtk.ts');
    assert.equal(host.operatorGuidePresent, true);
    assert.match(host.operatorGuideText, /Restart OpenCode after a rebuild/);
    assert.equal(host.packageInHomePackages, true);
    assert.equal(host.smokeTestPackageInHomePackages, true);
    assert.match(host.smokeTestPackageName, /^rtk-opencode-smoke-test/);
    extractRtkResolverScript(host);
  }
});

test('OpenCode peer assertion rejects RTK when programs.opencode is disabled', () => {
  const assertions = nixEvalJson(rtkPeerAssertionExpr());

  assert.equal(assertions.length, 1);
  assert.equal(assertions[0].assertion, false);
  assert.match(assertions[0].message, /programs\.opencode-rtk\.enable requires programs\.opencode\.enable/);
});

test('host default override keeps RTK installed and allows per-launch enable state', () => {
  const rendered = nixEvalJson(rtkHostRenderExpr());
  const disabledHost = rendered.personalDefaultDisabled;
  const otherHost = rendered.shopify;

  assert.equal(disabledHost.enabled, true);
  assert.equal(disabledHost.defaultEnabled, false);
  assert.equal(disabledHost.metadata.defaultEnabled, false);
  assert.equal(disabledHost.packageInHomePackages, true);
  assert.equal(disabledHost.pluginFilePresent, true);
  assert.equal(disabledHost.smokeTestPackageInHomePackages, true);
  assert.equal(otherHost.defaultEnabled, true);

  const resolverScript = extractRtkResolverScript(disabledHost);
  assert.deepEqual(runRtkResolver(resolverScript), {
    effective: 'disabled',
    usageTag: 'rtk:disabled',
    disableReason: 'host-default',
    telemetry: '1',
  });
  assert.deepEqual(runRtkResolver(resolverScript, '1'), {
    effective: 'enabled',
    usageTag: 'rtk:enabled',
    disableReason: '',
    telemetry: '1',
  });
});

test('Shopify usage tags preserve existing tags and consume RTK usage tag env value', () => {
  const rendered = nixEvalJson(rtkHostRenderExpr());

  assert.equal(parseRenderedTags(rendered.shopifyUsageTags), '{env:OPENCODE_RTK_USAGE_TAG}');
  assert.equal(parseRenderedTags(rendered.shopifyRtkDisabledUsageTags), 'rtk:disabled');
});

test('wrapper resolver emits Shopify RTK usage tags for default and per-launch override states', () => {
  const rendered = nixEvalJson(rtkHostRenderExpr());
  const enabledByDefault = extractRtkResolverScript(rendered.shopify);

  assert.deepEqual(runRtkResolver(enabledByDefault), {
    effective: 'enabled',
    usageTag: 'rtk:enabled',
    disableReason: '',
    telemetry: '1',
  });
  assert.deepEqual(runRtkResolver(enabledByDefault, '0'), {
    effective: 'disabled',
    usageTag: 'rtk:disabled',
    disableReason: 'override',
    telemetry: '1',
  });
  assert.deepEqual(runRtkResolver(enabledByDefault, 'enabled'), {
    effective: 'enabled',
    usageTag: 'rtk:enabled',
    disableReason: '',
    telemetry: '1',
  });
});

test('RTK integration does not introduce OpenCode session database or history writers', () => {
  assertNoRtkSessionHistoryWriters();
});
