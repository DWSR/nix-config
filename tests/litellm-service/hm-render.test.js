'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { nixEvalFailure, nixEvalJson, repoRoot } = require('./helpers');

const litellmModulePath = `${repoRoot}/home-manager/common/litellm.nix`;

function standaloneLitellmExpr(extraModules = []) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs {
        system = builtins.currentSystem;
        overlays = [ flake.overlays.fixed-packages ];
      };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${litellmModulePath}
          ({ ... }: {
            home.username = "litellm-test";
            home.homeDirectory = "/Users/litellm-test";
            home.stateVersion = "26.05";
          })
          ${extraModules.map((extra) => `(${extra})`).join('\n          ')}
        ];
      };
    in
    {
      hasAgent = hm.config.launchd.agents ? litellm;
      agent =
        if hm.config.launchd.agents ? litellm then
          hm.config.launchd.agents.litellm
        else
          null;
      activation =
        if hm.config.home.activation ? litellmState then
          hm.config.home.activation.litellmState
        else
          null;
      hasConfigFile = hm.config.xdg.configFile ? "litellm/config.yaml";
      wrapperText =
        if hm.config.programs.litellm._wrapper != null then
          builtins.readFile (
            hm.config.programs.litellm._wrapper + "/bin/litellm-launchd-wrapper"
          )
        else
          null;
      settingsText =
        if hm.config.programs.litellm._settingsFile != null then
          builtins.readFile hm.config.programs.litellm._settingsFile
        else
          null;
    }
  `;
}

// Minimal stand-in for the home-manager/mcp module so standalone evals can
// exercise the keychainSecrets cross-references the same way hosts do.
const fakeMcpModule = `
  { lib, ... }: {
    options.home.mcp = {
      keychainSecrets = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
      };
    };
  }
`;

const minimalSettings = `{ ... }: {
  programs.litellm.enable = true;
  programs.litellm.settings.model_list = [
    { model_name = "chatgpt/gpt-5.4";
      model_info.mode = "responses";
      litellm_params.model = "chatgpt/gpt-5.4";
    }
  ];
}`;

test('helper evaluates repository expressions without host side effects', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
    in
    {
      hasDarwinConfigurations = flake ? darwinConfigurations;
      hasPersonalHost = flake.darwinConfigurations ? "Brandons-MacBook-Pro";
    }
  `);

  assert.equal(rendered.hasDarwinConfigurations, true);
  assert.equal(rendered.hasPersonalHost, true);
});

test('default configuration registers the launchd agent on litellm defaults', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([minimalSettings]));

  assert.equal(rendered.hasAgent, true);
  assert.equal(rendered.agent.enable, true);

  const { config } = rendered.agent;
  assert.equal(config.Label, 'dev.dwsr.litellm');
  assert.match(config.ProgramArguments[0], /\/bin\/litellm-launchd-wrapper$/);
  assert.deepEqual(config.ProgramArguments.slice(1), []);
  assert.equal(config.RunAtLoad, true);
  assert.equal(config.KeepAlive, true);

  assert.equal(config.EnvironmentVariables.LITELLM_NON_ROOT, 'true');
  assert.equal(
    config.EnvironmentVariables.LITELLM_UI_PATH,
    '/Users/litellm-test/.local/state/litellm/ui',
  );
  assert.equal(
    config.EnvironmentVariables.CUSTOM_TIKTOKEN_CACHE_DIR,
    '/Users/litellm-test/.local/state/litellm/tiktoken-cache',
  );
  assert.equal(config.EnvironmentVariables.LITELLM_DONT_SHOW_FEEDBACK_BOX, 'true');
  assert.equal(config.EnvironmentVariables.DO_NOT_TRACK, '1');
  // The master key is exported by the wrapper from the Keychain, not by
  // launchd — it must never land in the world-readable agent plist.
  assert.equal(config.EnvironmentVariables.LITELLM_MASTER_KEY, undefined);

  const pathComponents = config.EnvironmentVariables.PATH.split(':');
  assert.equal(pathComponents.length, 6);
  assert.match(pathComponents[0], /.*home-manager-path.*\/bin$/);
  assert.deepStrictEqual(pathComponents.slice(-5), [
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ]);

  assert.equal(config.StandardOutPath, '/Users/litellm-test/Library/Logs/litellm/litellm.log');
  assert.equal(
    config.StandardErrorPath,
    '/Users/litellm-test/Library/Logs/litellm/litellm.error.log',
  );
});

