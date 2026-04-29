{
  inputs,
  pkgs,
  ...
}:
let
  inherit (pkgs.stdenv.hostPlatform) system;
  mcphubBin = "${inputs.mcphub.packages.${system}.default}/bin/mcp-hub";
in
{
  programs.nixvim = {
    # Mark mcphub.nvim as optional so its `plugin/mcphub.lua` doesn't auto-source
    # at startup (which eagerly requires `mcphub.utils.highlights`,
    # `mcphub.state`, and creates the `:MCPHub` user command). lz.n re-loads it
    # on demand via the spec below in extraConfigLuaPre.
    extraPlugins = [
      {
        plugin = inputs.mcphub-nvim.packages.${system}.default;
        optional = true;
      }
    ];

    extraConfigLuaPre = ''
      -- Lazy-load mcphub.nvim on first :MCPHub* command. codecompanion's
      -- mcphub extension auto-triggers this load via its `before` hook
      -- (see plugins/codecompanion.nix), so the integration works the
      -- moment a CodeCompanion command fires, even before any explicit
      -- :MCPHub from the user. The `after` hook runs setup() (with the
      -- mcp-hub binary path baked in) once the plugin is on rtp.
      require("lz.n").load({
        {
          "mcphub.nvim",
          lazy = true,
          cmd = { "MCPHub", "MCPHubAddServer", "MCPHubLogs", "MCPHubReload", "MCPHubRestart" },
          after = function()
            require("mcphub").setup({ cmd = "${mcphubBin}" })
          end,
        },
      })

      --- Shows MCPHub lualine status. Compatible with lazy loading
      function mcphub_lualine_status()
        -- Check if MCPHub is loaded
        if not vim.g.loaded_mcphub then
            return "󰐻 -"
        end

        local count = vim.g.mcphub_servers_count or 0
        local status = vim.g.mcphub_status or "stopped"
        local executing = vim.g.mcphub_executing

        -- Show "-" when stopped
        if status == "stopped" then
            return "󰐻 -"
        end

        -- Show spinner when executing, starting, or restarting
        if executing or status == "starting" or status == "restarting" then
            local frames = { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }
            local frame = math.floor(vim.loop.now() / 100) % #frames + 1
            return "󰐻 " .. frames[frame]
        end

        return "󰐻 " .. count
      end

      --- Calculates the colour of the MCPHub lualine segment
      function mcphub_lualine_colour()
        if not vim.g.loaded_mcphub then
            return { fg = "#6c7086" } -- Gray for not loaded
        end

        local status = vim.g.mcphub_status or "stopped"
        if status == "ready" or status == "restarted" then
            return { fg = "#50fa7b" } -- Green for connected
        elseif status == "starting" or status == "restarting" then
            return { fg = "#ffb86c" } -- Orange for connecting
        else
            return { fg = "#ff5555" } -- Red for error/stopped
        end
      end

    '';
  };
}
