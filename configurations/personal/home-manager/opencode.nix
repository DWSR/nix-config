{
  pkgs,
  lib,
  config,
  ...
}:
let
  architectureDiagramSkill = pkgs.fetchFromGitHub {
    owner = "Cocoon-AI";
    repo = "architecture-diagram-generator";
    rev = "4b9087d55268c79a935105439dbcd37b630fc3f3";
    hash = "sha256-r1ABUPDqT1SEe9QSEsA/GcN2J5PQmhuxlXMl4EBi9Ro=";
  };
in
{
  # Personal-only skill for generating self-contained architecture diagrams.
  xdg.configFile."opencode/skills/architecture-diagram" = {
    source = "${architectureDiagramSkill}/architecture-diagram";
  };

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
  programs.opencode.settings.mcp.mcpproxy = {
    type = "remote";
    url = "http://127.0.0.1:8080/mcp";
    enabled = true;
    # This longer ceiling also applies to unrelated calls through mcpproxy.
    timeout = 930000;
  };

  # oMLX local inference provider (OpenAI-compatible endpoint at
  # localhost:8000). The provider supports the OpenAI/Anthropic drop-in API
  # served by `omlx serve`; model IDs are the `~/.omlx/models/<org>/<name>`
  # directory names (or any per-model alias configured in the oMLX admin
  # dashboard). The API key is referenced by name and resolved from the
  # environment by the wrapper snippet below, which reads the `omlx-api-key`
  # Keychain entry (provisioned by mcp-secrets-activate from
  # secrets/mcp.personal.yaml) and exports OMLX_API_KEY. Same shape as the
  # integration oMLX generates in its admin dashboard
  # (omlx/integrations/opencode.py).
  #
  # Model set mirrors what is currently served on this host
  # (~/.omlx/models/lmstudio-community); add or drop entries as models are
  # downloaded/removed. Session model picker uses `omlx/<model-id>`.
  programs.opencode.settings.provider.omlx = {
    npm = "@ai-sdk/openai-compatible";
    name = "oMLX";
    options = {
      baseURL = "http://localhost:8000/v1";
      apiKey = "{env:OMLX_API_KEY}";
    };
    models = {
      "lmstudio-community/Qwen3.8-27B-MLX-4bit" = {
        name = "Qwen3.8 27B";
        modalities = {
          input = [ "text" ];
          output = [ "text" ];
        };
      };
      "lmstudio-community/Qwen3.5-9B-MLX-4bit" = {
        name = "Qwen3.5 9B";
        modalities = {
          input = [ "text" ];
          output = [ "text" ];
        };
      };
    };
  };

  # Export OMLX_API_KEY for the provider.omlx `{env:OMLX_API_KEY}` reference
  # above. Reads the Keychain entry written by mcp-secrets-activate
  # (`-s mcpproxy -a omlx-api-key`), mirroring the AgentMemory bearer
  # resolution in the common wrapper. NON-FATAL: on the first switch before
  # the sops bridge activation populates the Keychain, opencode still
  # starts and only the omlx provider misbehaves until the next switch.
  home.opencode.wrapperCommands = [
    ''
      omlx_api_key=$(${pkgs.coreutils}/bin/timeout --kill-after=2s 5s /usr/bin/security find-generic-password -s mcpproxy -a omlx-api-key -w ${lib.escapeShellArg "${config.home.homeDirectory}/Library/Keychains/login.keychain-db"} 2>/dev/null) || omlx_api_key=""
      if [ -n "$omlx_api_key" ]; then
        export OMLX_API_KEY="$omlx_api_key"
      else
        echo "WARNING: omlx api key unavailable from Keychain; the omlx provider will fail until the next switch provisions it." >&2
      fi
    ''
  ];

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

    # Allow the XDG cache root and deny gcloud on the audit + enforced
    # profiles (parity with the Shopify host). The base module sets each
    # profile's `filesystem.allow = lib.mkDefault opencodeDataPaths` (the
    # seven opencode data dirs), so a second `lib.mkDefault` here ties at
    # priority 1000 and the module system CONCATENATES the lists — preserving
    # the base grants rather than replacing them (a plain def / mkForce /
    # mkAfter would drop them). nono expands the $HOME literal at runtime.
    #
    # `.config/git` is deliberately NOT granted: agents run git through the
    # git-mcp base server (mcpproxy, outside the sandbox), and the base module
    # denies $HOME/.config/git on every profile. Neither personal profile
    # allows $HOME/.config broadly, so only .config/opencode (base) is
    # reachable under .config. `.cache` (XDG cache root) lets sandboxed tooling
    # — nix eval, prek pre-commit hooks — write their caches; the
    # user_caches_macos group covers ~/Library/Caches, not ~/.cache.
    #
    # The gcloud deny relies on nono's deny precedence: the deny list is
    # checked before any allow/group/workdir grant and blocks the path
    # regardless (on macOS nono emits Seatbelt deny rules even for a child of
    # an allowed parent). The base module's `gitConfigDenyPaths`
    # ($HOME/.config/git) CONCATENATES with this host deny (both lib.mkDefault).
    # This host config adds no host-specific FILESYSTEM grants to the review
    # profile (the base module still denies $HOME/.config/git there too); the
    # only review-profile delta is the omlx loopback port below.
    profiles.opencode-audit.filesystem.allow = lib.mkDefault [
      "$HOME/.cache"
    ];
    # macOS Core Foundation reads ~/.CFUserTextEncoding at startup to resolve
    # the default text encoding/locale. It is a single FILE, so it must be a
    # read_file grant: nono's filesystem.allow/read/write are directory-only
    # and reject a regular-file path at `nono run` parse time ("is not a
    # directory"). Read-only is least privilege — CF only reads the file.
    profiles.opencode-audit.filesystem.readFile = lib.mkDefault [
      "$HOME/.CFUserTextEncoding"
    ];
    profiles.opencode-audit.filesystem.deny = lib.mkDefault [
      "$HOME/.config/gcloud"
      # Disallow the `date` command (agents read time via the `time` MCP
      # server). /bin/date is macOS's only `date` (no coreutils on PATH), so
      # denying it blocks the command under nono's Seatbelt deny precedence.
      "/bin/date"
    ];
    # omlx provider reaches the local inference server (omlx serve) on
    # loopback :8000, same reason mcpproxy's :8080 is granted in the base
    # module. lib.mkDefault ties at priority 1000 with the base list and
    # concatenates, preserving the mcpproxy + agentmemory grants.
    profiles.opencode-audit.network.openPort = lib.mkDefault [ 8000 ];
    profiles.opencode-managed.filesystem.allow = lib.mkDefault [
      "$HOME/.cache"
    ];
    # See the audit profile's readFile note above — single-file read grant for
    # the CoreFoundation text-encoding file (directory-only allow rejects it).
    profiles.opencode-managed.filesystem.readFile = lib.mkDefault [
      "$HOME/.CFUserTextEncoding"
    ];
    profiles.opencode-managed.filesystem.deny = lib.mkDefault [
      "$HOME/.config/gcloud"
      "/bin/date"
    ];
    # See the audit profile's openPort note — omlx on loopback :8000.
    profiles.opencode-managed.network.openPort = lib.mkDefault [ 8000 ];
    # Review profile also reaches omlx on loopback :8000 (like :8080 for
    # mcpproxy in the base module), so a read-only review session can still
    # drive the local model.
    profiles.opencode-review.network.openPort = lib.mkDefault [ 8000 ];
  };
}