test('wrapper resolves the master key and invokes litellm with the managed config', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([minimalSettings]));

  const wrapper = rendered.wrapperText;
  assert.ok(wrapper, 'expected programs.litellm._wrapper to render');

  assert.match(wrapper, /-s mcpproxy -a litellm-master-key/);
  assert.match(wrapper, /export LITELLM_MASTER_KEY\b/);
  // The empty-read guard must reference the actual env var.
  assert.match(wrapper, /\[ -z "\$\{LITELLM_MASTER_KEY:-\}" \]/);
  // A missing master key aborts before the proxy starts (it must never run
  // unauthenticated).
  assert.match(wrapper, /exit 1/);

  // escapeShellArgs leaves plain identifiers unquoted.
  assert.match(
    wrapper,
    /exec .*\/bin\/litellm --config \/Users\/litellm-test\/\.config\/litellm\/config\.yaml --host 127\.0\.0\.1 --port 4000/,
  );
  // No providerKeys declared -> no provider keychain reads.
  assert.equal(wrapper.includes('OPENCODE_API_KEY'), false);
});

test('wrapper exports providerKeys from the keychain with warn-not-fail semantics', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([
    fakeMcpModule,
    `{ ... }: {
      home.mcp.keychainSecrets = {
        "litellm-master-key" = "x";
        "opencode-api-key" = "x";
      };
      programs.litellm.enable = true;
      programs.litellm.settings.model_list = [
        {
          model_name = "opencode-go/glm-5.3-flash";
          litellm_params.model = "openai/glm-5.3-flash";
        }
      ];
      programs.litellm.providerKeys.OPENCODE_API_KEY = "opencode-api-key";
    }`,
  ]));

  const wrapper = rendered.wrapperText;
  assert.match(
    wrapper,
    /OPENCODE_API_KEY="\$\(\/usr\/bin\/security find-generic-password -s mcpproxy -a opencode-api-key/,
  );
  assert.match(wrapper, /export OPENCODE_API_KEY/);
  assert.match(wrapper, /WARNING: opencode-api-key unavailable/);
  // Provider-key failure is a warning (the affected deployment fails
  // per-request); only the master key guard exits nonzero.
  assert.equal((wrapper.match(/WARNING:/g) ?? []).length, 1);
  assert.equal((wrapper.match(/exit 1/g) ?? []).length, 1);
});

test('masterKeyReference = null runs the proxy without auth plumbing', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([
    `{ ... }: {
      programs.litellm.enable = true;
      programs.litellm.masterKeyReference = null;
      programs.litellm.settings.model_list = [
        { model_name = "m"; litellm_params.model = "openai/m"; }
      ];
    }`,
  ]));

  assert.equal(rendered.wrapperText.includes('LITELLM_MASTER_KEY'), false);
});

test('custom host, port, and extraArgs reach the wrapper exec line', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([
    `{ ... }: {
      programs.litellm.enable = true;
      programs.litellm.host = "127.0.0.1";
      programs.litellm.port = 4777;
      programs.litellm.extraArgs = [ "--detailed_debug" ];
      programs.litellm.settings.model_list = [
        { model_name = "m"; litellm_params.model = "openai/m"; }
      ];
    }`,
  ]));

  assert.match(
    rendered.wrapperText,
    /--host 127\.0\.0\.1 --port 4777 --detailed_debug/,
  );
});

test('settings render as YAML at the managed config path', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([
    `{ ... }: {
      programs.litellm.enable = true;
      programs.litellm.settings = {
        model_list = [
          {
            model_name = "chatgpt/gpt-5.4";
            model_info.mode = "responses";
            litellm_params.model = "chatgpt/gpt-5.4";
          }
          {
            model_name = "opencode-go/glm-5.3-flash";
            litellm_params.model = "openai/glm-5.3-flash";
            litellm_params.api_base = "https://opencode.ai/zen/go/v1";
            litellm_params.api_key = "os.environ/OPENCODE_API_KEY";
          }
        ];
      };
    }`,
  ]));

  assert.equal(rendered.hasConfigFile, true);
  assert.match(rendered.settingsText, /^model_list:/m);
  assert.match(rendered.settingsText, /model_name: chatgpt\/gpt-5\.4/);
  assert.match(rendered.settingsText, /mode: responses/);
  assert.match(rendered.settingsText, /model_name: opencode-go\/glm-5\.3-flash/);
  assert.match(rendered.settingsText, /api_key: os\.environ\/OPENCODE_API_KEY/);
  // Secrets never render into the store config: values are env references.
  assert.equal(rendered.settingsText.includes('sk-'), false);
});

