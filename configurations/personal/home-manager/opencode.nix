{ lib, ... }:
{
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
    # Rollout state `audit`: the outer launcher
    # (scripts/opencode-nono-launcher.nix) relocates the mcpproxy preflight
    # host-side OUTSIDE nono, then execs
    # `nono run --profile opencode-audit --allow-cwd -- opencode`. The audit
    # profile is permissive (network unblocked, mcpproxy loopback :8080, broad
    # allow_vars) so OpenCode + plugins start cleanly and any sandbox-induced
    # failure surfaces as a real error rather than a silent no-op. The 0.61.1
    # runtime gate (task 5.4) is recorded PASS. Per-launch rollback:
    # `OPENCODE_NONO=disabled opencode`; tighten to `enforced` after assessing
    # compatibility with `opencode-nono-audit`.
    defaultState = "audit";

    # This host uses the base catalog profiles (rendered by the module). The
    # state→profile mapping is enforced→opencode-managed, audit→opencode-audit,
    # review→opencode-review. Set explicitly to the module defaults so the
    # chosen mapping is legible at the host level; no host-specific profiles
    # are added here (that is the Shopify host's job, task 6.3).
    managedProfile = "opencode-managed";
    auditProfile = "opencode-audit";
    reviewProfile = "opencode-review";

    # Allow git config and deny gcloud on the audit + enforced profiles
    # (parity with the Shopify host). The base module sets each profile's
    # `filesystem.allow = lib.mkDefault opencodeDataPaths` (the seven opencode
    # data dirs), so a second `lib.mkDefault` here ties at priority 1000 and
    # the module system CONCATENATES the lists — preserving the base grants
    # rather than replacing them (a plain def / mkForce / mkAfter would drop
    # them). nono expands the $HOME literal at runtime.
    #
    # `.config/git` is a real grant here: unlike the Shopify audit profile,
    # neither personal profile allows $HOME/.config broadly, so only
    # .config/opencode (base) and .config/git (here) are reachable under
    # .config.
    #
    # The gcloud deny relies on nono's deny precedence: the deny list is
    # checked before any allow/group/workdir grant and blocks the path
    # regardless (on macOS nono emits Seatbelt deny rules even for a child of
    # an allowed parent). `filesystem.deny` has no base definition, so
    # lib.mkDefault just makes it an overridable host default. The review
    # profile is intentionally left untouched.
    profiles.opencode-audit.filesystem.allow = lib.mkDefault [ "$HOME/.config/git" ];
    profiles.opencode-audit.filesystem.deny = lib.mkDefault [ "$HOME/.config/gcloud" ];
    profiles.opencode-managed.filesystem.allow = lib.mkDefault [ "$HOME/.config/git" ];
    profiles.opencode-managed.filesystem.deny = lib.mkDefault [ "$HOME/.config/gcloud" ];
  };
}
