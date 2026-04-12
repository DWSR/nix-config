{
  inputs,
  pkgs,
  ...
}:
{
  programs.nixvim = {
    extraPlugins = [
      inputs.mcphub-nvim.packages.${pkgs.stdenv.hostPlatform.system}.default
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

      require("mcphub").setup({
        cmd = "${inputs.mcphub.packages."aarch64-darwin".default}/bin/mcp-hub"
      })
    '';
  };
}