test('activation creates state dirs, seeds tiktoken, and installs the config', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([minimalSettings]));

  assert.ok(rendered.activation, 'expected home.activation.litellmState to be present');
  assert.deepEqual(rendered.activation.after, ['writeBoundary']);

  const mkdirLine = rendered.activation.data.split('\n')[0];
  assert.match(mkdirLine, /run mkdir -p /);
  assert.match(mkdirLine, /Library\/Logs\/litellm/);
  assert.match(mkdirLine, /\.local\/state\/litellm\/ui/);
  assert.match(mkdirLine, /\.local\/state\/litellm\/tiktoken-cache/);
  // tiktoken cache keys are sha1(source URL), matching tiktoken's cache layout.
  assert.match(
    rendered.activation.data,
    /install -Dm0644 -T .* .*\.local\/state\/litellm\/tiktoken-cache\/[0-9a-f]{40}/,
  );
  assert.match(
    rendered.activation.data,
    /install -Dm600 -T .*litellm-config\.yaml.*\.config\/litellm\/config\.yaml/,
  );
});

test('enabled with empty settings fails the eval loudly', () => {
  const failure = nixEvalFailure(standaloneLitellmExpr([
    `{ ... }: { programs.litellm.enable = true; }`,
  ]));

  assert.match(failure, /programs\.litellm\.settings must be non-empty/);
});

test('masterKeyReference must name a declared keychain secret when home.mcp is in scope', () => {
  const failure = nixEvalFailure(standaloneLitellmExpr([
    fakeMcpModule,
    `{ ... }: {
      home.mcp.keychainSecrets."other-secret" = "x";
      programs.litellm.enable = true;
      programs.litellm.settings.model_list = [
        { model_name = "m"; litellm_params.model = "openai/m"; }
      ];
    }`,
  ]));

  assert.match(
    failure,
    /programs\.litellm\.masterKeyReference must name a home\.mcp\.keychainSecrets entry/,
  );
});

test('undeclared provider key references fail the eval loudly', () => {
  const failure = nixEvalFailure(standaloneLitellmExpr([
    fakeMcpModule,
    `{ ... }: {
      home.mcp.keychainSecrets."litellm-master-key" = "x";
      programs.litellm.enable = true;
      programs.litellm.settings.model_list = [
        { model_name = "m"; litellm_params.model = "openai/m"; }
      ];
      programs.litellm.providerKeys.OPENCODE_API_KEY = "opencode-api-key";
    }`,
  ]));

  assert.match(
    failure,
    /programs\.litellm\.providerKeys\.OPENCODE_API_KEY must name a home\.mcp\.keychainSecrets entry/,
  );
});

test('disabled configuration registers no launchd agent', () => {
  const rendered = nixEvalJson(standaloneLitellmExpr([
    `{ ... }: { }`,
  ]));

  assert.equal(rendered.hasAgent, false);
  assert.equal(rendered.agent, null);
  assert.equal(rendered.activation, null);
  assert.equal(rendered.hasConfigFile, false);
  assert.equal(rendered.wrapperText, null);
});

