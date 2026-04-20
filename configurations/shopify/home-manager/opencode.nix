_:
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
