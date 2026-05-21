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
      # MCP hub health check — fail fast if obsidian memory tools aren't available.
      ''
        if ! /usr/bin/curl -sf --max-time 2 http://localhost:37373/api/health >/dev/null 2>&1; then
          echo "ERROR: MCP hub is not running. Obsidian memory tools are unavailable." >&2
          echo "Start it with: launchctl kickstart gui/$(id -u)/com.ravitemer.mcp-hub" >&2
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
      package = pkgs.symlinkJoin {
        name = "opencode-wrapped";
        paths = [ config.home.opencode.package ];
        nativeBuildInputs = [ pkgs.makeWrapper ];
        postBuild = ''
          wrapProgram $out/bin/opencode \
            --suffix PATH : ${lib.makeBinPath config.home.opencode.lspPackages} \
            --run '${lib.concatStringsSep "\n" config.home.opencode.wrapperCommands}'
        '';
      };
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
        nvim-tailor = config.home.opencode.agentWithCaveman ./agents/nvim-tailor.md;
        security-auditor = config.home.opencode.agentWithCaveman ./agents/security-auditor.md;
        vault-curator = config.home.opencode.agentWithCaveman ./agents/vault-curator.md;
        vault-synthesizer = config.home.opencode.agentWithCaveman ./agents/vault-synthesizer.md;
      };

      settings = {
        # Re-enable thinking output for Claude Opus 4.7, which omits it by default.
        # https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
        #
        # opencode 1.4.7+ auto-generates the low/medium/high/xhigh/max variants
        # with display=summarized for opus-4-7 through the Anthropic Messages API
        # (anomalyco/opencode#22833 + #22873). We only need the base options
        # override here, which applies when no variant is selected.
        provider.anthropic.models."claude-opus-4-7".options.thinking = {
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
          "${config.home.opencode.package}/bin/opencode"
          "--version"
        ];
        RunAtLoad = true;
        StandardOutPath = "${config.home.homeDirectory}/Library/Logs/opencode-prewarm.log";
        StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/opencode-prewarm-error.log";
      };
    };
  };
}
