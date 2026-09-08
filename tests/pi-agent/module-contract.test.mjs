import assert from "node:assert/strict";
import childProcess from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testsDir, "../..");
const commandOptions = {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
  timeout: 120_000,
};

function evaluateFixture(fixture) {
  const expression = `
    let
      repoSource = builtins.path {
        path = /. + ${JSON.stringify(repoRoot)};
        name = "pi-agent-module-contract-source";
        filter = path: type: builtins.baseNameOf path != ".git";
      };
    in
    import (repoSource + "/tests/pi-agent/fixtures/module-contract.nix") {
      fixture = ${JSON.stringify(fixture)};
      repoRoot = repoSource;
    }
  `;

  return childProcess.spawnSync(
    "nix",
    ["eval", "--json", "--impure", "--expr", expression],
    commandOptions,
  );
}

function validFixture(fixture) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function rejectedFixture(fixture, diagnostics) {
  const result = evaluateFixture(fixture);
  assert.ifError(result.error);
  assert.notEqual(result.status, 0, `${fixture} unexpectedly evaluated: ${result.stdout}`);

  const output = `${result.stderr}\n${result.stdout}`;
  for (const diagnostic of diagnostics) {
    assert.match(output, diagnostic, `${fixture} did not emit ${diagnostic}:\n${output}`);
  }
}

test("valid Shopify options deep-force every closed contract category", () => {
  const config = validFixture("valid-shopify");

  assert.equal(config.enable, true);
  assert.equal(config.packageIsDerivation, true);
  assert.equal(config.packageHasOutputContext, true);
  assert.equal(config.packageOutputName, "out");
  assert.deepEqual(Object.keys(config.extensions).sort(), [
    "agentmemory",
    "backgroundTasks",
    "bashTimeout",
    "codeIntelligence",
    "mcp",
    "plan",
    "questions",
    "subagents",
    "timestamps",
  ]);
  assert.ok(
    Object.values(config.extensions).every(
      (ref) =>
        ref.packageIsDerivation && ref.packageHasOutputContext && ref.packageOutputName === "out",
    ),
  );
  assert.deepEqual(config.manifests, [
    {
      packageHasOutputContext: true,
      packageIsDerivation: true,
      packageOutputName: "out",
      relativePath: "share/pi-agent/extensions.json",
    },
  ]);
  assert.deepEqual(config.instructions, [
    {
      packageHasOutputContext: true,
      packageIsDerivation: true,
      packageOutputName: "out",
      relativePath: "share/pi-agent/instructions.md",
    },
  ]);
  assert.deepEqual(config.resources, [
    {
      packageHasOutputContext: true,
      packageIsDerivation: true,
      packageOutputName: "out",
      relativePath: "share/pi-agent/resources/rules.md",
    },
  ]);
  assert.deepEqual(config.languageServers, {
    fixture: {
      packageHasOutputContext: true,
      packageIsDerivation: true,
      packageOutputName: "out",
      relativePath: "bin/fixture-lsp",
    },
    multi: {
      packageHasOutputContext: true,
      packageIsDerivation: true,
      packageOutputName: "tools",
      relativePath: "bin/multi-lsp",
    },
  });
  assert.deepEqual(config.provider, {
    defaultModel: { modelId: "gpt-5.6-sol", provider: "openai" },
    enabledRoles: ["anthropic", "openai", "google", "groq", "xai"],
    mode: "shopify-gateway",
  });
  assert.deepEqual(config.resolverKinds, [
    "pi-auth",
    "shopify-gateway-token",
    "shopify-gateway-base",
  ]);
  assert.deepEqual(config.state, {
    generation: "module-contract-v1",
    location: "pi-default",
  });
  assert.deepEqual(config.mcp, { cacheTtlDays: 7, port: 8080 });
  assert.deepEqual(config.sandbox, { defaultState: "audit" });
  assert.deepEqual(config.subagents, {
    maxDepth: 2,
    termination: { forcedMs: 1000, gracefulMs: 3000 },
  });
  assert.deepEqual(config.plan, {
    defaultTools: ["read", "grep", "find", "ls"],
    enable: true,
  });
  assert.deepEqual(config.timeouts, {
    bashDefaultMs: 120000,
    preflightMs: 15000,
    resolverMs: 10000,
  });
  assert.deepEqual(config.security, {
    advisories: {
      exceptions: [
        {
          approver: "fixture-reviewer",
          expiresOn: "2026-12-31",
          id: "GHSA-fixture",
          rationale: "Fixture exception metadata",
        },
      ],
    },
    allowCapabilityElevation: false,
    allowLiteralProviderValues: false,
  });
  assert.deepEqual(config.sandboxCatalog, {
    packageHasOutputContext: true,
    packageIsDerivation: true,
    packageOutputName: "out",
  });
});

test("personal selection is OpenAI-only and uses the closed resolver vocabulary", () => {
  assert.deepEqual(validFixture("valid-personal"), {
    defaultModel: { modelId: "gpt-5.6-sol", provider: "openai" },
    enabledRoles: [],
    mode: "personal",
    resolverKinds: ["pi-auth", "shopify-gateway-token", "shopify-gateway-base"],
  });
});

