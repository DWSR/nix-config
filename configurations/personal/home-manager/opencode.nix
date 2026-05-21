_: {
  # Enable caveman-lite output style on personal-host opencode subagents.
  # Trims filler/hedging from nix-pkg, nvim-tailor, security-auditor, and
  # vault-curator output. Off on Shopify hosts (kept verbose for
  # production-work clarity).
  #
  # See home-manager/common/opencode/caveman-lite.md for the snippet that
  # gets appended to each subagent's system prompt when this is enabled,
  # and home-manager/common/opencode.nix for the option definition and
  # wiring.
  home.opencode.enableCaveman = true;

  # Route opencode MCP traffic through the local mcpproxy daemon
  # (managed by home-manager/common/mcpproxy.nix). Mirrors the Shopify
  # host's entry in configurations/shopify/home-manager/opencode.nix.
  programs.opencode.settings.mcp.mcpproxy = {
    type = "remote";
    url = "http://127.0.0.1:8080/mcp";
    enabled = true;
  };
}
