{ pkgs, lib, ... }:
let
  proxyHeader = {
    X-Shopify-Session-Affinity-Header = "opencode-session-id";
    opencode-session-id = "{OPENCODE_SESSION_ID}";
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
    };
  };

  # Override the common AGENTS.md (home-manager/common/agents.md) with a
  # concatenated version that adds Shopify-host-specific Graphite guidance.
  # The common module declares programs.opencode.rules, so mkForce is
  # required to replace rather than collide. The rendered file is the
  # three common chunks (memory + cc-sdd preamble + cc-sdd quickstart)
  # plus the Shopify-only Graphite addendum, separated by blank lines.
  # See memories/2026-04-30-graphite-pitfalls.md for the consolidated
  # pitfalls catalog the Graphite addendum mirrors.
  #
  # The home-manager opencode module's `rules` option is `lines`-typed
  # (null | string), not a path or derivation. Pass the concatenated
  # string directly rather than via pkgs.writeText.
  programs.opencode.rules = lib.mkForce (
    lib.concatStringsSep "\n\n" [
      (builtins.readFile ../../../home-manager/common/agents.md)
      (builtins.readFile ../../../home-manager/common/agents-cc-sdd.md)
      (builtins.readFile "${pkgs.cc-sdd-skills}/agents-md")
      (builtins.readFile ./agents-graphite.md)
    ]
  );

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

  programs.opencode.agents = {
    stack-captain = ./agents/stack-captain.md;
    yb-sleuth = ./agents/yb-sleuth.md;
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
      hub = {
        type = "remote";
        url = "http://localhost:37373/mcp/";
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
