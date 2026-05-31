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
                wrappedPackagePath = builtins.unsafeDiscardStringContext "${hmConfig.programs.opencode.package}";
                wrappedInputs = map (pkg: builtins.unsafeDiscardStringContext "${pkg}") (
                  hmConfig.programs.opencode.package.paths or [ ]
                );
              in
              assert pkgs.lib.assertMsg (actualPackagePath == expectedPackagePath)
                "opencode-turn-timestamps host package mismatch for ${hostName}: expected home.opencode.package to resolve to ${expectedPackagePath}, got ${actualPackagePath}";
              assert pkgs.lib.assertMsg (builtins.elem expectedPackagePath wrappedInputs)
                "opencode-turn-timestamps host wrapper mismatch for ${hostName}: expected programs.opencode.package to include ${expectedPackagePath}, got ${pkgs.lib.concatStringsSep ", " wrappedInputs}";
              "${hostName}: home.opencode.package=${actualPackagePath}; programs.opencode.package=${wrappedPackagePath}"
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
        in
        {
          default = pkgs.mkShell {
            buildInputs = preCommitCheck.enabledPackages ++ [
              # Available in-shell so operators can decrypt / edit
              # secrets/*.yaml without needing sops on PATH globally.
              # Decryption still requires the per-host age key at
              # /var/lib/sops-nix/key.txt (root-owned; use sudo) — see
              # secrets/README.md for the operator runbook.
              pkgs.sops
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
