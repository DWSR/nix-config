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
    extraPlugins = [
      inputs.mcphub-nvim.packages.${system}.default
    ];

    extraConfigLuaPre = ''
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

      -- Defer mcphub.nvim setup to after VimEnter (vim.schedule pushes it
      -- to the next tick, off the startup critical path). The lualine
      -- status function above already handles the "not yet loaded" case
      -- by checking vim.g.loaded_mcphub. Saves ~50ms (mcphub + mcphub.hub
      -- + mcphub.utils + mcphub.utils.config_manager + mcphub.native)
      -- from nvim startup; the brief "-" status flicker after VimEnter is
      -- imperceptible.
      vim.api.nvim_create_autocmd("VimEnter", {
        once = true,
        callback = vim.schedule_wrap(function()
          require("mcphub").setup({ cmd = "${mcphubBin}" })
        end),
      })
    '';
  };
}