test("disabled defaults emit no packages, files, or activation actions", () => {
  assert.deepEqual(validFixture("disabled"), {
    emittedConfigKeys: [],
    enable: false,
    sandboxCatalog: null,
  });
});

test("package resource references reject every non-canonical relative path", async (t) => {
  const invalidPaths = [
    "path-empty",
    "path-absolute",
    "path-dot",
    "path-dot-dot",
    "path-double-separator",
    "path-trailing-separator",
    "path-backslash",
    "path-encoded-traversal",
  ];

  for (const fixture of invalidPaths) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [
        /programs\.pi-agent\.extensions\.agentmemory\.relativePath/,
        /canonical package-relative path/,
      ]);
    });
  }
});

test("provider selections enforce role and default-model references", async (t) => {
  const cases = {
    "shopify-empty-roles": /requires at least one enabled role/,
    "shopify-duplicate-roles": /enabled roles must be unique/,
    "shopify-disabled-default": /default model provider `openai` is not enabled/,
    "enabled-missing-default": /provider\.defaultModel must be set when programs\.pi-agent is enabled/,
    "personal-non-openai-default": /personal mode requires the OpenAI default provider/,
    "personal-shopify-roles": /personal mode does not accept Shopify enabled roles/,
    "unsupported-role": /programs\.pi-agent\.provider\.enabledRoles/,
  };

  for (const [fixture, diagnostic] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [diagnostic]);
    });
  }
});

test("former provider bypass fields are native unknown options", async (t) => {
  const cases = {
    "provider-headers": /programs\.pi-agent\.provider\.headers/,
    "provider-base-url": /programs\.pi-agent\.provider\.baseUrl/,
    "provider-runtime-base-path": /programs\.pi-agent\.provider\.runtimeBasePath/,
    "provider-model-metadata": /programs\.pi-agent\.provider\.defaultModel\.contextWindow/,
    "provider-public-literal": /programs\.pi-agent\.provider\.publicLiterals/,
    "provider-secret-argv": /programs\.pi-agent\.provider\.resolvers/,
    "provider-environment-name": /programs\.pi-agent\.provider\.resolvers/,
  };

  for (const [fixture, optionPath] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [optionPath, /does not exist/]);
    });
  }
});

test("resource and policy contracts reject raw store strings and executable text", async (t) => {
  const cases = {
    "extension-store-root": [
        /programs\.pi-agent\.extensions\.agentmemory\.storeRoot/,
      /does not exist/,
    ],
    "extension-raw-package-string": [
        /programs\.pi-agent\.extensions\.agentmemory\.package/,
      /package/,
    ],
    "extension-arbitrary-name": [
      /programs\.pi-agent\.extensions\.unreviewed/,
      /does not exist/,
    ],
    "subagent-shell": [/programs\.pi-agent\.subagents\.shell/, /does not exist/],
    "provider-model-store-string": [
      /programs\.pi-agent\.provider\.defaultModel\.modelId/,
      /safe catalog model identifier/,
    ],
    "provider-model-shell-text": [
      /programs\.pi-agent\.provider\.defaultModel\.modelId/,
      /safe catalog model identifier/,
    ],
    "state-generation-shell-text": [
      /programs\.pi-agent\.state\.generation/,
      /safe non-empty identifier/,
    ],
    "mcp-endpoint": [/programs\.pi-agent\.mcp\.endpoint/, /does not exist/],
    "plan-executable-tool": [/programs\.pi-agent\.plan\.defaultTools/, /read-only plan tool/],
    "timeout-string": [/programs\.pi-agent\.timeouts\.resolverMs/, /positive integer/],
  };

  for (const [fixture, diagnostics] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, diagnostics);
    });
  }
});

test("package options reject derivation-shaped attrsets without output context", async (t) => {
  const cases = {
    "root-forged-package": /programs\.pi-agent\.package/,
    "resource-forged-package": /programs\.pi-agent\.resources.*package/,
    "lsp-forged-package": /programs\.pi-agent\.languageServers\.fixture\.package/,
  };

  for (const [fixture, optionPath] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [optionPath, /context-backed Nix derivation package/]);
    });
  }
});

test("package options bind output text to the selected output context", async (t) => {
  const cases = {
    "root-context-swap-package": /programs\.pi-agent\.package/,
    "resource-context-swap-package": /programs\.pi-agent\.resources.*package/,
    "lsp-context-swap-package": /programs\.pi-agent\.languageServers\.fixture\.package/,
  };

  for (const [fixture, optionPath] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [optionPath, /context-backed Nix derivation package/]);
    });
  }
});

