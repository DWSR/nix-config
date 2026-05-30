'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  nixEvalFailure,
  nixEvalJson,
  repoRoot,
} = require('./helpers');

function standaloneTailscaleServeExpr(extraModule) {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
        inherit pkgs;
        modules = [
          ${repoRoot}/home-manager/common/tailscale-serve.nix
          ({ ... }: {
            home.username = "tailscale-serve-test";
            home.homeDirectory = "/Users/tailscale-serve-test";
            home.stateVersion = "25.11";
          })
          (${extraModule})
        ];
      };
    in
    let
      tailscaleServeActivation =
        if hm.config.home.activation ? tailscaleServe then
          hm.config.home.activation.tailscaleServe
        else
          null;
    in
    {
      entries = hm.config.home.tailscaleServe.entries;
      renderedCommands = hm.config.home.tailscaleServe._renderedCommands;
      activation = tailscaleServeActivation;
    }
  `;
}

function standaloneTailscaleServeDefaultsExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      evalModule = extraModule:
        let
          hm = flake.inputs.home-manager.lib.homeManagerConfiguration {
            inherit pkgs;
            modules = [
              ${repoRoot}/home-manager/common/tailscale-serve.nix
              ({ ... }: {
                home.username = "tailscale-serve-test";
                home.homeDirectory = "/Users/tailscale-serve-test";
                home.stateVersion = "25.11";
              })
              extraModule
            ];
          };
          config = hm.config;
          tailscaleActivationNames = builtins.filter
            (name:
              (builtins.match ".*tailscale.*" name) != null
              || (builtins.match ".*Tailscale.*" name) != null)
            (builtins.attrNames config.home.activation);
        in
        {
          enable = config.home.tailscaleServe.enable;
          cliPath = config.home.tailscaleServe.cliPath;
          entries = config.home.tailscaleServe.entries;
          renderedCommands = config.home.tailscaleServe._renderedCommands;
          inherit tailscaleActivationNames;
        };
    in
    {
      disabled = evalModule ({ ... }: { });
      disabledDeclared = evalModule ({ ... }: {
        home.tailscaleServe.entries.web = {
          listen = { protocol = "https"; port = 443; };
          target = { kind = "url"; url = "http://localhost:3000"; };
        };
      });
      enabledEmpty = evalModule ({ ... }: {
        home.tailscaleServe.enable = true;
      });
    }
  `;
}

function personalHostTailscaleServeDormantExpr() {
  return `
    let
      flake = builtins.getFlake (toString ${repoRoot});
      config = flake.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
      activationNames = builtins.attrNames config.home.activation;
      tailscaleActivationNames = builtins.filter
        (name:
          (builtins.match ".*tailscale.*" name) != null
          || (builtins.match ".*Tailscale.*" name) != null)
        activationNames;
      tailscaleActivationText = builtins.concatStringsSep "\n" (
        map (name: config.home.activation.\${name}.data or "") tailscaleActivationNames
      );
    in
    {
      enable = config.home.tailscaleServe.enable;
      entries = config.home.tailscaleServe.entries;
      renderedCommands = config.home.tailscaleServe._renderedCommands;
      inherit tailscaleActivationNames tailscaleActivationText;
    }
  `;
}

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

