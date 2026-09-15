{
  pkgs,
  lib,
  config,
  quickArchDiagramsSource,
  ...
}:
let
  rtkUsageTag =
    if config.programs.opencode-rtk.enable then
      config.programs.opencode-rtk.usageTag
    else
      "rtk:disabled";

  proxyHeader = {
    X-Shopify-Session-Affinity-Header = "opencode-session-id";
    opencode-session-id = "{env:OPENCODE_SESSION_ID}";
    Shopify-Usage-Tag = builtins.toJSON [
      "opencode_cli"
      "{env:OPENCODE_SESSION_ID}"
      rtkUsageTag
    ];
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
  home.opencode.memoryBackend = "agentmemory";

  # The Stylix opencode target (enabled in home-manager/common/stylix.nix)
  # now owns the TUI theme: it sets programs.opencode.tui.theme = "stylix"
  # plus themes.stylix and renders opencode/tui.json itself. The previous raw
  # xdg.configFile."opencode/tui.json" write would collide with that
  # HM-generated file, so it is removed. The host's scroll_acceleration
  # setting is preserved by moving it into the structured option.
  programs.opencode.tui.scroll_acceleration.enabled = true;

  # Shopify-only skills, co-installed alongside the cc-sdd kiro-* skills
  # under ~/.config/opencode/skills/ per the pattern documented in
  # home-manager/common/cc-sdd.nix lines 64-68.
  xdg.configFile."opencode/skills/graphite-pitfalls" = {
    source = ./skills/graphite-pitfalls;
  };

  xdg.configFile."opencode/skills/create-yb-fix-pr" = {
    source = ./skills/create-yb-fix-pr;
  };

  xdg.configFile."opencode/skills/quick" = {
    source = pkgs.quick-skills;
  };

  xdg.configFile."opencode/skills/validate-yb-issue" = {
    source = ./skills/validate-yb-issue;
  };

  # Private Shopify Playground skill, exposed under the requested OpenCode
  # name while retaining the upstream skill directory and bundled publisher.
  xdg.configFile."opencode/skills/quick-arch-diagrams" = {
    source = "${quickArchDiagramsSource}/skill";
  };

  # Apply the vendored caveman-lite output style to every common subagent
  # (nix-pkg, nvim-tailor, security-auditor, and Shopify agents). The
  # withCaveman helper in
  # home-manager/common/opencode.nix appends ./opencode/caveman-lite.md to
  # each agent's system prompt at Nix-eval time. Drops filler / hedging /
  # pleasantries while preserving code, paths, identifiers, and error
  # strings byte-for-byte — net win on token usage during SDD-heavy
  # workflows (kiro-impl dispatch chains in particular). Off-by-default
  # was a deliberate Shopify-host carve-out; user has opted in.
  home.opencode.enableCaveman = true;

  # Shopify-specific runtime env for opencode — fetches API key + proxy base
  # from `devx llm-gateway` on every invocation, with a hard timeout so an
  # unavailable gateway cannot hang before the TUI appears, and mints a
  # per-invocation session id used by the provider headers for sticky routing.
  # Appended to the common opencode wrapper (see home-manager/common/opencode.nix)
  # rather than building a separate symlinkJoin overlay package.
  home.opencode.wrapperCommands = [
    ''
      OPENCODE_API_KEY="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --key 2>/dev/null)" || {
        echo "Error: Failed to get OPENCODE_API_KEY from devx llm-gateway print-token --key within 15 seconds" >&2
        exit 1
      }
      export OPENCODE_API_KEY

      DEFAULT_PROXY_BASE="$(${pkgs.coreutils}/bin/timeout --kill-after=2s 15s devx llm-gateway print-token --base 2>/dev/null)" || {
        echo "Error: Failed to get DEFAULT_PROXY_BASE from devx llm-gateway print-token --base within 15 seconds" >&2
        exit 1
      }
      export DEFAULT_PROXY_BASE

      export OPENCODE_SESSION_ID="$(uuidgen)"
    ''
  ];

  # opencode-nono sandbox rollout posture for this host (R3.1). The module
  # (home-manager/common/opencode-nono.nix) is enabled by the common
  # default.nix; here we set the Shopify host's rollout intent.
  programs.opencode-nono = {
    # Rollout state `audit`: the outer launcher
    # (scripts/opencode-nono-launcher.nix) relocates the devx + mcpproxy
    # preflight host-side OUTSIDE nono, then execs
    # `nono run --profile opencode-audit --allow-cwd -- opencode`. The audit
    # profile is permissive so OpenCode + plugins (and the devx-minted
    # OPENCODE_API_KEY / DEFAULT_PROXY_BASE admitted via allow_vars) work
    # cleanly and any sandbox-induced failure surfaces as a real error. The
    # 0.61.1 runtime gate (task 5.4) is recorded PASS. Per-launch rollback:
    # `OPENCODE_NONO=disabled opencode`; tighten to `enforced` after assessing
    # compatibility.
    defaultState = "audit";

    # Host-specific profile labels (R2.3). Per-leaf mkDefault in the base
    # module (home-manager/common/opencode-nono.nix) lets these override
    # `meta.description` alone while every other base leaf (groups,
    # filesystem, network, allow_vars, meta.name) is retained. The labels
    # document this host's devx LLM-gateway credential ACCESS — env var
    # NAMES only, never token values (R2.5/R4.5). OPENCODE_API_KEY and
    # DEFAULT_PROXY_BASE are admitted to the sandbox via allow_vars (R4.2).
    profiles.opencode-managed.meta.description =
      "Enforced sandbox profile for managed OpenCode launches. "
      + "Host: ShopifyLaptop — admits the devx LLM-gateway credentials "
      + "(OPENCODE_API_KEY, DEFAULT_PROXY_BASE) via allow_vars for provider access.";
    profiles.opencode-audit.meta.description =
      "Compatibility-audit sandbox profile for managed OpenCode. "
      + "Host: ShopifyLaptop — devx LLM-gateway credential access "
      + "(OPENCODE_API_KEY, DEFAULT_PROXY_BASE) admitted via allow_vars.";

    # Extend (NOT replace) the audit profile's filesystem.allow with eight
    # Shopify-host-specific paths. The base leaf is `lib.mkDefault
    # opencodeDataPaths` (home-manager/common/opencode-nono.nix), so a second
    # `lib.mkDefault` here ties at the same override priority (1000) and the
    # module system CONCATENATES the two lists. A plain (priority-100)
    # definition — or mkForce / mkAfter — would instead WIN outright and drop
    # the seven base opencode data-dir grants, breaking OpenCode's access to
    # its own state. Paths are literals nono uses verbatim ($HOME/$TMPDIR
    # expanded at runtime; absolute paths like /opt/rubies passed through
    # unchanged):
    #   - .local/state/tec                       : tec dev-env state (whole dir;
    #                                              subsumes profiles/base/current)
    #   - .dev/userprofile, .dev/gem             : Shopify .dev toolchain dirs
    #   - .config                                : XDG config root (supersets
    #                                              the base .config/opencode)
    #   - src/github.com/yugabyte/yugabyte-db    : upstream YugabyteDB fork
    #                                              checkout — read by the
    #                                              yb-sleuth agent (and YB memory
    #                                              citations) when it is not the
    #                                              launch CWD.
    #   - .gem                                   : user RubyGems home (gem
    #                                              install/exec under the Ruby
    #                                              toolchain)
    #   - /opt/rubies                            : chruby-managed Ruby installs
    #                                              (absolute path; Shopify dev
    #                                              Ruby versions)
    #   - .cache                                 : XDG cache root — lets
    #                                              sandboxed tooling (nix eval,
    #                                              prek pre-commit hooks) write
    #                                              their caches; the
    #                                              user_caches_macos group
    #                                              covers ~/Library/Caches, not
    #                                              ~/.cache
    profiles.opencode-audit.filesystem.allow = lib.mkDefault [
      "$HOME/.local/state/tec"
      "$HOME/.dev/userprofile"
      "$HOME/.dev/gem"
      "$HOME/.config"
      "$HOME/src/github.com/yugabyte/yugabyte-db"
      "$HOME/.gem"
      "/opt/rubies"
      "$HOME/.cache"
    ];

    # macOS Core Foundation reads ~/.CFUserTextEncoding at startup to resolve
    # the default text encoding/locale. It is a single FILE, so it must be a
    # read_file grant: nono's filesystem.allow/read/write are directory-only
    # and reject a regular-file path at `nono run` parse time ("is not a
    # directory"). Read-only is least privilege — CF only reads the file. (The
    # broad $HOME/.config allow above does NOT cover it: the file lives in
    # $HOME, not under .config.)
    profiles.opencode-audit.filesystem.readFile = lib.mkDefault [
      "$HOME/.CFUserTextEncoding"
    ];

    # Deny ~/.config/gcloud on the audit profile. nono's deny list is checked
    # before any allow/group/workdir grant and overrides it (guide: "denied
    # paths are blocked regardless of platform"; on macOS nono emits Seatbelt
    # deny rules that protect a denied child even when its parent is allowed).
    # That precedence is what makes this effective despite the broad
    # $HOME/.config allow above — gcloud config/credentials stay out of the
    # sandbox. The base module now defines `gitConfigDenyPaths`
    # ($HOME/.config/git, also under the broad .config allow), and this host
    # leaf ties at the same lib.mkDefault priority (1000), so the two deny
    # lists CONCATENATE — the resolved deny is
    # [$HOME/.config/git, $HOME/.config/gcloud, /bin/date].
    profiles.opencode-audit.filesystem.deny = lib.mkDefault [
      "$HOME/.config/gcloud"
      # Disallow the `date` command (agents read time via the `time` MCP
      # server instead). /bin/date is macOS's only `date` — coreutils is not
      # on the global PATH — so denying it blocks the command under nono's
      # Seatbelt deny precedence (same as the gcloud deny above).
      "/bin/date"
    ];

    # Mirror the YugabyteDB fork grant, the Ruby toolchain paths
    # ($HOME/.gem, /opt/rubies), and the XDG cache root ($HOME/.cache) onto
    # the enforced profile so they all survive the eventual
    # `defaultState = "enforced"` tightening (this host is on `audit` today).
    # Same concatenation contract as the audit block above: the base
    # `opencode-managed.filesystem.allow` is `lib.mkDefault opencodeDataPaths`,
    # so this second `lib.mkDefault` ties at priority 1000 and the two lists
    # CONCATENATE, preserving the seven base opencode data-dir grants. The
    # audit-only paths (tec/.dev/.config) are deliberately NOT mirrored.
    # `.config/git` is NOT granted here: git runs through the git-mcp base
    # server, and the base module denies $HOME/.config/git on every profile.
    profiles.opencode-managed.filesystem.allow = lib.mkDefault [
      "$HOME/src/github.com/yugabyte/yugabyte-db"
      "$HOME/.gem"
      "/opt/rubies"
      "$HOME/.cache"
    ];

    # See the audit profile's readFile note above — single-file read grant for
    # the CoreFoundation text-encoding file (directory-only allow rejects it).
    profiles.opencode-managed.filesystem.readFile = lib.mkDefault [
      "$HOME/.CFUserTextEncoding"
    ];

    # Deny ~/.config/gcloud on the enforced profile too (see the audit deny
    # above for the precedence rationale). Defense-in-depth: the enforced
    # profile does not allow $HOME/.config broadly, but the deny guarantees
    # gcloud stays inaccessible regardless of any group-granted or future
    # allow. This host leaf CONCATENATES with the base module's
    # `gitConfigDenyPaths` ($HOME/.config/git), so the resolved deny is
    # [$HOME/.config/git, $HOME/.config/gcloud, /bin/date].
    profiles.opencode-managed.filesystem.deny = lib.mkDefault [
      "$HOME/.config/gcloud"
      # Disallow `date` on the enforced profile too (see the audit deny above).
      "/bin/date"
    ];
  };

  programs.opencode.commands = {
    make-stack-green = ./commands/make-stack-green.md;
    restack = ./commands/restack.md;
    upgrade-environment = ./commands/upgrade-environment.md;
    validate-yb-backlog = ./commands/validate-yb-backlog.md;
  };

  # Shopify-specific agents are wrapped via the shared
  # `home.opencode.agentWithCaveman` helper from
  # home-manager/common/opencode.nix so they inherit the same caveman-lite
  # snippet (or skip it) in lock-step with the common subagents whenever
  # `home.opencode.enableCaveman` flips.
  programs.opencode.agents = {
    binks-reviewer = config.home.opencode.agentWithCaveman ./agents/binks-reviewer.md;
    stack-captain = config.home.opencode.agentWithCaveman ./agents/stack-captain.md;
    stack-status-sweeper = config.home.opencode.agentWithCaveman ./agents/stack-status-sweeper.md;
    ci-log-sleuth = config.home.opencode.agentWithCaveman ./agents/ci-log-sleuth.md;
    bot-thread-triager = config.home.opencode.agentWithCaveman ./agents/bot-thread-triager.md;
    stack-preflight-auditor = config.home.opencode.agentWithCaveman ./agents/stack-preflight-auditor.md;
    stack-fix-reviewer = config.home.opencode.agentWithCaveman ./agents/stack-fix-reviewer.md;
    binks-overrider = config.home.opencode.agentWithCaveman ./agents/binks-overrider.md;
    yb-sleuth = config.home.opencode.agentWithCaveman ./agents/yb-sleuth.md;
    yb-fix-pr-author = config.home.opencode.agentWithCaveman ./agents/yb-fix-pr-author.md;
    yb-backlog-validator = config.home.opencode.agentWithCaveman ./agents/yb-backlog-validator.md;
    yb-issue-oneshot = config.home.opencode.agentWithCaveman ./agents/yb-issue-oneshot.md;
    yb-issue-validator = config.home.opencode.agentWithCaveman ./agents/yb-issue-validator.md;
  };

  programs.opencode.settings = {
    model = "openai/gpt-5.6";
    agent.build = {
      model = "openai/gpt-5.6";
      variant = "xhigh";
    };
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
    # bash `git` and `gt` are denied globally in home-manager/common/opencode.nix.
    # That `permission.bash` sub-key deep-merges in here and wins for bash
    # commands despite the top-level "*" allow below.
    permission = {
      "*" = "allow";
      "doom_loop" = "allow";
    };
    mcp = {
      mcpproxy = {
        type = "remote";
        url = "http://127.0.0.1:8080/mcp";
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
