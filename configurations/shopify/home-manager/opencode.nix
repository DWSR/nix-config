{ pkgs, ... }:
{
  xdg.configFile."opencode/tui.json" = {
    enable = true;
    text = builtins.toJSON {
      theme = "nord";
    };
  };

  home.opencode.package = pkgs.opencode-shopify;

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
        anthropic = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/apis/anthropic/v1";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
        openai = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/openai/v1";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
        google = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/googlevertexai-global/v1beta1/projects/shopify-ml-production/locations/global/publishers/google";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
              Authorization = "Bearer {env:OPENCODE_API_KEY}";
            };
          };
        };
        groq = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/groq/openai/v1";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
        xai = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/xai/v1";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
        cohere = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/cohere/v2";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
        perplexity = {
          options = {
            baseURL = "{env:DEFAULT_PROXY_BASE}/vendors/perplexity";
            apiKey = "{env:OPENCODE_API_KEY}";
            headers = {
              X-Shopify-Session-Affinity-Header = "opencode-session-id";
              opencode-session-id = "{OPENCODE_SESSION_ID}";
            };
          };
        };
      };
  };
}
