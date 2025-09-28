{ lib, ... }:
{
  programs.nixvim.env = {
    KAGI_API_KEY = "vMM90sBOwfBTVOQRYkHXBy0cJqpo2NMYmTSv-5VRTOQ.3rPIRRlSiw8Li4tzhXaZyovSlvSZWIJVIzHuO-vHysQ";
  };

  programs.nixvim.plugins.avante = {
    enable = false;

    settings = {
      system_prompt = {
        __raw = ''
          function()
            local hub = require("mcphub").get_hub_instance()
            return hub and hub:get_active_servers_prompt() or ""
          end
        '';
      };

      custom_tools = {
        __raw = ''
          function()
            return {
              require("mcphub.extensions.avante").mcp_tool(),
            }
          end
        '';
      };

      auto_suggestions_provider = "copilot";

      web_search_engine = {
        provider = "kagi";
      };

      provider = "copilot";
      # TODO Get this to actually work.
      # https://main.vscode-cdn.net/extensions/copilotChat.json
      providers = {
        "copilot-claude-3.7" = {
          __inherited_from = "copilot";
          model = "claude-3-7-sonnet-20250219";
          display_name = "copilot/claude-3.7";
          extra_request_body = {
            max_tokens = 65536;
          };
        };
        "copilot-gpt-4.1" = {
          __inherited_from = "copilot";
          model = "gpt-4.1";
          display_name = "copilot/gpt-4.1";
          extra_request_body = {
            max_tokens = 32768;
          };
        };
      };
    };
  };

  programs.nixvim.plugins.cmp.settings.sources = lib.mkAfter [
    { name = "cmp_avante"; }
  ];
}
