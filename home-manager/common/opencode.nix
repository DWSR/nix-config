{
  pkgs,
  lib,
  config,
  ...
}:
let
  processFlowDiagramSkill = pkgs.fetchFromGitHub {
    owner = "Cocoon-AI";
    repo = "process-flow-diagram-generator";
    rev = "6e0c72a3b4b46f87ac01ed1291f646bf77beafb0";
    hash = "sha256-uKMCItuqK7JXeGeXvG3RiUg7xWLzlO93K3XMbVEn8ZI=";
  };
  agentmemory = config.programs.agentmemory;
  agentmemoryKeychainPath = "${config.home.homeDirectory}/Library/Keychains/login.keychain-db";
in
{
  options.home.opencode = {
    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.opencode-pinned;
      description = "Base opencode package. Wrapped with the commands in `wrapperCommands` automatically.";
    };
    basePackage = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      internal = true;
      default = config.home.opencode.package;
      description = ''
        Read-only alias for the UNWRAPPED opencode package (= `package`).
        The launcher seam (`opencode-nono`) and the login prewarm launchd
        agent reference this so they bypass the preflight/wrapper. Kept
        equal to `home.opencode.package` so the flake's turn-timestamp
        host check (flake.nix) keeps resolving the pinned base here.
      '';
    };
    preflightScript = lib.mkOption {
      type = lib.types.lines;
      readOnly = true;
      internal = true;
      default = lib.concatStringsSep "\n" config.home.opencode.wrapperCommands;
      description = ''
        Read-only joined `wrapperCommands` block. Exposed so the
        `opencode-nono` launcher can run the same preflight host-side
        (outside the sandbox) instead of inside the wrapper's `--run`.
      '';
    };
    lspPath = lib.mkOption {
      type = lib.types.str;
      readOnly = true;
      internal = true;
      default = lib.makeBinPath config.home.opencode.lspPackages;
      description = ''
        Read-only `makeBinPath` of `lspPackages`. The same PATH fragment
        the wrapper suffixes today; exposed so the launcher can suffix it
        onto PATH host-side with identical ordering.
      '';
    };
    finalPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.symlinkJoin {
        name = "opencode-wrapped";
        paths = [ config.home.opencode.package ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/opencode \
            --suffix PATH : ${config.home.opencode.lspPath} \
            --run ${lib.escapeShellArg config.home.opencode.preflightScript}
        '';
      };
      description = ''
        The package wired into `programs.opencode.package`. Default is
        today's preflight-INSIDE `symlinkJoin`+`wrapProgram` wrapper, so
        with no override runtime behavior is unchanged. The `opencode-nono`
        module overrides this with its outer preflight launcher. Default
        depends only on `package`/`lspPath`/`preflightScript` — never on
        itself — so there is no circular reference.
      '';
    };
    wrapperCommands = lib.mkOption {
      type = lib.types.listOf lib.types.lines;
      default = [ ];
      description = ''
        Shell snippets composed into the opencode wrapper's `--run` block,
        in module-import order. Host-specific modules append environment
        setup / preflight checks here instead of building their own
        intermediate symlinkJoin wrappers.
      '';
    };
    lspPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = [ ];
      description = ''
        Packages whose `bin/` directories are suffixed onto the opencode
        wrapper's PATH. Use this to pre-install LSP servers (and other
        tools) so opencode's built-in LSP integration resolves them via
        `which()` instead of auto-downloading them. Suffix (not prefix)
        so project-local / user-provided binaries still win when present.
      '';
    };
    enableCaveman = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Append the vendored caveman-lite output-style snippet
        (./opencode/caveman-lite.md) to each subagent's system prompt.
        Reduces filler/hedging in subagent output. Auto-clarity rules in
        the snippet preserve full prose for security warnings,
        destructive-action confirmations, and multi-step sequences where
        fragment ambiguity risks misread. Off by default so Shopify hosts
        do not inherit the style.

        Adapted from JuliusBrussee/caveman (MIT). See
        ./opencode/caveman-lite.md for the snippet and attribution.
      '';
    };
    agentWithCaveman = lib.mkOption {
      type = lib.types.unspecified;
      readOnly = true;
      internal = true;
      description = ''
        Function helper that takes a path to an agent .md file and
        returns either the path unchanged (when `enableCaveman` is
        false) or a concatenated string of the file body + the
        caveman-lite snippet (when true). Mirrors the previous local
        `withCaveman` let-binding so host configs can apply caveman to
        their own subagents alongside the common ones, without
        re-reading the snippet or duplicating the toggle check. Marked
        internal because the function value is implementation detail —
        callers see one of `lines | path` regardless of the
        `enableCaveman` setting, which is what `programs.opencode.agents`
        already accepts.
      '';
    };
  };

  config = {
    # Common explicit-only workflow for GitHub's native pull request Stack
    # objects. The skill uses GitHub MCP for remote Stack state and typed local
    # Stack MCP tools for supported worktree operations. The agent never
    # executes `gh stack`; narrowly targeted user-owned handoffs are reserved
    # for unavailable tools, unsupported operations, or explicit user
    # preference to run the CLI.
    xdg.configFile."opencode/skills/github-native-stacks" = {
      source = ./skills/github-native-stacks;
    };

    # Upstream skill for generating self-contained process flow diagrams.
    xdg.configFile."opencode/skills/process-flow-diagram" = {
      source = "${processFlowDiagramSkill}/process-flow-diagram";
    };

    # Define the agent-wrapping helper once (snippet is read once at
    # Nix-eval time) and reuse it from both this module's `agents` attrset
    # and any downstream host config that adds host-specific subagents.
    home.opencode.agentWithCaveman =
      let
        cavemanSnippet = builtins.readFile ./opencode/caveman-lite.md;
      in
      base:
      if config.home.opencode.enableCaveman then
        builtins.readFile base + "\n\n" + cavemanSnippet
      else
        base;

    home.opencode.wrapperCommands = [
      # Set opencode's working directory to the current git repo's top-level so
      # the project root (and, under the nono launcher, the mandatory
      # `--allow-cwd` grant) spans the whole repo regardless of which
      # subdirectory opencode was launched from. Outside a git repo,
      # `git rev-parse` fails and the existing cwd is kept unchanged. This runs
      # FIRST, host-side, in BOTH wrapper paths: the default preflight-inside
      # `wrapProgram --run` wrapper AND the opencode-nono launcher (which embeds
      # this joined preflight at scripts/opencode-nono-launcher.nix before the
      # `nono run --allow-cwd` exec), so it covers bare opencode and the
      # audit/enforced nono launches alike. Side effect: `settings.skills.paths`
      # `[ ".claude/skills" ]` below is cwd-relative, so it now resolves to the
      # repo-root `.claude/skills` instead of `<subdir>/.claude/skills`.
      #
      # git is referenced by store path (cf. `${pkgs.jq}/bin/jq` in the mcpproxy
      # probe) so it resolves regardless of PATH. `cd … || true` keeps the cd
      # non-fatal and satisfies shellcheck (SC2164) in the launcher's
      # writeShellApplication.
      ''
        opencode_git_root=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null) || opencode_git_root=""
        if [ -n "$opencode_git_root" ] && [ -d "$opencode_git_root" ]; then
          cd "$opencode_git_root" || true
        fi
      ''
      # mcpproxy preflight: verify the orchestrator is live before OpenCode
      # starts. The AgentMemory bearer check follows this snippet.
      #
      # Probe sequence:
      #   1. `GET http://127.0.0.1:8080/healthz` (no auth) checks mcpproxy
      #      liveness.
      #   2. The AgentMemory snippet below resolves its bearer from Keychain.
      #
      # Each mcpproxy failure includes the recovery hint
      # `launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy`.
      # The `opencode-prewarm` launchd agent below invokes the UNWRAPPED
      # `home.opencode.package` binary, so this preflight is bypassed at login.
      #
      # Quoting note: this snippet is composed into the opencode wrapper
      # via `wrapProgram ... --run STR`. The joined wrapperCommands value
      # is shell-escaped with `lib.escapeShellArg` before the builder shell
      # sees it, so apostrophes in snippet comments cannot break wrapper
      # composition (see the AgentMemory topic "mcp hub API surface and wrapper
      # quoting" and design.md L711-713). Use double quotes (with backslash-
      # escaped inner double quotes where needed) for runtime shell values.
      ''
        if ! /usr/bin/curl -sf --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
          echo "ERROR: mcpproxy unreachable: liveness probe to http://127.0.0.1:8080/healthz failed." >&2
          echo "Restart mcpproxy with: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
          exit 1
        fi
      ''
    ]
    # Resolve the AgentMemory bearer after mcpproxy liveness so the in-process
    # capture plugin and MCP shim share the managed runtime credential.
    ++ lib.optional agentmemory.enable ''
      agentmemory_secret=$(${pkgs.coreutils}/bin/timeout --kill-after=2s 5s /usr/bin/security find-generic-password -s mcpproxy -a ${lib.escapeShellArg agentmemory.bearerReference} -w ${lib.escapeShellArg agentmemoryKeychainPath} 2>/dev/null) || agentmemory_secret=""
      if [ -z "$agentmemory_secret" ]; then
        echo "ERROR: AgentMemory daemon preflight failed: bearer unavailable from macOS Keychain." >&2
        echo "Recover AgentMemory with: launchctl kickstart -k gui/$(id -u)/dev.dwsr.agentmemory" >&2
        exit 1
      fi
      export AGENTMEMORY_URL="http://127.0.0.1:${toString agentmemory.restPort}"
      export AGENTMEMORY_SECRET="$agentmemory_secret"
    ''
    ++ [
      # Enable the experimental `lsp` tool so the model can use the configured
      # LSP servers for goToDefinition / findReferences / hover / symbols / etc.
      # https://opencode.ai/docs/tools/#lsp-experimental
      ''
        export OPENCODE_EXPERIMENTAL_LSP_TOOL=true
      ''
      # Disable opencode's built-in auto-download / auto-install of LSP servers
      # (npm, `go install`, `gem install`, GitHub releases). The servers it
      # would otherwise fetch are provided via PATH from `lspPackages` below.
      # Exception: opencode's `typescript` LSP ignores this flag and always
      # hits its own npm cache — we override its `command` in `settings.lsp`.
      # https://opencode.ai/docs/lsp/#built-in
      ''
        export OPENCODE_DISABLE_LSP_DOWNLOAD=true
      ''
      # Stop opencode auto-discovering Claude Code skills under ~/.claude/skills
      # (a home read the nono sandbox denies; see the AgentMemory topic
      # "opencode nono sandbox"). The toggle drops `.claude`
      # from skill auto-discovery for BOTH the global ~/.claude scan AND the
      # project up-tree scan, so the project-local .claude/skills is re-added
      # explicitly via `settings.skills.paths` below — that path is cwd-relative,
      # resolving to $PROJECT_DIR/.claude/skills inside nono's --allow-cwd (no
      # home read). The editor/IDE auto-connect's ~/.claude/ide poll has no
      # opencode off-switch and is intentionally left to be sandbox-denied
      # (harmless: the readdir is caught). Env name from opencode's
      # effect/runtime-flags; reaches sandboxed opencode via the nono profiles'
      # allow_vars "OPENCODE_*" glob (home-manager/common/opencode-nono.nix).
      ''
        export OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=true
      ''
    ];

    # LSP servers made available to opencode via PATH. Map of opencode LSP id
    # → nixpkgs package:
    #   bash       → bash-language-server
    #   clangd     → clang-tools (provides `clangd`)
    #   eslint*    → vscode-langservers-extracted (provides `vscode-eslint-language-server`)
    #   gopls      → gopls
    #   nixd       → nixd
    #   pyright    → pyright (provides `pyright-langserver`)
    #   ruby-lsp   → rubocop  (opencode's `ruby-lsp` id actually spawns `rubocop --lsp`)
    #   rust       → rust-analyzer
    #   terraform  → terraform-ls
    #   typescript*→ typescript-language-server
    #   yaml-ls    → yaml-language-server
    # * Starred entries require a matching `settings.lsp.<id>.command`
    #   override below because opencode's built-in code path bypasses PATH.
    home.opencode.lspPackages = with pkgs; [
      bash-language-server
      clang-tools
      gopls
      nixd
      pyright
      rubocop
      rust-analyzer
      terraform-ls
      typescript-language-server
      vscode-langservers-extracted
      yaml-language-server
    ];

    programs.opencode = {
      enable = true;
      # Resolves to the launcher seam's `finalPackage`. Default is today's
      # preflight-inside wrapper; `opencode-nono` overrides `finalPackage`
      # with the outer launcher. See `home.opencode.finalPackage` above.
      package = config.home.opencode.finalPackage;
      # AGENTS.md is composed from three vendored chunks:
      #   1. ./agents-agentmemory.md — stock AgentMemory rules
      #   2. ./agents.md            — global non-memory rules + commit/time conventions
      #   3. ./agents-cc-sdd.md     — SDD preamble + cc-sdd-init bootstrap + the
      #                               kiro skills catalog + workflow summary
      # The upstream cc-sdd quickstart (pkgs.cc-sdd-skills/agents-md) is
      # intentionally NOT included — its slash-command catalogue duplicates
      # what each kiro-* SKILL.md frontmatter already exposes to opencode at
      # session start, and its "Skills Structure" block is now inlined
      # verbatim into ./agents-cc-sdd.md. See the AgentMemory topic
      # "agents md compression" for the rationale.
      context = lib.concatStringsSep "\n\n" [
        (builtins.readFile ./agents-agentmemory.md)
        (builtins.readFile ./agents.md)
        (builtins.readFile ./agents-cc-sdd.md)
      ];

      # Subagent prompts. When `home.opencode.enableCaveman = true`, the
      # vendored caveman-lite snippet is appended to each subagent's system
      # prompt at Nix-eval time. The helper is exposed as
      # `config.home.opencode.agentWithCaveman` so host configs can apply
      # the same wrapping to their own subagents (see
      # example). `programs.opencode.agents` accepts either a path or a
      # string of inlined content; the helper returns one or the other
      # based on the toggle.
      agents = {
        nix-pkg = config.home.opencode.agentWithCaveman ./agents/nix-pkg.md;
        kiro-spec-orchestrator = config.home.opencode.agentWithCaveman ./agents/kiro-spec-orchestrator.md;
        nvim-tailor = config.home.opencode.agentWithCaveman ./agents/nvim-tailor.md;
        security-auditor = config.home.opencode.agentWithCaveman ./agents/security-auditor.md;
      };

      settings = {
        # Permit subagent orchestration chains on both hosts. The upstream
        # default of 1 prevents subagents from launching other subagents.
        subagent_depth = 10;

        # Re-enable thinking output for Claude Opus 4.8, which omits it by default.
        # https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
        #
        # opencode 1.4.7+ auto-generates the low/medium/high/xhigh/max variants
        # with display=summarized for Opus through the Anthropic Messages API
        # (anomalyco/opencode#22833 + #22873). We only need the base options
        # override here, which applies when no variant is selected.
        provider.anthropic.models."claude-opus-4-8".options.thinking = {
          type = "adaptive";
          display = "summarized";
        };

        # Disable opencode's filesystem snapshot tracking. With snapshots
        # off, opencode no longer records per-message filesystem snapshots,
        # so undo/revert will not restore file changes — version control is
        # the sole rollback path. Schema: `snapshot` at
        # https://opencode.ai/config.json ("Defaults to true").
        snapshot = false;

        # Disable the update check/notice. The binary is pinned by the
        # `opencode` flake input and bumps happen through `nix flake update
        # opencode`, so the in-TUI notice is noise (and `opencode upgrade`
        # would replace the nix-managed binary). Schema: `autoupdate` at
        # https://opencode.ai/config.json ("Set to false to disable update
        # checks").
        autoupdate = false;

        # Disable opencode's built-in `title` and `summary` agents. Both
        # are hidden internal agents that run extra LLM calls (title on
        # every new session, summary on every compaction). We don't rely
        # on either: session titles aren't used in our workflow, and
        # AgentMemory preserves the context that
        # `summary` would otherwise regenerate. Schema: see `agent.*.disable`
        # at https://opencode.ai/config.json.
        agent.title.disable = true;
        agent.summary.disable = true;

        # Override the built-in `command` for LSPs whose opencode default
        # ignores PATH (and, for `typescript`, also ignores the
        # OPENCODE_DISABLE_LSP_DOWNLOAD flag):
        #   - `eslint`: opencode runs `node <cache>/vscode-eslint/eslintServer.js`
        #     from a GitHub-downloaded source tree. Point it at the
        #     standalone server shipped by `vscode-langservers-extracted`.
        #   - `typescript`: opencode always calls `Npm.which("typescript-language-server")`,
        #     which installs into its own npm cache regardless of the
        #     disable-download flag. Point it at the nixpkgs binary instead.
        lsp.eslint.command = [
          "vscode-eslint-language-server"
          "--stdio"
        ];
        lsp.typescript.command = [
          "typescript-language-server"
          "--stdio"
        ];

        # Re-add the project-local .claude/skills source dropped by
        # OPENCODE_DISABLE_CLAUDE_CODE_SKILLS (exported in wrapperCommands
        # above). A relative path is resolved against opencode's launch
        # directory, so this is $CWD/.claude/skills — inside nono's
        # --allow-cwd, so no ~/.claude read. Keeps project Claude Code skills
        # working while the global ~/.claude/skills auto-scan stays disabled.
        # Caveat: cwd-relative, so launching in a project SUBDIR resolves to
        # <subdir>/.claude/skills (not the worktree root); projects without
        # .claude/skills log a harmless "skill path not found" warn. Schema:
        # skills.paths at https://opencode.ai/config.json
        skills.paths = [ ".claude/skills" ];

        # Globally disallow the `git` and `gt` CLIs in the bash tool. Routine
        # version-control operations use git-mcp outside the sandbox, where
        # commit identity, signing, and ~/.gitconfig includes remain available.
        # Graphite is not exposed through mcpproxy. git-mcp is not a bash
        # command, so these denies do not affect it.
        #
        # Pattern semantics (https://opencode.ai/docs/permissions): bash rules
        # match the parsed command, last-match-wins. Nix serialises attrs keys
        # lexicographically, so the catch-all "*" (ASCII 0x2A) always sorts
        # before "git"/"git *"/"gt"/"gt *" and stays the FIRST (broadest)
        # rule. "git"/"gt" block the bare binaries; "git *"/"gt *" block every
        # subcommand. Native Stack workflows use GitHub MCP plus typed local
        # Stack MCP tools; CLI handoffs cover unsupported local operations.
        # Ordinary staging routes through git-mcp's git_add.
        #
        # Built-in agents (build/plan/general/explore) inherit this default;
        # custom agents with their own permission.bash block OVERRIDE it
        # because agent rules win. Those agents define their own narrower
        # command surface in frontmatter.
        #
        # Merges with each host's permission block (e.g. the Shopify host's
        # `permission."*" = "allow"`): `bash` is an explicit per-tool key, so
        # opencode uses this object for bash commands while the host's
        # top-level "*" still governs the other tools.
        permission.bash = {
          "*" = "allow";
          "git" = "deny";
          "git *" = "deny";
          "gt" = "deny";
          "gt *" = "deny";
        };

        # Allow tools to touch paths outside the launch cwd without the
        # per-access prompt (`external_directory` defaults to "ask"). The
        # enforcement boundary for outside-workspace access is nono's
        # sandbox (programs.opencode-nono): every managed launch runs under
        # a profile whose filesystem allow/deny list is the grant set, so
        # opencode's own prompt is redundant friction. Per-launch opt-outs
        # (`OPENCODE_NONO=disabled`) intentionally accept the exposed
        # surface. Schema: `permission.external_directory` at
        # https://opencode.ai/config.json. Lives here (not in
        # opencode-nono.nix) because that module's R5.5 contract forbids
        # opencode permission changes enabled-vs-disabled.
        permission.external_directory = "allow";
      };
    };

    # Pre-warm opencode at login: spawns one `opencode --version` against the
    # unwrapped binary so the bundled Bun runtime + node_modules graph land
    # in the macOS unified buffer cache before the user's first interactive
    # `opencode` invocation. Saves ~1s of cold-start tax on first run per
    # boot. Uses the unwrapped `home.opencode.package` to avoid the MCP-hub
    # health-check (which would block at login if mcp-hub launchd hasn't
    # come up yet).
    launchd.agents.opencode-prewarm = {
      enable = true;
      config = {
        Label = "io.opencode.prewarm";
        ProgramArguments = [
          "${config.home.opencode.basePackage}/bin/opencode"
          "--version"
        ];
        RunAtLoad = true;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/opencode-prewarm.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/opencode-prewarm-error.log";
      };
    };
  };
}