// The fabro-vm is the deployed LiteLLM consumer. litellm 1.86's per-provider
// param allowlists predate its model ids, so without per-deployment
// `allowed_openai_params` the proxy rejects `reasoning_effort` at its param
// gate — for a consumer's request value AND for each chatgpt deployment's
// pinned default, which left the chatgpt models un-callable outright.
test('fabro-vm exposes Go free models with dynamic session forwarding', () => {
  const rendered = nixEvalJson(`
    let
      flake = builtins.getFlake (toString ${repoRoot});
      vm = flake.nixosConfigurations.fabro-vm.config;
      modelList = vm.services.litellm.settings.model_list;
      deploymentStatus = builtins.listToAttrs (builtins.map (deployment: {
        name = deployment.model_name;
        value = {
          allowsReasoningEffort = builtins.elem "reasoning_effort"
            (deployment.litellm_params.allowed_openai_params or [ ]);
          defaultEffort = deployment.litellm_params.reasoning_effort or null;
          mode = deployment.model_info.mode or null;
          apiBase = deployment.litellm_params.api_base or null;
          apiKey = deployment.litellm_params.api_key or null;
          headers = deployment.litellm_params.extra_headers or null;
        };
      }) modelList);
    in
    {
      modelNames = builtins.attrNames deploymentStatus;
      allAllowReasoningEffort =
        builtins.all (d: d.allowsReasoningEffort) (builtins.attrValues deploymentStatus);
      chatgptLuna = deploymentStatus."chatgpt/gpt-6-luna";
      chatgptLunaNone = deploymentStatus."chatgpt/gpt-6-luna-none";
      chatgptAstra = deploymentStatus."chatgpt/gpt-6-astra";
      chatgptSol = deploymentStatus."chatgpt/gpt-6.1-sol";
      goBeam = deploymentStatus."opencode-go/beam-free";
      goOmen = deploymentStatus."opencode-go/omen-alpha";
      goLongcat = deploymentStatus."opencode-go/longcat-2.0";
      goLuna = deploymentStatus."opencode-go/gpt-6-luna";
      goGlm = deploymentStatus."opencode-go/glm-5.3-flash";
      zenBigPickle = deploymentStatus."opencode-zen/big-pickle";
      forwarding =
        vm.services.litellm.settings.litellm_settings.model_group_settings.forward_client_headers_to_llm_api;
      settingsText = builtins.toJSON vm.services.litellm.settings;
    }
  `);

  assert.deepEqual(rendered.modelNames.sort(), [
    'chatgpt/gpt-6-astra',
    'chatgpt/gpt-6-luna',
    'chatgpt/gpt-6-luna-none',
    'chatgpt/gpt-6.1-sol',
    'opencode-go/beam-free',
    'opencode-go/deepseek-v4.1-flash',
    'opencode-go/glm-5.3-flash',
    'opencode-go/gpt-6-luna',
    'opencode-go/longcat-2.0',
    'opencode-go/omen-alpha',
    'opencode-zen/big-pickle',
  ]);
  assert.equal(rendered.allAllowReasoningEffort, true);

  // The pinned deployment defaults survive the allowance merge.
  assert.equal(rendered.chatgptLuna.defaultEffort, 'xhigh');
  assert.equal(rendered.chatgptLuna.mode, 'responses');
  assert.equal(rendered.chatgptLunaNone.defaultEffort, 'none');
  assert.equal(rendered.chatgptLunaNone.mode, 'responses');
  assert.equal(rendered.chatgptAstra.defaultEffort, 'xhigh');
  assert.equal(rendered.chatgptSol.defaultEffort, 'xhigh');
  assert.equal(rendered.goLuna.mode, 'responses');
  assert.equal(rendered.goGlm.mode, 'chat');

  for (const deployment of [rendered.goBeam, rendered.goOmen, rendered.goLongcat]) {
    assert.equal(deployment.mode, 'chat');
    assert.equal(deployment.apiBase, 'https://opencode.ai/zen/go/v1');
    assert.equal(deployment.apiKey, 'os.environ/OPENCODE_API_KEY');
    assert.equal(deployment.headers, null);
  }
  assert.equal(rendered.zenBigPickle.mode, 'chat');

  // Session ids stay dynamic for every opencode-* group.
  assert.deepEqual(rendered.forwarding, [
    'opencode-go/*',
    'opencode-zen/*',
  ]);

  assert.equal(rendered.settingsText.includes('opencode-go/deepseek-v4.1-flash-free'), false);
  assert.equal(rendered.settingsText.includes('opencode-go/glm-5.3-flash-free'), false);
  assert.equal(rendered.settingsText.includes('iceman-contributor-free'), false);

  assert.match(rendered.settingsText, /allowed_openai_params/);
  assert.match(rendered.settingsText, /"reasoning_effort"/);
});
