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

  # opencode-nono sandbox rollout posture for this host (R3.1). The module
  # (home-manager/common/opencode-nono.nix) is enabled by the common
  # default.nix; here we set the personal host's rollout intent.
  programs.opencode-nono = {
    # v1 ships `disabled`: the outer launcher
    # (scripts/opencode-nono-launcher.nix) relocates the mcpproxy preflight
    # host-side OUTSIDE nono but execs bare opencode, so no host runs under
    # the sandbox yet. Rollout to `audit` then `enforced` is post-v1, gated
    # by the recorded runtime gate (task 5.4). Explicit here (matches the
    # module default) to document this host's rollout decision, mirroring how
    # the mcpproxy mcp + caveman above are set explicitly even where defaults
    # suffice.
    defaultState = "disabled";

    # This host uses the base catalog profiles (rendered by the module). The
    # state→profile mapping is enforced→opencode-managed, audit→opencode-audit,
    # review→opencode-review. Set explicitly to the module defaults so the
    # chosen mapping is legible at the host level; no host-specific profiles
    # are added here (that is the Shopify host's job, task 6.3).
    managedProfile = "opencode-managed";
    auditProfile = "opencode-audit";
    reviewProfile = "opencode-review";
  };
}