test('standalone Tailscale Serve module exposes dormant option namespace', () => {
  const rendered = nixEvalJson(standaloneTailscaleServeDefaultsExpr());

  assert.equal(rendered.disabled.enable, false);
  assert.equal(
    rendered.disabled.cliPath,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  );
  assert.deepEqual(rendered.disabled.entries, {});
  assert.deepEqual(rendered.disabled.renderedCommands, []);
  assert.deepEqual(rendered.disabled.tailscaleActivationNames, []);

  assert.equal(rendered.disabledDeclared.enable, false);
  assert.deepEqual(rendered.disabledDeclared.renderedCommands, []);
  assert.deepEqual(rendered.disabledDeclared.tailscaleActivationNames, []);

  assert.equal(rendered.enabledEmpty.enable, true);
  assert.equal(
    rendered.enabledEmpty.cliPath,
    '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  );
  assert.deepEqual(rendered.enabledEmpty.entries, {});
  assert.deepEqual(rendered.enabledEmpty.renderedCommands, []);
  assert.deepEqual(rendered.enabledEmpty.tailscaleActivationNames, []);
});

test('personal host receives dormant Tailscale Serve namespace through common imports', () => {
  const rendered = nixEvalJson(personalHostTailscaleServeDormantExpr());

  assert.equal(rendered.enable, false);
  assert.deepEqual(rendered.entries, {});
  assert.deepEqual(rendered.renderedCommands, []);
  assert.deepEqual(rendered.tailscaleActivationNames, []);

  assert.doesNotMatch(rendered.tailscaleActivationText, /\bserve\b/i);
  assert.doesNotMatch(rendered.tailscaleActivationText, /--(http|https|tcp|tls-terminated-tcp)=/);
  assert.doesNotMatch(rendered.tailscaleActivationText, /localhost|127\.0\.0\.1/);
  assert.doesNotMatch(rendered.tailscaleActivationText, /\b(login|auth|authorize|authorization)\b/i);
  assert.doesNotMatch(rendered.tailscaleActivationText, /\bacl\b/i);
  assert.doesNotMatch(rendered.tailscaleActivationText, /\b(cert|certificate)\b/i);
  assert.doesNotMatch(rendered.tailscaleActivationText, /\bdevice\b/i);
});

test('standalone Tailscale Serve module normalizes supported local proxy entries', () => {
  const cliPath = '/opt/tailscale/bin/tailscale';
  const rendered = nixEvalJson(standaloneTailscaleServeExpr(`{ ... }: {
    home.tailscaleServe.enable = true;
    home.tailscaleServe.cliPath = "${cliPath}";
    home.tailscaleServe.entries = {
      web = {
        listen = {
          protocol = "https";
          port = 443;
          path = "/app";
        };
        target = {
          kind = "url";
          url = "http://localhost:3000";
        };
      };

      metrics = {
        listen = {
          protocol = "http";
          port = 8080;
        };
        target = {
          kind = "url";
          url = "https://127.0.0.1:8443";
        };
      };

      database = {
        listen = {
          protocol = "tcp";
          port = 15432;
        };
        target = {
          kind = "port";
          port = 5432;
        };
      };

      rawTcp = {
        listen = {
          protocol = "tls-terminated-tcp";
          port = 9443;
        };
        target = {
          kind = "url";
          url = "tcp://localhost:9899";
        };
      };
    };
  }`));

  assert.deepEqual(rendered.entries, {
    database: {
      listen: { path: null, port: 15432, protocol: 'tcp' },
      target: { kind: 'port', port: 5432, url: null },
    },
    metrics: {
      listen: { path: null, port: 8080, protocol: 'http' },
      target: { kind: 'url', port: null, url: 'https://127.0.0.1:8443' },
    },
    rawTcp: {
      listen: { path: null, port: 9443, protocol: 'tls-terminated-tcp' },
      target: { kind: 'url', port: null, url: 'tcp://localhost:9899' },
    },
    web: {
      listen: { path: '/app', port: 443, protocol: 'https' },
      target: { kind: 'url', port: null, url: 'http://localhost:3000' },
    },
  });
  assert.deepEqual(rendered.renderedCommands, [
    {
      name: 'database',
      argv: [
        cliPath,
        'serve',
        '--bg',
        '--yes',
        '--tcp=15432',
        '5432',
      ],
    },
    {
      name: 'metrics',
      argv: [
        cliPath,
        'serve',
        '--bg',
        '--yes',
        '--http=8080',
        'https://127.0.0.1:8443',
      ],
    },
    {
      name: 'rawTcp',
      argv: [
        cliPath,
        'serve',
        '--bg',
        '--yes',
        '--tls-terminated-tcp=9443',
        'tcp://localhost:9899',
      ],
    },
    {
      name: 'web',
      argv: [
        cliPath,
        'serve',
        '--bg',
        '--yes',
        '--https=443',
        '--set-path=/app',
        'http://localhost:3000',
      ],
    },
  ]);

  const renderedArgv = rendered.renderedCommands.flatMap(command => command.argv);
  assert.equal(renderedArgv.includes('funnel'), false);
  assert.equal(renderedArgv.includes('reset'), false);
  assert.equal(renderedArgv.includes('tailscaled'), false);
  assert.equal(renderedArgv.some(arg => arg.startsWith('file:')), false);
  assert.equal(renderedArgv.some(arg => arg.startsWith('dir:')), false);
  assert.equal(renderedArgv.some(arg => arg.startsWith('text:')), false);
});

test('standalone Tailscale Serve module renders activation convergence for declared entries', () => {
  const cliPath = '/opt/tailscale/bin/tailscale';
  const rendered = nixEvalJson(standaloneTailscaleServeExpr(`{ ... }: {
    home.tailscaleServe.enable = true;
    home.tailscaleServe.cliPath = "${cliPath}";
    home.tailscaleServe.entries = {
      web = {
        listen = {
          protocol = "https";
          port = 443;
          path = "/app";
        };
        target = {
          kind = "url";
          url = "http://localhost:3000";
        };
      };

      database = {
        listen = {
          protocol = "tcp";
          port = 15432;
        };
        target = {
          kind = "port";
          port = 5432;
        };
      };
    };
  }`));

  assert.deepEqual(rendered.activation.after, ['writeBoundary']);
  assert.deepEqual(rendered.activation.before, []);

  const activationScript = rendered.activation.data;
  assert.match(activationScript, /TAILSCALE_BE_CLI=1/);
  assert.match(activationScript, /Missing Tailscale CLI path: \/opt\/tailscale\/bin\/tailscale/);
  assert.match(activationScript, /Failed to apply Tailscale Serve entry: database/);
  assert.match(activationScript, /Failed to apply Tailscale Serve entry: web/);
  assert.match(activationScript, /run .*serve .*--bg .*--yes .*'?--tcp=15432'?.*5432/);
  assert.match(activationScript, /run .*serve .*--bg .*--yes .*'?--https=443'?.*'?--set-path=\/app'?.*http:\/\/localhost:3000/);
  assert.doesNotMatch(activationScript, /tailscaled/);
  assert.doesNotMatch(activationScript, /serve\s+reset/);
  assert.doesNotMatch(activationScript, /funnel/i);
  assert.doesNotMatch(activationScript, /\b(login|auth|authorize|authorization)\b/i);
  assert.doesNotMatch(activationScript, /unmanaged|cleanup|clear/);
});

test('standalone Tailscale Serve module rejects unsupported exposure declarations', () => {
  const invalidModules = [
    {
      name: 'funnel/public exposure shape',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.publicWeb = {
        public = true;
        listen = { protocol = "https"; port = 443; };
        target = { kind = "url"; url = "http://localhost:3000"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.publicWeb\.public.*does not exist/s,
    },
    {
      name: 'file target kind',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.fileServer = {
        listen = { protocol = "https"; port = 443; };
        target = { kind = "file"; path = "/tmp/index.html"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.fileServer\.target\.(kind|path).*(`kind'|not of type|does not exist)/s,
    },
    {
      name: 'directory target kind',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.dirServer = {
        listen = { protocol = "https"; port = 443; };
        target = { kind = "directory"; path = "/tmp/site"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.dirServer\.target\.(kind|path).*(`kind'|not of type|does not exist)/s,
    },
    {
      name: 'static text target kind',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.textServer = {
        listen = { protocol = "https"; port = 443; };
        target = { kind = "text"; text = "hello"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.textServer\.target\.(kind|text).*(`kind'|not of type|does not exist)/s,
    },
    {
      name: 'non-local URL target',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.remote = {
        listen = { protocol = "https"; port = 443; };
        target = { kind = "url"; url = "https://example.com:8443"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.remote\.target\.url.*local loopback proxy URL/s,
    },
    {
      name: 'listener port below range',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.badPort = {
        listen = { protocol = "https"; port = 0; };
        target = { kind = "url"; url = "http://localhost:3000"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.badPort\.listen\.port.*TCP port from 1 through 65535/s,
    },
    {
      name: 'listener port above range',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.badPort = {
        listen = { protocol = "https"; port = 65536; };
        target = { kind = "url"; url = "http://localhost:3000"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.badPort\.listen\.port.*TCP port from 1 through 65535/s,
    },
    {
      name: 'target port below range',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.badTargetPort = {
        listen = { protocol = "tcp"; port = 15432; };
        target = { kind = "port"; port = 0; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.badTargetPort\.target\.port.*TCP port from 1 through 65535/s,
    },
    {
      name: 'target port above range',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.badTargetPort = {
        listen = { protocol = "tcp"; port = 15432; };
        target = { kind = "port"; port = 65536; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.badTargetPort\.target\.port.*TCP port from 1 through 65535/s,
    },
    {
      name: 'TCP listener path',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.tcpPath = {
        listen = { protocol = "tcp"; port = 15432; path = "/db"; };
        target = { kind = "port"; port = 5432; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.tcpPath\.listen\.path.*only supported for http and https listeners/s,
    },
    {
      name: 'TLS-terminated TCP listener path',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.tlsPath = {
        listen = { protocol = "tls-terminated-tcp"; port = 9443; path = "/raw"; };
        target = { kind = "url"; url = "tcp://localhost:9899"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.tlsPath\.listen\.path.*only supported for http and https listeners/s,
    },
    {
      name: 'URL target port above range',
      extraModule: `{ ... }: {
      home.tailscaleServe.entries.badUrlPort = {
        listen = { protocol = "https"; port = 443; };
        target = { kind = "url"; url = "http://localhost:65536"; };
      };
    }`,
      expected: /home\.tailscaleServe\.entries\.badUrlPort\.target\.url.*local loopback proxy URL/s,
    },
  ];

  for (const { name, extraModule, expected } of invalidModules) {
    const error = nixEvalFailure(standaloneTailscaleServeExpr(extraModule));

    assert.match(error, /error:/, name);
    assert.match(error, expected, name);
    assert.doesNotMatch(error, /Applying Tailscale Serve entry:/, name);
    assert.doesNotMatch(error, /Missing Tailscale CLI path:/, name);
    assert.doesNotMatch(error, /Failed to apply Tailscale Serve entry:/, name);
  }
});
