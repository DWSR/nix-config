{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-25.11-darwin";
    nixpkgs-unstable.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    op-shell-plugins = {
      url = "github:1Password/shell-plugins";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixneovimplugins = {
      url = "github:NixNeovim/NixNeovimPlugins";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    fenix = {
      url = "github:nix-community/fenix/0b88bfd10f819d000d35d296debe283db89b623b";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nix-index-database = {
      url = "github:nix-community/nix-index-database";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    nixvim = {
      url = "github:nix-community/nixvim/nixos-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-25.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    homebrew = {
      url = "github:zhaofengli/nix-homebrew";
    };

    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };

    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };

    homebrew-bundle = {
      url = "github:homebrew/homebrew-bundle";
      flake = false;
    };

    homebrew-deskflow = {
      url = "github:deskflow/homebrew-tap";
      flake = false;
    };

    homebrew-unf = {
      url = "github:cyrusradfar/homebrew-unf";
      flake = false;
    };

    homebrew-whatcable = {
      url = "github:darrylmorley/homebrew-whatcable";
      flake = false;
    };

    color-schemes = {
      url = "github:mbadolato/iTerm2-Color-Schemes";
      flake = false;
    };

    git-issue-tracker = {
      url = "github:nnunley/git-issue-tracker";
      flake = false;
    };

    git-hooks = {
      url = "github:cachix/git-hooks.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    treefmt-nix = {
      url = "github:numtide/treefmt-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    sops-nix = {
      url = "github:Mic92/sops-nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

  };

  outputs =
    {
      self,
      nixpkgs,
      ...
    }@inputs:
    let
      inherit (self) outputs;

      systems = [
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;

      treefmtEval = forAllSystems (
        system:
        inputs.treefmt-nix.lib.evalModule nixpkgs.legacyPackages.${system} {
          projectRootFile = "flake.nix";
          programs.nixfmt.enable = true;
        }
      );
    in
    {
      formatter = forAllSystems (system: treefmtEval.${system}.config.build.wrapper);

      apps = forAllSystems (
        system:
        let
          # mcp-sync-from-1password depends on `_1password-cli`, which is
          # unfree-licensed. The legacyPackages set ships with the
          # default upstream config (no allowUnfree), so importing
          # nixpkgs explicitly with `config.allowUnfree = true` is
          # required for the script's derivation to evaluate. The
          # darwinConfigurations already do this via
          # `configurations/common-darwin/default.nix`'s `nixpkgs.config`
          # block; flake-app context must opt in separately.
          #
          # Custom overlays are applied so `pkgs.rtk` (defined in
          # overlays/misc.nix and consumed by the rtk-opencode-validate
          # script + Home Manager modules) is reachable from app
          # bindings without re-importing nixpkgs at the call site.
          pkgs = import nixpkgs {
            inherit system;
            config.allowUnfree = true;
            overlays = [ outputs.overlays.custom-packages ];
          };
          gitCacheClone = pkgs.callPackage ./scripts/git-clone-isolation.nix { };
        in
        {
          git-cache-clone = {
            type = "app";
            program = "${gitCacheClone}/bin/git-cache-clone";
          };
          git-clone-isolation = {
            type = "app";
            program = "${gitCacheClone}/bin/git-cache-clone";
          };
          bump-shopify-taps = {
            type = "app";
            program = "${import ./scripts/bump-shopify-taps.nix { inherit pkgs; }}/bin/bump-shopify-taps";
          };
          mcp-sync-from-1password = {
            type = "app";
            program = "${
              import ./scripts/mcp-sync-from-1password.nix { inherit pkgs; }
            }/bin/mcp-sync-from-1password";
          };
          mcp-verify-secrets = {
            type = "app";
            program = "${import ./scripts/mcp-verify-secrets.nix { inherit pkgs; }}/bin/mcp-verify-secrets";
          };
          # Phase B operator validator for the rtk-install spec (task 6.1).
          # The script discovers the rendered RTK metadata + plugin under
          # XDG_CONFIG_HOME, runs the smoke verifier, and drives a before/
          # after opencode-cost-report comparison for the Bash-tool
          # attribution measurement. See scripts/rtk-opencode-validate.nix
          # for the subcommand contract.
          #
          # `pkgs.rtk` is overlay-provided; the two script derivations are
          # invoked via callPackage from this build (mirrors the Home
          # Manager modules at `home-manager/common/opencode-rtk.nix:92`
          # and `home-manager/common/opencode-cost-diagnosis.nix:60`).
          rtk-opencode-validate = {
            type = "app";
            program = "${
              pkgs.callPackage ./scripts/rtk-opencode-validate.nix {
                rtk-opencode-smoke-test = pkgs.callPackage ./scripts/rtk-opencode-smoke-test.nix { };
                opencode-cost-report = pkgs.callPackage ./scripts/opencode-cost-report.nix { };
              }
            }/bin/rtk-opencode-validate";
          };
          # Read-only OpenCode tool-usage audit CLI (opencode-nono-audit
          # spec). `pkgs` here carries the custom-packages overlay, which
          # provides `opencode-cost-diagnosis-deps` (the NODE_PATH tree the
          # wrapper resolves better-sqlite3 against) via callPackage
          # auto-resolution — mirrors rtk-opencode-validate above and the
          # HM module at home-manager/common/opencode-nono-audit.nix.
          opencode-nono-audit = {
            type = "app";
            program = "${pkgs.callPackage ./scripts/opencode-nono-audit.nix { }}/bin/opencode-nono-audit";
          };
          # Profile-validation + launch-contract verifier (opencode-nono
          # spec, Task 5.1). `pkgs.nono` is overlay-provided and auto-resolves
          # into the script's `nono` callPackage param, so validation runs
          # against the same pinned nono the host provisions (R7.5).
          opencode-nono-validate = {
            type = "app";
            program = "${pkgs.callPackage ./scripts/opencode-nono-validate.nix { }}/bin/opencode-nono-validate";
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          # Import nixpkgs WITH the overlay chain used by host configs so
          # package-level checks can evaluate custom packages that depend on
          # `pkgs.unstable` (for example `pkgs.opencode-pinned`) without a
          # switched host.
          pkgs = import nixpkgs {
            inherit system;
            overlays = [
              outputs.overlays.unstable-packages
              outputs.overlays.custom-packages
            ];
          };
          gitCacheClone = pkgs.callPackage ./scripts/git-clone-isolation.nix { };

          opencodeTurnTimestampHosts = [
            "ShopifyLaptop"
            "Brandons-MacBook-Pro"
          ];

          opencodeTurnTimestampHostReport =
            let
              expectedPackagePath = builtins.unsafeDiscardStringContext "${pkgs.opencode-pinned}";
            in
            pkgs.lib.concatMapStringsSep "\n" (
              hostName:
              let
                hmConfig = self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama;
                actualPackagePath = builtins.unsafeDiscardStringContext "${hmConfig.home.opencode.package}";
                # Under the opencode-nono launcher topology,
                # `programs.opencode.package` is the `opencode` launcher
                # (a writeShellApplication), not a symlinkJoin — it has no
                # `.paths`, and execs `${basePackage}/bin/opencode` by store
                # path. So the pinned-opencode guarantee is verified via
                # `home.opencode.basePackage` (the bare binary the launcher
                # execs AND the disabled wrapper wraps), a topology-
                # independent invariant that holds for both the launcher and
                # the legacy symlinkJoin.
                basePackagePath = builtins.unsafeDiscardStringContext "${hmConfig.home.opencode.basePackage}";
                wiredPackageName = hmConfig.programs.opencode.package.name or "";
              in
              assert pkgs.lib.assertMsg (actualPackagePath == expectedPackagePath)
                "opencode-turn-timestamps host package mismatch for ${hostName}: expected home.opencode.package to resolve to ${expectedPackagePath}, got ${actualPackagePath}";
              assert pkgs.lib.assertMsg (basePackagePath == expectedPackagePath)
                "opencode-turn-timestamps host base-package mismatch for ${hostName}: expected home.opencode.basePackage to resolve to ${expectedPackagePath}, got ${basePackagePath}";
              "${hostName}: home.opencode.package=${actualPackagePath}; home.opencode.basePackage=${basePackagePath}; programs.opencode.package.name=${wiredPackageName}"
            ) opencodeTurnTimestampHosts;

          # Disabled-path equivalence gate (opencode-nono-sandbox spec, task
          # 1.2 / requirement 1.3; design "Preflight Launcher Seam →
          # Implementation Notes" and "Testing Strategy → Unit Tests"
          # disabled-path equivalence bullet). The gate proves the seam
          # DEFAULT (opencode-nono module DISABLED) is exactly today's
          # `opencode-wrapped` wrapper. Since v1 now ships the module
          # ENABLED (home-manager/common/default.nix), the live host config's
          # `programs.opencode.package` is the launcher, not the wrapper — so
          # the gate evaluates a module-DISABLED VARIANT via `extendModules`
          # (`enable = mkForce false`) and asserts the structural invariant on
          # that variant instead of the live config. Assert the STRUCTURAL
          # invariant rather than a version-specific store hash (which would
          # break on an opencode bump): the disabled-variant package is a
          # `symlinkJoin` named `opencode-wrapped` whose single wrapped path
          # is the unwrapped `home.opencode.basePackage`, and `basePackage`
          # resolves to `pkgs.opencode-pinned`. Perturbing the wrapper
          # (rename, extra path, divergent base) fails the per-host assertMsg.
          opencodeNonoDisabledEquivReport =
            let
              expectedBasePath = builtins.unsafeDiscardStringContext "${pkgs.opencode-pinned}";
            in
            pkgs.lib.concatMapStringsSep "\n" (
              hostName:
              let
                hmConfig =
                  (self.darwinConfigurations.${hostName}.extendModules {
                    modules = [
                      {
                        home-manager.users.brandonmcnama.programs.opencode-nono.enable = pkgs.lib.mkForce false;
                      }
                    ];
                  }).config.home-manager.users.brandonmcnama;
                finalPackage = hmConfig.programs.opencode.package;
                finalName = finalPackage.name or "";
                basePath = builtins.unsafeDiscardStringContext "${hmConfig.home.opencode.basePackage}";
                wrappedPaths = map (pkg: builtins.unsafeDiscardStringContext "${pkg}") (finalPackage.paths or [ ]);
              in
              assert pkgs.lib.assertMsg (finalName == "opencode-wrapped")
                "opencode-nono disabled-equiv name mismatch for ${hostName}: expected programs.opencode.package.name == \"opencode-wrapped\" (the canonical disabled wrapper), got \"${finalName}\"";
              assert pkgs.lib.assertMsg (wrappedPaths == [ basePath ])
                "opencode-nono disabled-equiv wrapped-paths mismatch for ${hostName}: expected programs.opencode.package.paths == [ home.opencode.basePackage (${basePath}) ], got [ ${pkgs.lib.concatStringsSep ", " wrappedPaths} ]";
              assert pkgs.lib.assertMsg (basePath == expectedBasePath)
                "opencode-nono disabled-equiv base mismatch for ${hostName}: expected home.opencode.basePackage to resolve to pkgs.opencode-pinned (${expectedBasePath}), got ${basePath}";
              "${hostName}: programs.opencode.package=opencode-wrapped; paths=[ ${basePath} ]; basePackage==opencode-pinned"
            ) opencodeTurnTimestampHosts;

          # Enabled-disabled launch-path equivalence gate (opencode-nono-sandbox
          # spec, task 7.4; requirements 1.3, 5.1, 5.3; design "Testing Strategy
          # → Enabled-disabled launch path"). Distinct from the 1.2 disabled-
          # equiv gate above, which tests the module-DISABLED variant. THIS gate
          # tests the LIVE ENABLED config (v1: module enabled, defaultState =
          # disabled), where `programs.opencode.package` is the `opencode`
          # LAUNCHER (a writeShellApplication, not a symlinkJoin). It asserts the
          # launcher's embedded script preserves the v1 launch contract:
          #   - runs the host preflight host-side (R5.1) — the launcher embeds
          #     `home.opencode.preflightScript` (joined wrapperCommands); the
          #     OPENCODE_EXPERIMENTAL_LSP_TOOL + mcpproxy markers are common to
          #     both hosts and only originate from that embedded preflight.
          #   - suffixes `lspPath` onto PATH with SUFFIX ordering
          #     `export PATH="$PATH:<lspPath>"` (R5.3) — the PREFIX form
          #     `export PATH="<lspPath>:$PATH"` MUST be absent so project-local
          #     bins keep winning.
          #   - references the bare pinned `${basePackage}/bin/opencode`
          #     (the disabled-branch exec target; R1.3).
          # A Nix-level assertMsg per host enforces the ENABLED topology (the
          # package is named "opencode", not "opencode-wrapped"); the wrong
          # topology fails at eval before the build runs.
          opencodeNonoLaunchEquivHosts = map (
            hostName:
            let
              hmConfig = self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama;
              launcher = hmConfig.programs.opencode.package;
              launcherName = launcher.name or "";
            in
            assert pkgs.lib.assertMsg (launcherName == "opencode")
              "opencode-nono launch-equiv topology mismatch for ${hostName}: expected the ENABLED launcher programs.opencode.package.name == \"opencode\", got \"${launcherName}\". The v1 config must ship the opencode-nono module enabled with defaultState=disabled.";
            {
              inherit hostName launcher;
              inherit (hmConfig.home.opencode) lspPath;
              basePackage = builtins.unsafeDiscardStringContext "${hmConfig.home.opencode.basePackage}";
            }
          ) opencodeTurnTimestampHosts;

          # Nixvim tests (only available on aarch64-darwin where darwin configs exist)
          nixvimTests =
            if system == "aarch64-darwin" then
              let
                hmConfig = self.darwinConfigurations."ShopifyLaptop".config.home-manager.users.brandonmcnama;
                nvimPackage = hmConfig.programs.nixvim.build.package;
                testDir = ./home-manager/nixvim/tests;
              in
              {
                # Byte-identical disabled-path equivalence gate (both hosts).
                # Forces the per-host assertions above; the build only
                # succeeds when every host's disabled wrapper matches the
                # canonical `opencode-wrapped` structure.
                opencode-nono-disabled-equiv =
                  pkgs.runCommand "opencode-nono-disabled-equiv"
                    {
                      hostReport = opencodeNonoDisabledEquivReport;
                    }
                    ''
                      printf '%s\n' "$hostReport" > $out
                    '';

                # Enabled launch-path equivalence gate (task 7.4). Inspects each
                # host's live ENABLED launcher script and asserts the v1 launch
                # contract: preflight preserved (R5.1), LSP PATH suffix ordering
                # (R5.3), and the bare-opencode disabled-branch exec target
                # (R1.3). See `opencodeNonoLaunchEquivHosts` above for the
                # per-host eval-time topology assertion.
                opencode-nono-launch-equiv = pkgs.runCommand "opencode-nono-launch-equiv" { } (
                  pkgs.lib.concatMapStringsSep "\n" (host: ''
                    launcher_bin="${host.launcher}/bin/opencode"
                    echo "checking ${host.hostName}: $launcher_bin"

                    # R5.3: LSP PATH fragment is SUFFIXED (project-local bins win).
                    if ! grep -qF 'export PATH="$PATH:${host.lspPath}"' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher missing LSP PATH suffix 'export PATH=\"\$PATH:${host.lspPath}\"' (R5.3)." >&2
                      exit 1
                    fi
                    # R5.3: the PREFIX form must be ABSENT — prepending would
                    # let pinned LSP bins shadow project-local ones.
                    if grep -qF 'export PATH="${host.lspPath}:$PATH"' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher uses PREFIX PATH ordering 'export PATH=\"${host.lspPath}:\$PATH\"'; expected suffix (R5.3)." >&2
                      exit 1
                    fi

                    # R1.3: the disabled branch execs the bare pinned opencode.
                    if ! grep -qF '${host.basePackage}/bin/opencode' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher does not reference the bare disabled-branch exec target '${host.basePackage}/bin/opencode' (R1.3)." >&2
                      exit 1
                    fi

                    # R5.1: host preflight is preserved (run host-side). These
                    # two markers come only from the embedded preflightScript
                    # (joined wrapperCommands) and are present on both hosts.
                    if ! grep -qF 'OPENCODE_EXPERIMENTAL_LSP_TOOL' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher missing preflight marker OPENCODE_EXPERIMENTAL_LSP_TOOL (R5.1)." >&2
                      exit 1
                    fi
                    if ! grep -qF 'mcpproxy' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher missing preflight marker 'mcpproxy' (R5.1)." >&2
                      exit 1
                    fi

                    printf '%s: launch path preserves preflight + LSP PATH suffix ordering + bare disabled exec\n' "${host.hostName}" >> "$out"
                  '') opencodeNonoLaunchEquivHosts
                );

                # Tier 1: Smoke test — does nvim start without errors?
                nixvim-smoke = hmConfig.programs.nixvim.build.test;

                # Tier 2: Config assertions — plugins, keybindings, settings, LSP config
                nixvim-config =
                  pkgs.runCommand "nixvim-config"
                    {
                      nativeBuildInputs = [ nvimPackage ];
                    }
                    ''
                      export HOME=$(mktemp -d)
                      nvim --headless -c "luafile ${testDir}/run-tier2.lua" 2>&1
                      touch $out
                    '';

                # Tier 3: Integration tests — LSP attachment, format-on-save, diagnostics
                nixvim-integration =
                  pkgs.runCommand "nixvim-integration"
                    {
                      nativeBuildInputs = [
                        nvimPackage
                        pkgs.git
                        pkgs.nixd
                        pkgs.lua-language-server
                        pkgs.bash-language-server
                        pkgs.nixfmt-rfc-style
                        pkgs.shfmt
                        pkgs.stylua
                      ];
                    }
                    ''
                      export HOME=$(mktemp -d)
                      mkdir -p $HOME/test && cd $HOME/test
                      git init -q
                      git config user.email "test@test.com"
                      git config user.name "test"
                      cp -r ${testDir}/fixtures/* .
                      git add . && git commit -q -m "init"
                      nvim --headless -c "luafile ${testDir}/run-tier3.lua" 2>&1
                      touch $out
                    '';
              }
            else
              { };
        in
        nixvimTests
        // rec {
          formatting = treefmtEval.${system}.config.build.check self;

          subagent-context-budget-tests =
            pkgs.runCommand "subagent-context-budget-tests"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/subagent-context-budget/
                touch $out
              '';

          personal-tailscale-service =
            pkgs.runCommand "personal-tailscale-service"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/personal-tailscale-service/
                touch $out
              '';

          rtk-opencode-tests =
            pkgs.runCommand "rtk-opencode-tests"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --experimental-strip-types --test tests/rtk-opencode/*.test.js tests/rtk-opencode/*.test.ts
                touch $out
              '';

          opencode-nono-tests =
            pkgs.runCommand "opencode-nono-tests"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/opencode-nono/
                touch $out
              '';

          opencode-nono-audit-tests =
            pkgs.runCommand "opencode-nono-audit-tests"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                # Resolve `require('better-sqlite3')` (and the SqliteReader
                # reused from scripts/opencode-cost-report.js) against the
                # vendored deps tree. The cost-report library is required
                # via its relative path from the copied source, so only
                # NODE_PATH is needed here.
                export NODE_PATH=${pkgs.opencode-cost-diagnosis-deps}/lib/node_modules
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/opencode-nono-audit/
                touch $out
              '';

          grep-app-mcp =
            pkgs.runCommand "grep-app-mcp"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/grep-app-mcp/
                touch $out
              '';

          ast-grep-mcp =
            pkgs.runCommand "ast-grep-mcp"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/ast-grep-mcp/
                touch $out
              '';

          opencode-turn-timestamps-tests =
            pkgs.runCommand "opencode-turn-timestamps-tests"
              {
                nativeBuildInputs = [
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/opencode-turn-timestamps/patch-contract.test.js
                touch $out
              '';

          opencode-turn-timestamps-package = pkgs.runCommand "opencode-turn-timestamps-package" { } ''
            export HOME=$(mktemp -d)
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            ${pkgs.opencode-pinned}/bin/opencode --version > version.txt
            test -s version.txt
            touch $out
          '';

          opencode-turn-timestamps-hosts =
            pkgs.runCommand "opencode-turn-timestamps-hosts"
              {
                hostReport = opencodeTurnTimestampHostReport;
              }
              ''
                printf '%s\n' "$hostReport" > $out
              '';

          git-cache-clone-package = pkgs.runCommand "git-cache-clone-package" { } ''
            export HOME=$(mktemp -d)
            export XDG_CACHE_HOME="$HOME/.cache"
            export XDG_CONFIG_HOME="$HOME/.config"
            export XDG_DATA_HOME="$HOME/.local/share"
            export XDG_STATE_HOME="$HOME/.local/state"

            ${gitCacheClone}/bin/git-cache-clone --help > help.txt
            test -s help.txt

            ${gitCacheClone}/bin/git-cache-clone --version > version.txt
            read -r version < version.txt
            test "$version" = "git-cache-clone 0.1.0"

            PATH="${gitCacheClone}/bin:$PATH" ${pkgs.git}/bin/git cache-clone --version > git-version.txt
            read -r git_version < git-version.txt
            test "$git_version" = "git-cache-clone 0.1.0"

            test ! -e "$XDG_STATE_HOME/git-clone-isolation"
            touch $out
          '';

          git-clone-isolation-package = git-cache-clone-package;

          git-cache-clone =
            pkgs.runCommand "git-cache-clone"
              {
                nativeBuildInputs = [
                  pkgs.git
                  pkgs.git-lfs
                  pkgs.nix
                  pkgs.nodejs
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export XDG_CACHE_HOME="$HOME/.cache"
                export XDG_CONFIG_HOME="$HOME/.config"
                export XDG_DATA_HOME="$HOME/.local/share"
                export XDG_STATE_HOME="$HOME/.local/state"
                export NIX_CONFIG="experimental-features = nix-command flakes"
                export GIT_CACHE_CLONE_BIN="${gitCacheClone}/bin/git-cache-clone"

                cp -R ${./.} source
                chmod -R u+w source
                cd source

                node --test tests/git-clone-isolation/
                touch $out
              '';

          git-clone-isolation = git-cache-clone;

          # Phase B operator validator builds + `--help` is non-empty
          # (rtk-install spec task 6.1). The script's full end-to-end
          # path requires a switched host (real metadata.json, real
          # plugin file, real opencode-stable.db); this check proves
          # that on the build host the derivation evaluates, the
          # shellcheck pass embedded in writeShellApplication accepts
          # the body, and `--help` short-circuits before any
          # discovery, exiting 0 with a non-empty usage block.
          rtk-opencode-validate-check =
            let
              validate = pkgs.callPackage ./scripts/rtk-opencode-validate.nix {
                rtk-opencode-smoke-test = pkgs.callPackage ./scripts/rtk-opencode-smoke-test.nix { };
                opencode-cost-report = pkgs.callPackage ./scripts/opencode-cost-report.nix { };
              };
            in
            pkgs.runCommand "rtk-opencode-validate-check" { } ''
              # Exit 0 + non-empty stdout proves the help short-circuit
              # works without touching $HOME, $XDG_CONFIG_HOME, or the
              # cost-report subprocess — the contract the operator
              # relies on when running the script unsure-of-state.
              ${validate}/bin/rtk-opencode-validate --help > help.txt
              test -s help.txt
              ${validate}/bin/rtk-opencode-validate --version > /dev/null
              touch $out
            '';

          # Builds the opencode-nono-audit CLI wrapper (Task 1.2) and
          # exercises its `--help`/`--version` short-circuits. Proves the
          # writeShellApplication body passes shellcheck and the wrapper
          # resolves its NODE_PATH/library env without a switched host or
          # live audit sources.
          opencode-nono-audit-validate-check =
            let
              cli = pkgs.callPackage ./scripts/opencode-nono-audit.nix { };
            in
            pkgs.runCommand "opencode-nono-audit-validate-check" { } ''
              export HOME=$(mktemp -d)
              export XDG_CACHE_HOME="$HOME/.cache"
              export XDG_CONFIG_HOME="$HOME/.config"
              export XDG_DATA_HOME="$HOME/.local/share"
              export XDG_STATE_HOME="$HOME/.local/state"

              ${cli}/bin/opencode-nono-audit --help > help.txt
              test -s help.txt

              ${cli}/bin/opencode-nono-audit --version > version.txt
              read -r version < version.txt
              test "$version" = "0.0.0"
              touch $out
            '';

          # Builds the opencode-nono-validate CLI (Task 5.1) and exercises
          # its `--help`/`--version` short-circuits. Proves the
          # writeShellApplication body passes shellcheck and the wrapper's
          # help/version paths exit 0 without a switched host, rendered nono
          # profiles, or a live launcher — both short-circuit before any
          # profile/launcher discovery (R6.1, R7.5). The script writes usage
          # and the version banner to stderr (mirroring its `fail()`
          # diagnostic convention), so capture stderr to assert non-empty
          # help output.
          opencode-nono-validate-check =
            let
              validate = pkgs.callPackage ./scripts/opencode-nono-validate.nix { };
            in
            pkgs.runCommand "opencode-nono-validate-check" { } ''
              export HOME=$(mktemp -d)
              export XDG_CONFIG_HOME="$HOME/.config"
              export XDG_CACHE_HOME="$HOME/.cache"
              export XDG_DATA_HOME="$HOME/.local/share"
              export XDG_STATE_HOME="$HOME/.local/state"

              ${validate}/bin/opencode-nono-validate --help 2> help.txt
              test -s help.txt
              ${validate}/bin/opencode-nono-validate --version 2> /dev/null
              touch $out
            '';

          pre-commit-check = inputs.git-hooks.lib.${system}.run {
            src = ./.;
            package = pkgs.prek;

            hooks = {
              # Formatting
              nixfmt-rfc-style.enable = true;

              # Linters
              statix = {
                enable = true;
                settings.config = "./.statix.toml";
              };

              deadnix.enable = true;
              flake-checker.enable = true;

              # Custom guards
              no-tmp-paths = {
                enable = true;
                name = "No /tmp/ paths in nix files";
                entry = "${pkgs.gnugrep}/bin/grep -rn '/tmp/' --include='*.nix'";
                language = "system";
                files = "\\.nix$";
                pass_filenames = false;
              };

              no-builtins-fetch = {
                enable = true;
                name = "No builtins.fetchGit/fetchTarball";
                entry = "${pkgs.bash}/bin/bash -c '${pkgs.gnugrep}/bin/grep -rn \"builtins\\.fetchGit\\|builtins\\.fetchTarball\\|builtins\\.fetchurl\" --include=\"*.nix\" --exclude=flake.nix | ${pkgs.gnugrep}/bin/grep -v \"shopify/default\\.nix\" && exit 1 || exit 0'";
                language = "system";
                pass_filenames = false;
              };

              no-hardcoded-users = {
                enable = true;
                name = "No hardcoded /Users/ in module code";
                entry = "${pkgs.bash}/bin/bash -c '${pkgs.gnugrep}/bin/grep -rn \"/Users/\" --include=\"*.nix\" --exclude=flake.nix | ${pkgs.gnugrep}/bin/grep -v \"\\$\\{\" && exit 1 || exit 0'";
                language = "system";
                pass_filenames = false;
              };
            };
          };
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          preCommitCheck = self.checks.${system}.pre-commit-check;
          # The generated .pre-commit-config.yaml nix store path
          preCommitConfig = preCommitCheck.config.configFile;
          sopsNixSudo = pkgs.writeShellApplication {
            name = "sops-nix-sudo";
            text = ''
              exec /usr/bin/sudo SOPS_AGE_KEY_FILE=/var/lib/sops-nix/key.txt ${pkgs.sops}/bin/sops "$@"
            '';
          };
        in
        {
          default = pkgs.mkShell {
            buildInputs = preCommitCheck.enabledPackages ++ [
              # Available in-shell so operators can decrypt/edit secrets/*.yaml
              # with the root-owned sops-nix age key. The wrapper invokes the
              # pinned sops binary under sudo with SOPS_AGE_KEY_FILE set; see
              # secrets/README.md for the operator runbook.
              sopsNixSudo
            ];

            # Symlink .pre-commit-config.yaml for the global prek hook to find.
            # We do NOT run prek install — hooks are installed globally via
            # home-manager's git-hooks.nix module.
            shellHook = ''
              GIT_WC=$(${pkgs.git}/bin/git rev-parse --show-toplevel 2>/dev/null)
              if [ -n "$GIT_WC" ]; then
                config="${preCommitConfig}"
                if [ -e "$config" ]; then
                  if ! readlink "''${GIT_WC}/.pre-commit-config.yaml" >/dev/null 2>&1 \
                    || [ "$(readlink "''${GIT_WC}/.pre-commit-config.yaml")" != "$config" ]; then
                    [ -L "''${GIT_WC}/.pre-commit-config.yaml" ] && unlink "''${GIT_WC}/.pre-commit-config.yaml"
                    ln -s "$config" "''${GIT_WC}/.pre-commit-config.yaml"
                  fi
                fi
              fi
            '';
          };
        }
      );

      overlays = import ./overlays { inherit inputs; };

      darwinConfigurations = {
        "ShopifyLaptop" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/shopify
          ];
        };
        "Brandons-MacBook-Pro" = inputs.darwin.lib.darwinSystem {
          specialArgs = {
            inherit inputs outputs;
            username = "brandonmcnama";
          };

          modules = [
            ./configurations/personal
          ];
        };
      };
    };
}
