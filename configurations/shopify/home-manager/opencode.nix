{ pkgs, ... }:
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

  home.opencode.package = pkgs.opencode-shopify;

  programs.opencode.commands = {
    restack = ./commands/restack.md;
  };

  programs.opencode.settings = {
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
