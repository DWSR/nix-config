{
  lib,
  config,
  ...
}:
let
  proxyHeader = {
    X-Shopify-Session-Affinity-Header = "opencode-session-id";
    opencode-session-id = "{env:OPENCODE_SESSION_ID}";
    Shopify-Usage-Tag = builtins.toJSON [
      "opencode_cli"
      "{env:OPENCODE_SESSION_ID}"
      "rtk:disabled"
    ];
  };

  mkProvider = baseURL: {
    options = {
      inherit baseURL;
      apiKey = "{env:OPENCODE_API_KEY}";
      headers = proxyHeader;
    };
  };
in
{
  xdg.configFile."opencode/tui.json" = {
    enable = true;
    text = builtins.toJSON {
      theme = "nord";
      scroll_acceleration.enabled = true;
    };
  };

  # Override the common AGENTS.md (home-manager/common/agents.md) with a
  # concatenated version that adds Shopify-host-specific Graphite guidance.
  # The common module declares programs.opencode.rules, so mkForce is
  # required to replace rather than collide. The rendered file is the
  # two common chunks (memory + cc-sdd preamble) plus the Shopify-only
  # Graphite addendum, separated by blank lines. The upstream
  # cc-sdd quickstart (pkgs.cc-sdd-skills/agents-md) is intentionally
  # NOT included — the slash-command catalogue is already covered by
  # the cc-sdd preamble and the per-skill SKILL.md frontmatter that
  # opencode loads from ~/.config/opencode/skills/. See
  # memories/2026-05-20-agents-md-compression.md for the rationale.
  #
  # The agents-graphite.md addendum is the lean version: decision
  # matrix, green-path rule, bypass-autonomy rule, pitfall index, and
  # workflow rules summary. The full Category A/B/C bash recovery
  # catalogue lives in the graphite-pitfalls skill (./skills/) and
  # only loads when a gt command has actually failed. See
  # memories/2026-04-30-graphite-pitfalls.md for the deeper
  # investigative reference (new failure modes not yet in the skill).
  #
  # The home-manager opencode module's `rules` option is `lines`-typed
  # (null | string), not a path or derivation. Pass the concatenated
  # string directly rather than via pkgs.writeText.
  programs.opencode.rules = lib.mkForce (
    lib.concatStringsSep "\n\n" [
      (builtins.readFile ../../../home-manager/common/agents.md)
      (builtins.readFile ../../../home-manager/common/agents-cc-sdd.md)
      (builtins.readFile ./agents-graphite.md)
    ]
  );

  # Shopify-only graphite-pitfalls skill — full Category A/B/C bash
  # recovery catalogue for gt failures. Loads only on an explicit gt
  # error per the skill's narrow trigger description (see SKILL.md).
  # Co-installed alongside the cc-sdd kiro-* skills under
  # ~/.config/opencode/skills/ per the pattern documented in
  # home-manager/common/cc-sdd.nix lines 64-68.
  xdg.configFile."opencode/skills/graphite-pitfalls" = {
    source = ./skills/graphite-pitfalls;
  };

  # Apply the vendored caveman-lite output style to every common subagent
  # (nix-pkg, nvim-tailor, security-auditor, vault-curator,
  # vault-synthesizer). The withCaveman helper in
  # home-manager/common/opencode.nix appends ./opencode/caveman-lite.md to
  # each agent's system prompt at Nix-eval time. Drops filler / hedging /
  # pleasantries while preserving code, paths, identifiers, and error
  # strings byte-for-byte — net win on token usage during SDD-heavy
  # workflows (kiro-impl dispatch chains in particular). Off-by-default
  # was a deliberate Shopify-host carve-out; user has opted in.
  home.opencode.enableCaveman = true;

  # Shopify-specific runtime env for opencode — fetches API key + proxy base
  # from `devx llm-gateway` on every invocation, and mints a per-invocation
  # session id used by the provider headers for sticky routing.
  # Appended to the common opencode wrapper (see home-manager/common/opencode.nix)
  # rather than building a separate symlinkJoin overlay package.
  home.opencode.wrapperCommands = [
    ''
      OPENCODE_API_KEY="$(devx llm-gateway print-token --key 2>/dev/null)" || {
        echo "Error: Failed to get OPENCODE_API_KEY from devx llm-gateway print-token --key" >&2
        exit 1
      }
      export OPENCODE_API_KEY

      DEFAULT_PROXY_BASE="$(devx llm-gateway print-token --base 2>/dev/null)" || {
        echo "Error: Failed to get DEFAULT_PROXY_BASE from devx llm-gateway print-token --base" >&2
        exit 1
      }
      export DEFAULT_PROXY_BASE

      export OPENCODE_SESSION_ID="$(uuidgen)"
    ''
  ];

  programs.opencode.commands = {
    make-stack-green = ./commands/make-stack-green.md;
    restack = ./commands/restack.md;
    upgrade-environment = ./commands/upgrade-environment.md;
  };

  # stack-captain and yb-sleuth are wrapped via the shared
  # `home.opencode.agentWithCaveman` helper from
  # home-manager/common/opencode.nix so they inherit the same caveman-lite
  # snippet (or skip it) in lock-step with the common subagents whenever
  # `home.opencode.enableCaveman` flips.
  programs.opencode.agents = {
    stack-captain = config.home.opencode.agentWithCaveman ./agents/stack-captain.md;
    yb-sleuth = config.home.opencode.agentWithCaveman ./agents/yb-sleuth.md;
  };

  programs.opencode.settings = {
    model = "anthropic/claude-opus-4-7";
    agent.build = {
      model = "anthropic/claude-opus-4-7";
      variant = "max";
    };
    enabled_providers = [
      "anthropic"
      "openai"
      "google"
      "groq"
      "xai"
      "cohere"
      "perplexity"
    ];
    share = "disabled";
    autoupdate = false;
    permission = {
      "*" = "allow";
      "doom_loop" = "allow";
    };
    mcp = {
      mcpproxy = {
        type = "remote";
        url = "http://127.0.0.1:8080/mcp";
        enabled = true;
      };
    };
    provider = {
      anthropic = mkProvider "{env:DEFAULT_PROXY_BASE}/apis/anthropic/v1";
      openai = mkProvider "{env:DEFAULT_PROXY_BASE}/vendors/openai/v1";
      google = {
        options = {
          baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google";
          apiKey = "{env:OPENCODE_API_KEY}";
          headers = proxyHeader // {
            Authorization = "Bearer {env:OPENCODE_API_KEY}";
          };
        };
      };
      groq = mkProvider "{env:DEFAULT_PROXY_BASE}/vendors/groq/openai/v1";
      xai = mkProvider "{env:DEFAULT_PROXY_BASE}/vendors/xai/v1";
      cohere = mkProvider "{env:DEFAULT_PROXY_BASE}/vendors/cohere/v2";
      perplexity = mkProvider "{env:DEFAULT_PROXY_BASE}/vendors/perplexity";
    };
  };
}
