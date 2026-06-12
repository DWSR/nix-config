{
  pkgs,
  lib,
  config,
  ...
}:
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
      # mcpproxy preflight: verify the orchestrator itself is up and the
      # obsidian upstream is connected before opencode starts. Replaces
      # the pre-migration mcp-orchestrator health probe
      # (mcpproxy-migration spec, R8.1, R8.2, R8.4; design.md §Domain E).
      # The cavemem per-upstream probe lives in
      # `home-manager/common/cavemem.nix` and appends after this snippet
      # via HM list-merge on `wrapperCommands`.
      #
      # Probe sequence:
      #   1. Read mcpproxy's API key from the macOS Keychain via
      #      `security find-generic-password -s mcpproxy -a
      #      mcpproxy-api-key -w`. The keychain entry is provisioned by
      #      the SOPS bridge during home-manager activation. A missing
      #      key fails with a specific stderr message BEFORE attempting
      #      curl so an operator distinguishes a keychain problem from
      #      a connectivity problem.
      #   2. `GET http://127.0.0.1:8080/healthz` (no auth) — mcpproxy
      #      liveness probe (R8.1). Failure exits 1 naming "mcpproxy"
      #      as the failing component.
      #   3. `GET http://127.0.0.1:8080/api/v1/servers/obsidian` with
      #      `X-API-Key` header. Greps the JSON body for an upstream
      #      connection state matching either `"connected":true` or
      #      `"status":"connected"` (mcpproxy v0.33.1 emits one of these
      #      shapes depending on stdio state). Failure exits 1 naming
      #      "obsidian" as the failing component (R8.2).
      #
      # Every failure stderr message includes the recovery hint
      # `launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy`
      # (R8.4) — the new mcpproxy launchd label.
      #
      # The `opencode-prewarm` launchd agent below (L237) invokes the
      # UNWRAPPED `home.opencode.package` binary, so this preflight is
      # bypassed at login (R8.5).
      #
      # Quoting note: this snippet is composed into the opencode wrapper
      # via `wrapProgram ... --run STR`. The joined wrapperCommands value
      # is shell-escaped with `lib.escapeShellArg` before the builder shell
      # sees it, so apostrophes in snippet comments cannot break wrapper
      # composition (see
      # memories/2026-05-14-mcp-hub-api-surface-and-wrapper-quoting.md
      # and design.md L711-713). Use double quotes (with backslash-
      # escaped inner double quotes where needed) for runtime shell values.
      ''
        mcpproxy_api_key=$(/usr/bin/security find-generic-password -s mcpproxy -a mcpproxy-api-key -w 2>/dev/null) || mcpproxy_api_key=""
        if [ -z "$mcpproxy_api_key" ]; then
          echo "ERROR: mcpproxy unreachable: mcpproxy API key missing from macOS Keychain (service=mcpproxy, account=mcpproxy-api-key)." >&2
          echo "Restart mcpproxy with: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
          exit 1
        fi
        if ! /usr/bin/curl -sf --max-time 2 http://127.0.0.1:8080/healthz >/dev/null 2>&1; then
          echo "ERROR: mcpproxy unreachable: liveness probe to http://127.0.0.1:8080/healthz failed." >&2
          echo "Restart mcpproxy with: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
          exit 1
        fi
        # mcpproxy v0.33.1 exposes per-upstream state only on the
        # collection endpoint GET /api/v1/servers (the documented
        # /api/v1/servers/{id} path only supports DELETE/PATCH, not
        # GET). Fetch the whole list and filter for the obsidian entry.
        servers_json=$(/usr/bin/curl -sf --max-time 2 -H "X-API-Key: $mcpproxy_api_key" http://127.0.0.1:8080/api/v1/servers 2>/dev/null) || servers_json=""
        if ! printf "%s" "$servers_json" | ${pkgs.jq}/bin/jq -e ".data.servers[] | select(.name == \"obsidian\") | select(.connected == true)" >/dev/null 2>&1; then
          echo "ERROR: obsidian MCP server not connected via mcpproxy." >&2
          echo "Restart mcpproxy with: launchctl kickstart gui/$(id -u)/com.smart-mcp-proxy.mcpproxy" >&2
          exit 1
        fi
      ''
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
      # (a home read the nono sandbox denies; see
      # memories/2026-06-02-opencode-nono-sandbox.md). The toggle drops `.claude`
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
      # AGENTS.md is composed from two vendored chunks:
      #   1. ./agents.md            — Obsidian memory system + commit conventions
      #   2. ./agents-cc-sdd.md     — SDD preamble + cc-sdd-init bootstrap +
      #                               two-memory-system distinction + the kiro
      #                               skills catalog + workflow summary
      # The upstream cc-sdd quickstart (pkgs.cc-sdd-skills/agents-md) is
      # intentionally NOT included — its slash-command catalogue duplicates
      # what each kiro-* SKILL.md frontmatter already exposes to opencode at
      # session start, and its "Skills Structure" block is now inlined
      # verbatim into ./agents-cc-sdd.md. See
      # memories/2026-05-20-agents-md-compression.md for the rationale.
      # Hosts that need to layer on more guidance (e.g. Shopify's Graphite
      # addendum) override this with lib.mkForce, prepending the same chunks.
      rules = lib.concatStringsSep "\n\n" [
        (builtins.readFile ./agents.md)
        (builtins.readFile ./agents-cc-sdd.md)
      ];

      # Subagent prompts. When `home.opencode.enableCaveman = true`, the
      # vendored caveman-lite snippet is appended to each subagent's system
      # prompt at Nix-eval time. The helper is exposed as
      # `config.home.opencode.agentWithCaveman` so host configs can apply
      # the same wrapping to their own subagents (see
      # configurations/shopify/home-manager/opencode.nix for the live
      # example). `programs.opencode.agents` accepts either a path or a
      # string of inlined content; the helper returns one or the other
      # based on the toggle.
      agents = {
        nix-pkg = config.home.opencode.agentWithCaveman ./agents/nix-pkg.md;
        kiro-spec-orchestrator = config.home.opencode.agentWithCaveman ./agents/kiro-spec-orchestrator.md;
        nvim-tailor = config.home.opencode.agentWithCaveman ./agents/nvim-tailor.md;
        security-auditor = config.home.opencode.agentWithCaveman ./agents/security-auditor.md;
        vault-curator = config.home.opencode.agentWithCaveman ./agents/vault-curator.md;
        vault-synthesizer = config.home.opencode.agentWithCaveman ./agents/vault-synthesizer.md;
      };

      settings = {
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

        # Disable opencode's built-in `title` and `summary` agents. Both
        # are hidden internal agents that run extra LLM calls (title on
        # every new session, summary on every compaction). We don't rely
        # on either: session titles aren't used in our workflow, and
        # cavemem's ambient capture already preserves the context that
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