test("host modules cannot reopen closed submodules with _module.freeformType", async (t) => {
  const cases = {
    "freeform-root-provider-url": /programs\.pi-agent\.providerUrl/,
    "freeform-extension": /programs\.pi-agent\.extensions\.unreviewed/,
    "freeform-resource-ref": /programs\.pi-agent\.resources.*storeRoot/,
    "freeform-provider": /programs\.pi-agent\.provider\.baseUrl/,
    "freeform-model": /programs\.pi-agent\.provider\.defaultModel\.contextWindow/,
    "freeform-state": /programs\.pi-agent\.state\.storeRoot/,
    "freeform-mcp": /programs\.pi-agent\.mcp\.endpoint/,
    "freeform-sandbox": /programs\.pi-agent\.sandbox\.profile/,
    "freeform-subagent": /programs\.pi-agent\.subagents\.shell/,
    "freeform-termination": /programs\.pi-agent\.subagents\.termination\.argv/,
    "freeform-plan": /programs\.pi-agent\.plan\.shell/,
    "freeform-timeouts": /programs\.pi-agent\.timeouts\.command/,
    "freeform-security": /programs\.pi-agent\.security\.providerHeaders/,
    "freeform-advisories": /programs\.pi-agent\.security\.advisories\.evaluationDate/,
    "freeform-advisory-entry": /programs\.pi-agent\.security\.advisories\.exceptions.*headers/,
  };

  for (const [fixture, optionPath] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, [optionPath, /does not exist/]);
    });
  }
});

test("security is closed and fixes provider literals and capability elevation off", async (t) => {
  const cases = {
    "top-level-advisories": [/programs\.pi-agent\.advisories/, /does not exist/],
    "security-literal-provider-values": [
      /programs\.pi-agent\.security\.allowLiteralProviderValues/,
      /false/,
    ],
    "security-capability-elevation": [
      /programs\.pi-agent\.security\.allowCapabilityElevation/,
      /false/,
    ],
    "advisory-host-date": [
      /programs\.pi-agent\.security\.advisories\.evaluationDate/,
      /does not exist/,
    ],
  };

  for (const [fixture, diagnostics] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, diagnostics);
    });
  }
});

test("advisory metadata is trimmed before security policy validation", () => {
  assert.deepEqual(validFixture("advisory-normalized"), {
    advisories: {
      exceptions: [
        {
          approver: "fixture-reviewer",
          expiresOn: "2026-12-31",
          id: "GHSA-normalized",
          rationale: "Normalized fixture rationale",
        },
      ],
    },
    allowCapabilityElevation: false,
    allowLiteralProviderValues: false,
  });
});

test("Unicode internal whitespace is normalized in advisory rationale", () => {
  const security = validFixture("advisory-unicode-normalized");
  assert.equal(security.advisories.exceptions[0].rationale, "Unicode internal rationale");
});

test("Gregorian leap day and next-day expiry boundaries remain active", () => {
  const leap = validFixture("advisory-leap-positive");
  assert.equal(leap.advisories.exceptions[0].expiresOn, "2024-02-29");

  const boundary = validFixture("advisory-boundary-active");
  assert.equal(boundary.advisories.exceptions[0].expiresOn, "2026-08-09");
});

test("advisory exceptions require complete unexpired metadata at an explicit date", async (t) => {
  const cases = {
    "advisory-incomplete": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*approver/,
      /has no value defined/,
    ],
    "advisory-missing-date": [/advisory exceptions require an evaluation date/],
    "advisory-invalid-date": [/piAgentAdvisoryDate must be a Gregorian date/],
    "advisory-impossible-date": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*expiresOn/,
      /Gregorian date/,
    ],
    "advisory-non-leap-date": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*expiresOn/,
      /Gregorian date/,
    ],
    "advisory-century-non-leap-date": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*expiresOn/,
      /Gregorian date/,
    ],
    "advisory-invalid-evaluation-date": [/piAgentAdvisoryDate must be a Gregorian date/],
    "advisory-whitespace-id": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*id/,
      /trimmed non-empty advisory metadata/,
    ],
    "advisory-whitespace-rationale": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*rationale/,
      /trimmed non-empty advisory metadata/,
    ],
    "advisory-whitespace-approver": [
      /programs\.pi-agent\.security\.advisories\.exceptions.*approver/,
      /trimmed non-empty advisory metadata/,
    ],
    "advisory-duplicate-id": [/advisory exception IDs must be unique/],
    "advisory-unicode-duplicate-id": [/advisory exception IDs must be unique/],
    "advisory-expired": [/advisory exception `GHSA-expired` expired on 2026-08-08/],
  };

  for (const [fixture, diagnostics] of Object.entries(cases)) {
    await t.test(fixture, () => {
      rejectedFixture(fixture, diagnostics);
    });
  }
});

test("Unicode separators and invisible format characters cannot satisfy advisory metadata", async (t) => {
  const names = [
    "nbsp",
    "ogham",
    "en-space",
    "em-space",
    "thin-space",
    "zero-width",
    "line-separator",
    "paragraph-separator",
    "narrow-no-break",
    "word-joiner",
    "medium-mathematical",
    "ideographic",
    "bom",
  ];

  for (const name of names) {
    const fixture = `advisory-unicode-${name}`;
    await t.test(name, () => {
      rejectedFixture(fixture, [
        /programs\.pi-agent\.security\.advisories\.exceptions.*id/,
        /trimmed non-empty advisory metadata/,
      ]);
    });
  }
});
