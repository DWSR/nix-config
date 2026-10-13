{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";
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
      url = "github:nix-community/nixvim/nixos-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    stylix = {
      url = "github:nix-community/stylix/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    darwin = {
      url = "github:LnL7/nix-darwin/nix-darwin-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
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

    homebrew-tinycast = {
      url = "github:abue-ammar/homebrew-tinycast";
      flake = false;
    };

    # oMLX source, pinned. `overlays/omlx/default.nix` builds it into the
    # `omlx` package via uv2nix (see that file); this input is only the
    # upstream source tree, consumed through the flake (no Homebrew tap).
    # The vendored overlays/omlx/uv.lock was generated from this revision.
    omlx = {
      url = "github:jundot/omlx/cc1fdc9a24053224521a8dc6e1350d64e8ec16f4";
      flake = false;
    };

    # uv2nix toolchain for building the `omlx` Python application. The
    # Python packaging metadata (pyproject.toml) does not lock build
    # systems, so pyproject-build-systems supplies them separately. All
    # three follow the flake's nixpkgs and pyproject-nix so the generated
    # package sets share one interpreter/toolchain.
    pyproject-nix = {
      url = "github:pyproject-nix/pyproject.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    uv2nix = {
      url = "github:pyproject-nix/uv2nix";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
    };

    pyproject-build-systems = {
      url = "github:pyproject-nix/build-system-pkgs";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.pyproject-nix.follows = "pyproject-nix";
      inputs.uv2nix.follows = "uv2nix";
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

    # Source checkout of nixpkgs 25.05, used only to source rsync 3.4.x
    # for the fabro guest (configurations/fabro-vm/default.nix pins it in
    # an overlay): nixpkgs' rsync 3.5.0 breaks the kernel build's
    # post-install source copy inside the nix sandbox
    # (RsyncProject/rsync#1050-class local-copy regression). flake =
    # false so the overlay can `import` the tree like a checkout; the
    # branch tip is pinned by flake.lock.
    rsync34 = {
      url = "github:NixOS/nixpkgs/nixos-25.05";
      flake = false;
    };

    # OpenCode pinned to the anomalyco fork, consumed via that repo's own Nix
    # packaging (its flake's `packages.<system>.opencode`). overlays/misc.nix
    # layers the turn-timestamp patch, prompt-compression postPatch, and a
    # build-only Bun override on top. Bumps: change the tag here, then `nix
    # flake update opencode`.
    opencode = {
      url = "github:anomalyco/opencode/v1.19.0";
    };

    pi = {
      url = "github:lukasl-dev/pi.nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    agentmemory = {
      url = "github:DWSR/agentmemory";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # The nix-darwin module also manages feature policy and performs model
    # cleanup during activation. Keep the CLI package available system-wide;
    # configure Apple Intelligence policy manually with `pared wizard`.
    pared.url = "github:4evy/pared/2.1.0";

    # NixOS guest for the fabro Lima VM (configurations/fabro-vm): the
    # guest-side module provides lima-init (cidata boot-time setup) and the
    # lima-guestagent systemd service. Pinned to the release tag whose
    # image the VM boots by default (home-manager/common/lima-vm.nix
    # `image` default). The guest shares the flake's nixpkgs.
    nixos-lima = {
      url = "github:nixos-lima/nixos-lima/v0.2.2";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.nixpkgs-unstable.follows = "nixpkgs";
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
          gitMcpAdmin = pkgs.callPackage ./scripts/git-mcp-secure-enclave-admin.nix { };
          gitMcpAcceptance = pkgs.callPackage ./scripts/git-mcp-secure-enclave-acceptance.nix {
            adminPackage = gitMcpAdmin;
          };
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
          # fabro store sync (secrets/fabro.fabro.yaml); see
          # scripts/fabro-sync-from-1password.nix and secrets/README.md.
          fabro-sync-from-1password = {
            type = "app";
            program = "${
              import ./scripts/fabro-sync-from-1password.nix { inherit pkgs; }
            }/bin/fabro-sync-from-1password";
          };
          git-mcp-secure-enclave-acceptance = {
            type = "app";
            program = "${gitMcpAcceptance}/bin/git-mcp-secure-enclave-acceptance";
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
            config.allowUnfree = true;
            overlays = [
              outputs.overlays.unstable-packages
              outputs.overlays.custom-packages
            ];
          };
          agentMemoryPackage = pkgs.agentmemory;
          gitCacheClone = pkgs.callPackage ./scripts/git-clone-isolation.nix { };

          opencodeTurnTimestampHosts = [
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
                hmConfig = self.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama;
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

                    # git-root cwd: the embedded preflight cds to the current
                    # repo top-level so the project root (and nono's --allow-cwd
                    # grant) spans the whole repo regardless of launch subdir.
                    if ! grep -qF 'rev-parse --show-toplevel' "$launcher_bin"; then
                      echo "FAIL ${host.hostName}: launcher missing the git-root cwd 'git rev-parse --show-toplevel'." >&2
                      exit 1
                    fi

                    printf '%s: launch path preserves preflight + LSP PATH suffix ordering + bare disabled exec\n' "${host.hostName}" >> "$out"
                  '') opencodeNonoLaunchEquivHosts
                );

                # Tier 1: Smoke test — does nvim start without errors?
                nixvim-smoke = hmConfig.programs.nixvim.build.test;

                # Nix-level regression guard for the nvim-treesitter-textobjects
                # main-branch migration. A runtime keymap-existence test is not
                # viable here — this config's `programs.nixvim.keymaps` do not
                # register under `nvim --headless` — so assert at eval time that
                # the textobject keymaps are declared in `programs.nixvim.keymaps`
                # on both hosts. A regression to the inert
                # `plugins.treesitter-textobjects.settings.{select,move}` form
                # drops these entries (they land on a different option) and fails
                # this check.
                nixvim-textobjects-keymaps =
                  let
                    expectedKeys = [
                      "af"
                      "if"
                      "ac"
                      "ic"
                      "aa"
                      "ia"
                      "]m"
                      "]]"
                      "[m"
                      "[["
                    ];
                    checkHost =
                      hostName:
                      let
                        keymaps =
                          self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama.programs.nixvim.keymaps;
                        missing = builtins.filter (key: !(builtins.any (k: (k.key or null) == key) keymaps)) expectedKeys;
                      in
                      pkgs.lib.assertMsg (missing == [ ])
                        "treesitter-textobjects keymaps missing from programs.nixvim.keymaps on ${hostName}: ${pkgs.lib.concatStringsSep " " missing}. The main-branch keymap API regressed (likely back to the inert plugins.treesitter-textobjects.settings.{select,move} form).";
                  in
                  assert checkHost "Brandons-MacBook-Pro";
                  pkgs.runCommand "nixvim-textobjects-keymaps" { } ''
                    printf 'treesitter-textobjects keymaps declared on the personal host\n' > $out
                  '';

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
                        pkgs.nixfmt
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

          # Hammerspoon checks, gated to aarch64-darwin (the darwin app bundle
          # is built there, mirroring nixvimTests). Established as its own
          # binding so later verification tasks extend it with the renderer,
          # semantic, and host-wiring checks. The package check builds the
          # signed bundle and asserts the launchable binary + docs.json exist,
          # with no host switch or Accessibility grant (Req 4.1, 4.4).
          hammerspoonChecks = pkgs.lib.optionalAttrs (system == "aarch64-darwin") (
            let
              hsFixtures = import ./tests/hammerspoon-keybindings/fixtures.nix;
              mkSemanticCheck = import ./home-manager/common/hammerspoon-keybindings/semantic-check.nix {
                inherit pkgs;
                inherit (pkgs) lib;
              };
              deskflowProcessSnapshot =
                pkgs.callPackage ./home-manager/common/hammerspoon-deskflow-watchdog/process-snapshot.nix
                  { };
              deskflowWatchdogRenderTest = import ./tests/hammerspoon-deskflow-watchdog/render.test.nix {
                inherit pkgs;
              };
              deskflowWatchdogModuleTest = import ./tests/hammerspoon-deskflow-watchdog/module.test.nix {
                inherit pkgs;
                inherit (inputs) home-manager;
              };
              timezoneMenubarTimezones = [
                {
                  label = "Toronto";
                  timeZone = "America/Toronto";
                }
                {
                  label = "UTC";
                  timeZone = "Etc/UTC";
                }
                {
                  label = "Vancouver";
                  timeZone = "America/Vancouver";
                }
              ];
              timezoneMenubarContribution = import ./home-manager/common/hammerspoon-timezone-menubar/render.nix timezoneMenubarTimezones;
              timezoneMenubarRenderTest = import ./tests/hammerspoon-timezone-menubar/render.test.nix {
                inherit pkgs;
              };
              timezoneMenubarModuleTest = import ./tests/hammerspoon-timezone-menubar/module.test.nix {
                inherit pkgs;
                inherit (inputs) home-manager;
              };
              renderDeskflowWatchdog = import ./home-manager/common/hammerspoon-deskflow-watchdog/render.nix {
                trustedSnapshotHelper = deskflowProcessSnapshot;
              };
              deskflowWatchdogServerContribution = renderDeskflowWatchdog {
                role = "server";
                snapshotCommand = "${deskflowProcessSnapshot}/bin/deskflow-process-snapshot";
              };
              deskflowWatchdogSemanticConfig = {
                keybindings = [ ];
                extraConfig = deskflowWatchdogServerContribution;
                reloadOnConfigChange = true;
              };
              deskflowWatchdogSemantic = mkSemanticCheck deskflowWatchdogSemanticConfig;
              deskflowWatchdogBogusApi = "deskflowWatchdogBogusApi";
              deskflowWatchdogBogusInit = pkgs.writeText "hammerspoon-deskflow-watchdog-bogus.lua" (
                import ./home-manager/common/hammerspoon-keybindings/render.nix
                  {
                    inherit (pkgs) lib;
                  }
                  (
                    deskflowWatchdogSemanticConfig
                    // {
                      extraConfig = deskflowWatchdogServerContribution + ''
                        hs.${deskflowWatchdogBogusApi}.start()
                      '';
                    }
                  )
              );
              # The negative check re-runs the SAME lua-language-server gate as
              # mkSemanticCheck on the bogus fixture. semantic-check.nix keeps its
              # `.luarc.json` internal, so the keys are mirrored here: annotations
              # as workspace.library, `hs` deliberately NOT a declared global (so
              # member-checking stays on), undefined-field/global forced to Error,
              # checkThirdParty=false to stay offline.
              bogusInit = pkgs.writeText "hammerspoon-init-bogus.lua" (
                import ./home-manager/common/hammerspoon-keybindings/render.nix {
                  inherit (pkgs) lib;
                } hsFixtures.bogus
              );
              negativeLuarc = pkgs.writeText "hammerspoon-luarc-negative.json" (
                builtins.toJSON {
                  runtime.version = "Lua 5.4";
                  workspace = {
                    library = [ "${pkgs.hammerspoonHsAnnotations}" ];
                    checkThirdParty = false;
                  };
                  diagnostics.severity = {
                    "undefined-field" = "Error";
                    "undefined-global" = "Error";
                  };
                }
              );
            in
            {
              hammerspoon-package = pkgs.runCommand "hammerspoon-package" { } ''
                test -x ${pkgs.hammerspoon}/Applications/Hammerspoon.app/Contents/MacOS/Hammerspoon
                test -f ${pkgs.hammerspoon}/Applications/Hammerspoon.app/Contents/Resources/docs.json
                touch $out
              '';

              hammerspoon-deskflow-watchdog-tests =
                pkgs.runCommand "hammerspoon-deskflow-watchdog-tests"
                  {
                    nativeBuildInputs = [ pkgs.lua5_4 ];
                    processSnapshot = deskflowProcessSnapshot;
                  }
                  ''
                    test -x "$processSnapshot/bin/deskflow-process-snapshot"
                    lua ${./.}/tests/hammerspoon-deskflow-watchdog/fixtures.test.lua
                    lua ${./.}/tests/hammerspoon-deskflow-watchdog/model.test.lua
                    lua ${./.}/tests/hammerspoon-deskflow-watchdog/fake-hs.test.lua
                    lua ${./.}/tests/hammerspoon-deskflow-watchdog/runtime.test.lua
                    touch "$out"
                  '';

              hammerspoon-deskflow-watchdog-render =
                pkgs.runCommand "hammerspoon-deskflow-watchdog-render"
                  {
                    moduleTest = deskflowWatchdogModuleTest;
                    renderTest = deskflowWatchdogRenderTest;
                  }
                  ''
                    test -e "$moduleTest"
                    test -e "$renderTest"
                    touch "$out"
                  '';

              hammerspoon-deskflow-watchdog-semantic =
                pkgs.runCommand "hammerspoon-deskflow-watchdog-semantic"
                  {
                    nativeBuildInputs = [ pkgs.lua-language-server ];
                    positiveSemantic = deskflowWatchdogSemantic;
                  }
                  ''
                    set -eu

                    test -e "$positiveSemantic"

                    export HOME="$(mktemp -d)"
                    export XDG_CACHE_HOME="$(mktemp -d)"

                    work="$(mktemp -d)"
                    mkdir -p "$work/ws" "$work/log" "$work/meta"
                    cp ${deskflowWatchdogBogusInit} "$work/ws/init.lua"
                    cp ${negativeLuarc} "$work/ws/.luarc.json"

                    status=0
                    diagnostics="$(lua-language-server --check "$work/ws" \
                      --configpath "$work/ws/.luarc.json" \
                      --logpath "$work/log" \
                      --metapath "$work/meta" \
                      --checklevel=Error 2>&1)" || status=$?

                    printf '%s\n' "$diagnostics"

                    if [ "$status" -eq 0 ]; then
                      echo "Deskflow watchdog semantic negative check FAILED: lua-language-server accepted hs.${deskflowWatchdogBogusApi}." >&2
                      exit 1
                    fi

                    if ! printf '%s' "$diagnostics" | grep -qF 'Undefined field `${deskflowWatchdogBogusApi}`.' \
                      || ! printf '%s' "$diagnostics" | grep -qF '(undefined-field)'; then
                      echo "Deskflow watchdog semantic negative check FAILED: expected undefined-field diagnostic for '${deskflowWatchdogBogusApi}':" >&2
                      printf '%s\n' "$diagnostics" >&2
                      exit 1
                    fi

                    touch "$out"
                  '';

              # Positive (5.2): build the REAL mkSemanticCheck on a valid
              # representative fixture. `nix flake check` building this derivation
              # IS the proof that a valid rendered config passes the LuaLS
              # member-checking gate. Hermetic + aarch64-gated (5.5); no host or
              # Accessibility grant (4.4).
              hammerspoon-config-semantic = mkSemanticCheck hsFixtures.validMulti;

              # Negative (5.4): a check that PASSES only when the bogus fixture is
              # REJECTED. A failing build cannot be a passing check, and recursive
              # nix is unavailable in the flake-check sandbox, so this re-runs the
              # gate's `lua-language-server --check` on the bogus fixture's rendered
              # config and asserts a non-zero exit naming the nonexistent symbol
              # (`undefined-field` 'bogusModule'). Offline + host-free (5.5/4.4).
              hammerspoon-config-semantic-rejects-bogus =
                pkgs.runCommand "hammerspoon-config-semantic-rejects-bogus"
                  {
                    nativeBuildInputs = [ pkgs.lua-language-server ];
                  }
                  ''
                    set -eu

                    # Redirect every writable path LuaLS touches into build-temp:
                    # the store install dir is read-only. mktemp honours $TMPDIR,
                    # so no /tmp literal is used (mirrors semantic-check.nix).
                    export HOME="$(mktemp -d)"
                    export XDG_CACHE_HOME="$(mktemp -d)"

                    work="$(mktemp -d)"
                    mkdir -p "$work/ws" "$work/log" "$work/meta"
                    cp ${bogusInit} "$work/ws/init.lua"
                    cp ${negativeLuarc} "$work/ws/.luarc.json"

                    # Same invocation the gate uses; capture its exit + output
                    # instead of letting a non-zero exit abort the build.
                    status=0
                    diagnostics="$(lua-language-server --check "$work/ws" \
                      --configpath "$work/ws/.luarc.json" \
                      --logpath "$work/log" \
                      --metapath "$work/meta" \
                      --checklevel=Error 2>&1)" || status=$?

                    printf '%s\n' "$diagnostics"

                    if [ "$status" -eq 0 ]; then
                      echo "NEGATIVE semantic check FAILED: lua-language-server accepted the nonexistent hs symbol (exit 0); the bogus fixture was NOT rejected." >&2
                      exit 1
                    fi

                    if ! printf '%s' "$diagnostics" | grep -qF 'bogusModule'; then
                      echo "NEGATIVE semantic check FAILED: bogus fixture rejected (exit $status) but the diagnostic did not name 'bogusModule':" >&2
                      printf '%s\n' "$diagnostics" >&2
                      exit 1
                    fi

                    echo "NEGATIVE semantic check PASSED: nonexistent hs symbol rejected (exit $status; undefined-field naming bogusModule)."
                    touch "$out"
                  '';

              # Live mic-mute semantic check — design "Components and Interfaces →
              # Verification → #### Verification" `hammerspoon-mic-mute-semantic`
              # bullet. Feeds the personal host `home.hammerspoon` cfg (now
              # carrying the ⌃⌘⇧F12 binding + the mic-mute.lua extraConfig) through
              # the framework's real `mkSemanticCheck` gate. Building it proves the
              # mic-mute Lua references only existing `hs` symbols (Req 6.1);
              # aarch64-gated and host-free, with no Hammerspoon install, run, or
              # Accessibility grant (Req 6.3). The framework checks above are
              # unchanged.
              hammerspoon-mic-mute-semantic = mkSemanticCheck {
                inherit
                  (self.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama.home.hammerspoon
                  )
                  keybindings
                  extraConfig
                  reloadOnConfigChange
                  ;
              };

              # Isolated caffeinate semantic check — design "#### Verification"
              # `hammerspoon-caffeinate-semantic` bullet. Feeds an ISOLATED caffeinate
              # cfg (empty keybindings, extraConfig = the caffeinate.lua) through the
              # framework's real `mkSemanticCheck`. Building it proves the caffeinate
              # Lua references only existing `hs.*` symbols (Req 7.1). Isolated input
              # keeps ownership independent of the mic-mute consumer. aarch64-gated,
              # host-free (Req 7.4); the framework + mic-mute checks are unchanged.
              hammerspoon-caffeinate-semantic = mkSemanticCheck {
                keybindings = [ ];
                extraConfig = builtins.readFile ./home-manager/common/hammerspoon-caffeinate/caffeinate.lua;
                reloadOnConfigChange = true;
              };

              # Isolated brightness-on-AC semantic check — mirrors
              # `hammerspoon-caffeinate-semantic`. Feeds an ISOLATED cfg (empty
              # keybindings, extraConfig = the brightness-ac.lua) through the
              # framework's real `mkSemanticCheck`. Building it proves the
              # brightness-ac Lua references only existing `hs.*` symbols
              # (hs.battery.powerSource, hs.battery.watcher.new, hs.brightness.set),
              # independent of whether any host enables the consumer. aarch64-gated,
              # host-free; the framework + other consumer checks are unchanged.
              hammerspoon-brightness-ac-semantic = mkSemanticCheck {
                keybindings = [ ];
                extraConfig = builtins.readFile ./home-manager/common/hammerspoon-brightness-ac/brightness-ac.lua;
                reloadOnConfigChange = true;
              };

              hammerspoon-timezone-menubar-tests =
                pkgs.runCommand "hammerspoon-timezone-menubar-tests"
                  {
                    moduleTest = timezoneMenubarModuleTest;
                    renderTest = timezoneMenubarRenderTest;
                  }
                  ''
                    test -e "$moduleTest"
                    test -e "$renderTest"
                    touch "$out"
                  '';

              hammerspoon-timezone-menubar-semantic = mkSemanticCheck {
                keybindings = [ ];
                extraConfig = timezoneMenubarContribution;
                reloadOnConfigChange = true;
              };

              # Host-wiring eval assertions (personal host) — Task 8.4; design
              # "#### Verification" host-wiring bullet + Testing Strategy →
              # Build/Integration host-wiring list. Pure eval over each darwin
              # host config plus a trivial runCommand, so no host switch or
              # Accessibility grant is needed (Req 4.4). The per-host report is
              # produced only by forcing five assertions, each naming the host
              # and the failing property:
              #   1.2     home.packages contains the hammerspoon pkg (per-user install).
              #   3.4/6.1 xdg.configFile."hammerspoon/init.lua".source is the
              #           syntax-gate derivation (named "hammerspoon-init.lua" by
              #           checked-config.nix), not a raw `.text`.
              #   6.2     the MJConfigFile default equals the XDG init.lua path.
              #   6.3     no home.file entry under ~/.hammerspoon.
              #   1.7     the login launchd agent is enabled with RunAtLoad.
              hammerspoon-host-wiring =
                let
                  hosts = [
                    "Brandons-MacBook-Pro"
                  ];
                  checkHost =
                    hostName:
                    let
                      sys = self.darwinConfigurations.${hostName}.config;
                      hm = sys.home-manager.users.brandonmcnama;
                      hasPackage = builtins.any (
                        p:
                        (p.pname or p.name or "") == "hammerspoon" || builtins.match "hammerspoon.*" (p.name or "") != null
                      ) hm.home.packages;
                      initSource = hm.xdg.configFile."hammerspoon/init.lua".source;
                      sourceName = initSource.name or "";
                      mjConfigFile = hm.targets.darwin.defaults."org.hammerspoon.Hammerspoon".MJConfigFile;
                      expectedMjConfigFile = "${hm.xdg.configHome}/hammerspoon/init.lua";
                      dotHammerspoonFiles = builtins.filter (n: builtins.match "\\.hammerspoon($|/.*)" n != null) (
                        builtins.attrNames hm.home.file
                      );
                      agent = hm.launchd.agents.hammerspoon;
                      agentRunsAtLoad = agent.enable && agent.config.RunAtLoad;
                      agentTarget = builtins.head agent.config.ProgramArguments;
                      # Per-user install: no /Applications/Nix Apps path, so the
                      # agent must target the package's store-path binary.
                      agentTargetsStorePackage =
                        pkgs.lib.hasPrefix "${builtins.storeDir}/" agentTarget
                        && pkgs.lib.hasSuffix "/Applications/Hammerspoon.app/Contents/MacOS/Hammerspoon" agentTarget;
                    in
                    assert pkgs.lib.assertMsg hasPackage
                      "hammerspoon host-wiring: home.packages on ${hostName} does not contain the hammerspoon package (Req 1.2).";
                    assert pkgs.lib.assertMsg (sourceName == "hammerspoon-init.lua")
                      "hammerspoon host-wiring: xdg.configFile.\"hammerspoon/init.lua\".source on ${hostName} is not the syntax-gate output (expected derivation name \"hammerspoon-init.lua\", got \"${sourceName}\") (Req 3.4/6.1).";
                    assert pkgs.lib.assertMsg (mjConfigFile == expectedMjConfigFile)
                      "hammerspoon host-wiring: MJConfigFile default on ${hostName} is \"${mjConfigFile}\", expected \"${expectedMjConfigFile}\" (Req 6.2).";
                    assert pkgs.lib.assertMsg (dotHammerspoonFiles == [ ])
                      "hammerspoon host-wiring: ${hostName} declares home.file under ~/.hammerspoon: [ ${pkgs.lib.concatStringsSep " " dotHammerspoonFiles} ] (Req 6.3).";
                    assert pkgs.lib.assertMsg agentRunsAtLoad
                      "hammerspoon host-wiring: launchd.agents.hammerspoon on ${hostName} must be enabled with RunAtLoad=true (Req 1.7).";
                    assert pkgs.lib.assertMsg agentTargetsStorePackage
                      "hammerspoon host-wiring: launchd.agents.hammerspoon on ${hostName} must target the per-user store-path Hammerspoon binary, got \"${agentTarget}\" (Req 1.7).";
                    "${hostName}: home.packages has hammerspoon=${pkgs.lib.boolToString hasPackage}; init.lua source=${sourceName}; MJConfigFile=${mjConfigFile}; ~/.hammerspoon home.file entries=${toString (builtins.length dotHammerspoonFiles)}; launchd agent enable=${pkgs.lib.boolToString agent.enable} RunAtLoad=${pkgs.lib.boolToString agent.config.RunAtLoad} target=${agentTarget}";
                in
                pkgs.runCommand "hammerspoon-host-wiring"
                  {
                    hostReport = pkgs.lib.concatMapStringsSep "\n" checkHost hosts;
                  }
                  ''
                    printf '%s\n' "$hostReport" > $out
                  '';

              # Mic-mute wiring + teardown eval assertions (personal host) — Task
              # 4.2; design "#### Verification" `hammerspoon-mic-mute-wiring`
              # bullet. Pure eval over each darwin host config plus a trivial
              # runCommand, so no host switch or Accessibility grant is needed
              # (Req 6.3). Forcing the per-host report forces two assertions,
              # each naming the host and the failing property:
              #   6.2/5.4 exactly one ⌃⌘⇧F12 keybinding (mod set
              #           {cmd,ctrl,shift}, key "F12") whose action.lua is
              #           non-null and calls micMuteToggle.
              #   5.1/5.4 the "ears" cask is absent from homebrew.casks. A
              #           successful host-config eval also proves the ears.nix
              #           import was removed (Req 5.2). The framework checks and
              #           hammerspoon-mic-mute-semantic are unchanged.
              hammerspoon-mic-mute-wiring =
                let
                  hosts = [
                    "Brandons-MacBook-Pro"
                  ];
                  checkHost =
                    hostName:
                    let
                      sys = self.darwinConfigurations.${hostName}.config;
                      hm = sys.home-manager.users.brandonmcnama;
                      # Order-insensitive modifier set: sort both sides so
                      # [ "ctrl" "cmd" "shift" ] matches {cmd,ctrl,shift}.
                      expectedModSet = pkgs.lib.sort (x: y: x < y) [
                        "cmd"
                        "ctrl"
                        "shift"
                      ];
                      isMicBinding =
                        b:
                        pkgs.lib.sort (x: y: x < y) b.mods == expectedModSet
                        && b.key == "F12"
                        && b.action.lua != null
                        && pkgs.lib.hasInfix "micMuteToggle" b.action.lua;
                      micBindings = builtins.filter isMicBinding hm.home.hammerspoon.keybindings;
                      micBindingCount = builtins.length micBindings;
                      micBindingExactlyOne = micBindingCount == 1;
                      earsPresent = builtins.elem "ears" sys.homebrew.casks;
                      earsAbsent = !earsPresent;
                    in
                    assert pkgs.lib.assertMsg micBindingExactlyOne
                      "hammerspoon mic-mute wiring: ${hostName} must declare exactly one Cmd+Ctrl+Shift+F12 lua binding calling micMuteToggle, found ${toString micBindingCount} (Req 6.2/5.4).";
                    assert pkgs.lib.assertMsg earsAbsent
                      "hammerspoon mic-mute wiring: ${hostName} still lists the \"ears\" cask in homebrew.casks (Req 5.1/5.4).";
                    "${hostName}: mic-mute Cmd+Ctrl+Shift+F12 lua bindings=${toString micBindingCount}; ears cask present=${pkgs.lib.boolToString earsPresent}";
                in
                pkgs.runCommand "hammerspoon-mic-mute-wiring"
                  {
                    hostReport = pkgs.lib.concatMapStringsSep "\n" checkHost hosts;
                  }
                  ''
                    printf '%s\n' "$hostReport" > $out
                  '';

              # Caffeinate wiring + teardown eval assertions (personal host) — Task
              # 4.2; design "#### Verification" `hammerspoon-caffeinate-wiring`
              # bullet. Pure eval over each darwin host config plus a trivial
              # runCommand, so no host switch or Accessibility grant is needed
              # (Req 7.4). Forcing the per-host report forces, per host: the
              # caffeinate sentinel is present in the rendered home.hammerspoon
              # config (via render.nix) (Req 7.2), and the "domzilla-caffeine"
              # cask is absent from homebrew.casks (Req 6.1/7.3) — asserting on
              # The personal host is the retained host behavior. The framework,
              # mic-mute, and hammerspoon-caffeinate-semantic checks are unchanged.
              hammerspoon-caffeinate-wiring =
                let
                  hosts = [
                    "Brandons-MacBook-Pro"
                  ];
                  sentinel = "-- hammerspoon-caffeinate: menu-bar toggle";
                  renderHs = import ./home-manager/common/hammerspoon-keybindings/render.nix {
                    inherit (pkgs) lib;
                  };
                  checkHost =
                    hostName:
                    let
                      sys = self.darwinConfigurations.${hostName}.config;
                      hm = sys.home-manager.users.brandonmcnama;
                      rendered = renderHs {
                        inherit (hm.home.hammerspoon) keybindings extraConfig reloadOnConfigChange;
                      };
                      sentinelPresent = pkgs.lib.hasInfix sentinel rendered;
                      caffeineCaskPresent = builtins.elem "domzilla-caffeine" sys.homebrew.casks;
                    in
                    assert pkgs.lib.assertMsg sentinelPresent
                      "hammerspoon caffeinate wiring: ${hostName} rendered home.hammerspoon config is missing the caffeinate sentinel '${sentinel}' (Req 7.2).";
                    assert pkgs.lib.assertMsg (!caffeineCaskPresent)
                      "hammerspoon caffeinate wiring: ${hostName} still lists the \"domzilla-caffeine\" cask in homebrew.casks (Req 6.1/7.3).";
                    "${hostName}: caffeinate sentinel present=${pkgs.lib.boolToString sentinelPresent}; domzilla-caffeine cask present=${pkgs.lib.boolToString caffeineCaskPresent}";

                in
                pkgs.runCommand "hammerspoon-caffeinate-wiring"
                  {
                    hostReport = pkgs.lib.concatMapStringsSep "\n" checkHost hosts;
                  }
                  ''
                    printf '%s\n' "$hostReport" > $out
                  '';

              hammerspoon-timezone-menubar-wiring =
                let
                  hosts = [
                    "Brandons-MacBook-Pro"
                  ];
                  sentinel = "-- hammerspoon-timezone-menubar: compact world clocks";
                  renderHs = import ./home-manager/common/hammerspoon-keybindings/render.nix {
                    inherit (pkgs) lib;
                  };
                  checkHost =
                    hostName:
                    let
                      hm = self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama;
                      timezoneMenubar = hm.home.hammerspoon.timezoneMenubar;
                      rendered = renderHs {
                        inherit (hm.home.hammerspoon) keybindings extraConfig reloadOnConfigChange;
                      };
                      configured = timezoneMenubar.enable && timezoneMenubar.timezones == timezoneMenubarTimezones;
                      sentinelPresent = pkgs.lib.hasInfix sentinel rendered;
                    in
                    assert pkgs.lib.assertMsg configured
                      "hammerspoon timezone menubar wiring: ${hostName} does not enable the expected Toronto, UTC, and Vancouver timezones.";
                    assert pkgs.lib.assertMsg sentinelPresent
                      "hammerspoon timezone menubar wiring: ${hostName} rendered config is missing the timezone menubar sentinel.";
                    "${hostName}: configured=${pkgs.lib.boolToString configured}; sentinel present=${pkgs.lib.boolToString sentinelPresent}";
                  personalMasApps = self.darwinConfigurations."Brandons-MacBook-Pro".config.homebrew.masApps;
                  clockerPresent = builtins.hasAttr "Clocker" personalMasApps;
                in
                assert pkgs.lib.assertMsg (
                  !clockerPresent
                ) "hammerspoon timezone menubar wiring: Brandons-MacBook-Pro still installs Clocker.";
                pkgs.runCommand "hammerspoon-timezone-menubar-wiring"
                  {
                    hostReport = pkgs.lib.concatMapStringsSep "\n" checkHost hosts;
                    clockerReport = "Brandons-MacBook-Pro: Clocker present=${pkgs.lib.boolToString clockerPresent}";
                  }
                  ''
                    printf '%s\n' "$hostReport" > "$out"
                    printf '%s\n' "$clockerReport" >> "$out"
                  '';

              hammerspoon-deskflow-watchdog-wiring =
                let
                  sentinel = "-- deskflow-hammerspoon-watchdog:render-v1";
                  expectedSnapshotCommand = "${deskflowProcessSnapshot}/bin/deskflow-process-snapshot";
                  expectedSnapshotCommandText = builtins.unsafeDiscardStringContext expectedSnapshotCommand;
                  expectedSnapshotContext = builtins.getContext expectedSnapshotCommand;
                  expectedSnapshotContextPaths = builtins.attrNames expectedSnapshotContext;
                  watchdogDefinitionSource = builtins.unsafeDiscardStringContext "${self.outPath}/home-manager/common/hammerspoon-deskflow-watchdog";
                  count = needle: text: builtins.length (pkgs.lib.splitString needle text) - 1;
                  canonicalRole =
                    role:
                    if role == "client" then
                      "client"
                    else if role == "server" then
                      "server"
                    else
                      throw "hammerspoon Deskflow watchdog wiring: inherited Deskflow role must be client or server";
                  inspectContribution =
                    {
                      contribution,
                      definitions,
                      enabled,
                      role,
                    }:
                    let
                      expectedContributionCount = if enabled then 1 else 0;
                      canonicalContribution = renderDeskflowWatchdog {
                        inherit role;
                        snapshotCommand = expectedSnapshotCommand;
                      };
                      canonicalContributionText = builtins.unsafeDiscardStringContext canonicalContribution;
                      contributionText = builtins.unsafeDiscardStringContext contribution;
                      contributionContext = builtins.getContext contribution;
                      isWatchdogDefinition =
                        definition: builtins.isString definition.file && definition.file == watchdogDefinitionSource;
                      isCanonicalDefinition =
                        definition:
                        builtins.isString definition.value
                        && builtins.unsafeDiscardStringContext definition.value == canonicalContributionText
                        && builtins.getContext definition.value == expectedSnapshotContext;
                      definitionHasSnapshotContext =
                        definition:
                        builtins.isString definition.value
                        && pkgs.lib.any (
                          path: builtins.hasAttr path (builtins.getContext definition.value)
                        ) expectedSnapshotContextPaths;
                      watchdogDefinitions = builtins.filter isWatchdogDefinition definitions;
                      otherSourceDefinitions = builtins.filter (
                        definition: !(isWatchdogDefinition definition)
                      ) definitions;
                      canonicalDefinitions = builtins.filter isCanonicalDefinition watchdogDefinitions;
                      watchdogDefinitionCount = builtins.length watchdogDefinitions;
                      canonicalDefinitionCount = builtins.length canonicalDefinitions;
                      otherSourceDefinitionSignatures = map (definition: {
                        inherit (definition) file;
                        text = builtins.unsafeDiscardStringContext definition.value;
                        context = builtins.getContext definition.value;
                      }) otherSourceDefinitions;
                      snapshotContextDefinitionCount = builtins.length (
                        builtins.filter definitionHasSnapshotContext watchdogDefinitions
                      );
                      canonicalContributionCount = count canonicalContributionText contributionText;
                      sentinelCount = count sentinel contributionText;
                      snapshotContextMatches =
                        if enabled then
                          contributionContext == expectedSnapshotContext
                        else
                          pkgs.lib.all (path: !(builtins.hasAttr path contributionContext)) expectedSnapshotContextPaths;
                    in
                    {
                      inherit
                        canonicalContributionCount
                        canonicalDefinitionCount
                        expectedContributionCount
                        otherSourceDefinitionSignatures
                        sentinelCount
                        snapshotContextDefinitionCount
                        snapshotContextMatches
                        watchdogDefinitionCount
                        ;
                      valid =
                        watchdogDefinitionCount == expectedContributionCount
                        && canonicalDefinitionCount == watchdogDefinitionCount
                        && canonicalContributionCount == expectedContributionCount
                        && sentinelCount == expectedContributionCount
                        && snapshotContextDefinitionCount == expectedContributionCount
                        && snapshotContextMatches;
                    };
                  contributionInspectionModule =
                    { lib, options, ... }:
                    {
                      options.home.hammerspoon.deskflowWatchdogWiringDefinitions = lib.mkOption {
                        type = lib.types.anything;
                        internal = true;
                        readOnly = true;
                      };
                      config.home.hammerspoon.deskflowWatchdogWiringDefinitions =
                        options.home.hammerspoon.extraConfig.definitionsWithLocations;
                    };
                  inspectedHost =
                    hostName: modules:
                    (self.darwinConfigurations.${hostName}.extendModules {
                      modules = modules ++ [
                        {
                          home-manager.sharedModules = [ contributionInspectionModule ];
                        }
                      ];
                    }).config.home-manager.users.brandonmcnama;
                  validateConfig =
                    {
                      baselineHm,
                      hm,
                      expectedEnabled,
                      expectedRole,
                    }:
                    let
                      watchdog = hm.home.hammerspoon.deskflowWatchdog;
                      role = canonicalRole hm.home.deskflow.role;
                      contribution = hm.home.hammerspoon.extraConfig;
                      inspection = inspectContribution {
                        inherit contribution role;
                        definitions = hm.home.hammerspoon.deskflowWatchdogWiringDefinitions;
                        enabled = expectedEnabled;
                      };
                      baselineInspection = inspectContribution {
                        contribution = baselineHm.home.hammerspoon.extraConfig;
                        definitions = baselineHm.home.hammerspoon.deskflowWatchdogWiringDefinitions;
                        enabled = false;
                        inherit role;
                      };
                      otherSourceDefinitionsMatch =
                        inspection.otherSourceDefinitionSignatures == baselineInspection.otherSourceDefinitionSignatures;
                    in
                    {
                      inherit
                        baselineInspection
                        inspection
                        otherSourceDefinitionsMatch
                        role
                        watchdog
                        ;
                      deskflowEnabled = hm.home.deskflow.enable;
                      enableMatches = watchdog.enable == expectedEnabled;
                      roleMatches = role == expectedRole;
                      valid =
                        watchdog.enable == expectedEnabled
                        && hm.home.deskflow.enable
                        && role == expectedRole
                        && inspection.valid
                        && baselineInspection.valid
                        && otherSourceDefinitionsMatch;
                    };
                  checkConfig =
                    {
                      baselineHm,
                      label,
                      hm,
                      expectedEnabled,
                      expectedRole,
                    }:
                    let
                      validation = validateConfig {
                        inherit
                          baselineHm
                          expectedEnabled
                          expectedRole
                          hm
                          ;
                      };
                      inherit (validation) inspection;
                    in
                    assert pkgs.lib.assertMsg validation.valid
                      "hammerspoon Deskflow watchdog wiring: ${label} failed host validation: enable matches=${pkgs.lib.boolToString validation.enableMatches}; Deskflow enabled=${pkgs.lib.boolToString validation.deskflowEnabled}; role matches=${pkgs.lib.boolToString validation.roleMatches}; watchdog-source definitions=${toString inspection.watchdogDefinitionCount}/${toString inspection.expectedContributionCount}; canonical watchdog-source definitions=${toString inspection.canonicalDefinitionCount}; canonical chunks=${toString inspection.canonicalContributionCount}; sentinels=${toString inspection.sentinelCount}; helper-context definitions=${toString inspection.snapshotContextDefinitionCount}; helper context matches=${pkgs.lib.boolToString inspection.snapshotContextMatches}; disabled baseline valid=${pkgs.lib.boolToString validation.baselineInspection.valid}; other-source definitions match disabled baseline=${pkgs.lib.boolToString validation.otherSourceDefinitionsMatch} (requirements 6.1, 6.2, 6.3, 6.4, 7.5).";
                    "${label}: watchdog enable=${pkgs.lib.boolToString validation.watchdog.enable}; Deskflow enable=${pkgs.lib.boolToString validation.deskflowEnabled}; inherited role=${builtins.toJSON validation.role}; watchdog-source definitions=${toString inspection.watchdogDefinitionCount}; canonical watchdog-source definitions=${toString inspection.canonicalDefinitionCount}; canonical chunks=${toString inspection.canonicalContributionCount}; sentinels=${toString inspection.sentinelCount}; helper-context definitions=${toString inspection.snapshotContextDefinitionCount}; disabled baseline valid=${pkgs.lib.boolToString validation.baselineInspection.valid}; other-source definitions match disabled baseline=${pkgs.lib.boolToString validation.otherSourceDefinitionsMatch}; helper path=${expectedSnapshotCommandText}";

                  personal = inspectedHost "Brandons-MacBook-Pro" [ ];
                  personalWithoutWatchdog = inspectedHost "Brandons-MacBook-Pro" [
                    {
                      home-manager.users.brandonmcnama.home.hammerspoon.deskflowWatchdog.enable = pkgs.lib.mkForce false;
                    }
                  ];
                  personalCheck = checkConfig {
                    baselineHm = personalWithoutWatchdog;
                    label = "Brandons-MacBook-Pro";
                    hm = personal;
                    expectedEnabled = true;
                    expectedRole = "server";
                  };
                  hostReport = pkgs.lib.concatStringsSep "\n" [
                    personalCheck
                  ];

                  sourceForgedContributionModule = {
                    _file = watchdogDefinitionSource;
                    home.hammerspoon.extraConfig = ''
                      -- forged unconditional watchdog-source contribution
                    '';
                  };
                  sourceForgedHost =
                    hostName: modules:
                    inspectedHost hostName (
                      [
                        {
                          home-manager.sharedModules = [ sourceForgedContributionModule ];
                        }
                      ]
                      ++ modules
                    );
                  sourceForgedPersonal = sourceForgedHost "Brandons-MacBook-Pro" [ ];
                  sourceForgedPersonalWithoutWatchdog = sourceForgedHost "Brandons-MacBook-Pro" [
                    {
                      home-manager.users.brandonmcnama.home.hammerspoon.deskflowWatchdog.enable = pkgs.lib.mkForce false;
                    }
                  ];
                  rejectedConfig =
                    args:
                    assert pkgs.lib.assertMsg (
                      !(builtins.tryEval (builtins.deepSeq (checkConfig args) true)).success
                    ) "hammerspoon Deskflow watchdog wiring source-forged host was accepted: ${args.label}";
                    args.label;
                  sourceForgedReport = pkgs.lib.concatStringsSep ", " [
                    (rejectedConfig {
                      baselineHm = sourceForgedPersonalWithoutWatchdog;
                      label = "source-forged Brandons-MacBook-Pro";
                      hm = sourceForgedPersonal;
                      expectedEnabled = true;
                      expectedRole = "server";
                    })
                  ];

                  emptySnapshotContext = builtins.substring 0 0 expectedSnapshotCommand;
                  canonicalServerContribution = renderDeskflowWatchdog {
                    role = "server";
                    snapshotCommand = expectedSnapshotCommand;
                  };
                  canonicalServerText = builtins.unsafeDiscardStringContext canonicalServerContribution;
                  trustedDefinition = value: {
                    file = watchdogDefinitionSource;
                    inherit value;
                  };
                  inspectServerFixture =
                    contribution: definitions:
                    inspectContribution {
                      inherit contribution definitions;
                      enabled = true;
                      role = "server";
                    };
                  rejectedFixture =
                    label: inspection:
                    assert pkgs.lib.assertMsg (
                      !inspection.valid
                    ) "hammerspoon Deskflow watchdog wiring adversarial fixture was accepted: ${label}";
                    label;
                  commentedScattered = ''
                    ${sentinel}
                    -- local role = "server"
                    -- local snapshotCommand = ${builtins.toJSON expectedSnapshotCommandText}
                  ''
                  + emptySnapshotContext;
                  detachedContextContribution = canonicalServerText + emptySnapshotContext;
                  conflictingRole = ''
                    local role = "client"
                  '';
                  duplicateHelper = ''
                    local snapshotCommand = "/nix/store/00000000000000000000000000000000-forged/bin/deskflow-process-snapshot"
                  '';
                  multipleLocalDeclaration = ''
                    local role, snapshotCommand = "client", "/tmp/forged-helper"
                  '';
                  commentSeparatedDeclarations = ''
                    local role -- comment before assignment
                    = "client"
                    local snapshotCommand -- another comment before assignment
                    = "/tmp/forged-helper"
                  '';
                  forgedHelperContribution =
                    builtins.replaceStrings
                      [ expectedSnapshotCommandText ]
                      [ "/nix/store/00000000000000000000000000000000-forged/bin/deskflow-process-snapshot" ]
                      canonicalServerText
                    + emptySnapshotContext;
                  duplicateSentinel = "\n${sentinel}\n";
                  canonicalServerInspection = inspectServerFixture canonicalServerContribution [
                    (trustedDefinition canonicalServerContribution)
                  ];
                  duplicateRoleInspection = inspectServerFixture (canonicalServerContribution + conflictingRole) [
                    (trustedDefinition canonicalServerContribution)
                    (trustedDefinition conflictingRole)
                  ];
                  duplicateHelperInspection = inspectServerFixture (canonicalServerContribution + duplicateHelper) [
                    (trustedDefinition canonicalServerContribution)
                    (trustedDefinition duplicateHelper)
                  ];
                  multipleLocalInspection =
                    inspectServerFixture (canonicalServerContribution + multipleLocalDeclaration)
                      [
                        (trustedDefinition canonicalServerContribution)
                        (trustedDefinition multipleLocalDeclaration)
                      ];
                  commentSeparatedInspection =
                    inspectServerFixture (canonicalServerContribution + commentSeparatedDeclarations)
                      [
                        (trustedDefinition canonicalServerContribution)
                        (trustedDefinition commentSeparatedDeclarations)
                      ];
                  adversarialReport =
                    assert pkgs.lib.assertMsg canonicalServerInspection.valid
                      "hammerspoon Deskflow watchdog wiring rejected the canonical adversarial baseline";
                    pkgs.lib.concatStringsSep ", " [
                      (rejectedFixture "commented/scattered markers" (
                        inspectServerFixture commentedScattered [ (trustedDefinition commentedScattered) ]
                      ))
                      (rejectedFixture "helper context detached from canonical chunk" (
                        inspectServerFixture detachedContextContribution [
                          (trustedDefinition canonicalServerText)
                          (trustedDefinition emptySnapshotContext)
                        ]
                      ))
                      (rejectedFixture "duplicate/conflicting role declaration" duplicateRoleInspection)
                      (rejectedFixture "duplicate/forged helper declaration" duplicateHelperInspection)
                      (rejectedFixture "multiple local declaration" multipleLocalInspection)
                      (rejectedFixture "comment-separated declarations" commentSeparatedInspection)
                      (rejectedFixture "forged helper in rendered chunk" (
                        inspectServerFixture forgedHelperContribution [
                          (trustedDefinition forgedHelperContribution)
                        ]
                      ))
                      (rejectedFixture "contextless helper in canonical text" (
                        inspectServerFixture canonicalServerText [ (trustedDefinition canonicalServerText) ]
                      ))
                      (rejectedFixture "duplicate sentinel" (
                        inspectServerFixture (canonicalServerContribution + duplicateSentinel) [
                          (trustedDefinition canonicalServerContribution)
                          (trustedDefinition duplicateSentinel)
                        ]
                      ))
                      (rejectedFixture "duplicate canonical chunk" (
                        inspectServerFixture (canonicalServerContribution + canonicalServerContribution) [
                          (trustedDefinition canonicalServerContribution)
                          (trustedDefinition canonicalServerContribution)
                        ]
                      ))
                    ];
                in
                pkgs.runCommand "hammerspoon-deskflow-watchdog-wiring"
                  {
                    inherit
                      adversarialReport
                      hostReport
                      sourceForgedReport
                      ;
                    snapshotHelper = deskflowProcessSnapshot;
                  }
                  ''
                    set -eu
                    test -x "$snapshotHelper/bin/deskflow-process-snapshot"
                    printf '%s\n' "$hostReport" > "$out"
                    printf 'canonical fixture accepted; adversarial fixtures rejected: %s\n' "$adversarialReport" >> "$out"
                    printf 'actual host predicate rejected source-forged hosts: %s\n' "$sourceForgedReport" >> "$out"
                  '';
            }
          );

          # Deskflow renderer checks (deskflow-config spec, task 4.1; design
          # "#### flake.nix checks (aarch64-darwin)" deskflow-render bullet +
          # "## Testing Strategy"). aarch64-gated optionalAttrs let-binding so
          # task 4.2 can add deskflow-host-wiring to the same attrset. Imports
          # the PURE renderer with fully-resolved fixtures and forces the
          # rendered text via Nix-level assertMsg gating a trivial runCommand
          # (mirroring the hammerspoon checks), so the asserts fire in CI
          # without a host switch (design "Error Handling": checks force .text).
          deskflowChecks = pkgs.lib.optionalAttrs (system == "aarch64-darwin") (
            let
              inherit (pkgs) lib;
              renderDeskflow = import ./home-manager/common/deskflow/render.nix {
                inherit (pkgs) lib;
              };

              # Fully-resolved base client snapshot: every field render.nix
              # reads, so the derived fixtures override only what they exercise.
              # externalConfigFile is a neutral placeholder path (not a real
              # host path) to satisfy the no-hardcoded-/Users pre-commit hook.
              clientFix = {
                enable = true;
                role = "client";
                computerName = null;
                port = 24800;
                tls = {
                  enable = true;
                  checkFingerprints = true;
                  certificateFile = null;
                  keySize = 2048;
                  trustedFingerprints = [ ];
                };
                log = {
                  level = "INFO";
                  toFile = false;
                  file = null;
                };
                gui = {
                  startCoreWithGui = true;
                  closeToTray = true;
                  autoHide = false;
                  enableUpdateCheck = false;
                  closeReminder = false;
                  showGenericClientFailureDialog = false;
                  shownFirstConnectedMessage = true;
                  shownServerFirstStartMessage = true;
                };
                client = {
                  remoteHost = "myserver";
                  invertScroll = {
                    x = false;
                    y = false;
                  };
                  scrollScale = {
                    x = 1.0;
                    y = 1.0;
                  };
                  languageSync = true;
                };
                server = {
                  externalConfigFile = "/home/x/Library/Deskflow/deskflow-server.conf";
                  screens = [ ];
                  aliases = { };
                  links = [ ];
                  options = { };
                };
              };

              # Server fixture: two ordered screens plus one rightward link, so
              # the layout exercises ordered `section: screens`/`section: links`.
              serverFix = clientFix // {
                role = "server";
                server = clientFix.server // {
                  screens = [
                    { name = "deskhub"; }
                    { name = "laptop"; }
                  ];
                  links = [
                    {
                      from = "deskhub";
                      direction = "right";
                      to = "laptop";
                      fromRange = null;
                      toRange = null;
                    }
                  ];
                };
              };

              # Personal-host cert SHA-256 (public hash; 64 lowercase hex).
              trustedFp = "4a9f1514fc4bf5af3dec2f62b272fa84188e4d6554c53146a98fe761d7cf2701";
              trustedFpFix = clientFix // {
                tls = clientFix.tls // {
                  trustedFingerprints = [ trustedFp ];
                };
              };
              # Malformed fingerprint (not 64-hex/40-hex): render must abort.
              invalidFpFix = clientFix // {
                tls = clientFix.tls // {
                  trustedFingerprints = [ "nothex" ];
                };
              };

              clientSettings = (renderDeskflow clientFix).settings;
              serverLayout = (renderDeskflow serverFix).serverConfig;
              trustOut = (renderDeskflow trustedFpFix).trustText;

              modalSuppressionLines = [
                "enableUpdateCheck=false"
                "closeReminder=false"
                "showGenericClientFailureDialog=false"
                "shownFirstConnectedMessage=true"
                "shownServerFirstStartMessage=true"
              ];
              missingModalSuppressionLines = lib.filter (
                line: !lib.hasInfix line clientSettings
              ) modalSuppressionLines;

              # Empty-value guard (Req 7.3): a curated key rendered with no value
              # is a run of non-`=` chars followed by a trailing `=` and nothing
              # else (`key=`). `coreMode=1`, section headers, and blank lines do
              # not match; the filtered list must be empty.
              emptyValueLines = lib.filter (line: builtins.match "[^=]*=" line != null) (
                lib.splitString "\n" clientSettings
              );

              # An invalid fingerprint must abort evaluation (Req 7.4, 8.4). The
              # renderer's assertMsg/throw is caught by tryEval; force trustText
              # to WHNF with seq so the throw actually fires.
              invalidEval = builtins.tryEval (builtins.seq (renderDeskflow invalidFpFix).trustText null);

              # Forcing this string forces the assert chain (it is passed to the
              # derivation env below), so any regression fails the build.
              report =
                assert lib.assertMsg (lib.hasInfix "coreMode=1" clientSettings)
                  "deskflow-render: client settings must contain coreMode=1 (client mode, Req 7.1).";
                assert lib.assertMsg (lib.hasInfix ''remoteHost="myserver"'' clientSettings)
                  ''deskflow-render: client settings must contain a quoted remoteHost="myserver" (design deskflow-render bullet).'';
                assert lib.assertMsg (missingModalSuppressionLines == [ ])
                  "deskflow-render: client settings must contain all modal-suppression lines; missing [ ${lib.concatStringsSep ", " missingModalSuppressionLines} ].";
                assert lib.assertMsg (lib.hasInfix "section: screens" serverLayout)
                  "deskflow-render: server layout must contain 'section: screens' (Req 7.2).";
                assert lib.assertMsg (lib.hasInfix "deskhub" serverLayout)
                  "deskflow-render: server layout must name the 'deskhub' screen (Req 7.2).";
                assert lib.assertMsg (lib.hasInfix "laptop" serverLayout)
                  "deskflow-render: server layout must name the 'laptop' screen (Req 7.2).";
                assert lib.assertMsg (lib.hasInfix "section: links" serverLayout)
                  "deskflow-render: server layout must contain 'section: links' (Req 7.2).";
                assert lib.assertMsg (lib.hasInfix "right = laptop" serverLayout)
                  "deskflow-render: server layout must contain the rendered link 'right = laptop' (Req 7.2).";
                assert lib.assertMsg (emptyValueLines == [ ])
                  "deskflow-render: client settings contains empty-valued key line(s) [ ${lib.concatStringsSep ", " emptyValueLines} ] (Req 7.3).";
                assert lib.assertMsg (lib.hasInfix "v2:sha256:${trustedFp}" trustOut)
                  "deskflow-render: trust text must contain the 'v2:sha256:${trustedFp}' line (Req 7.4, 8.3).";
                assert lib.assertMsg (
                  !invalidEval.success
                ) "deskflow-render: invalid fingerprint fixture should fail evaluation but did not (Req 7.4, 8.4).";
                ''
                  deskflow-render fixtures asserted:
                    client : coreMode=1 + quoted remoteHost
                    modals : update, close, connection-error, first-connected, and first-server-start dialogs suppressed
                    server : ordered section: screens (deskhub, laptop) + section: links (right = laptop)
                    guard  : no empty-valued curated key lines
                    trust  : v2:sha256:<hex> line present
                    invalid: malformed fingerprint fixture fails evaluation
                '';
            in
            {
              deskflow-render = pkgs.runCommand "deskflow-render" { inherit report; } ''
                printf '%s\n' "$report" > $out
              '';

              # Host-wiring eval assertions (personal host) — deskflow-config spec
              # task 4.2 plus the personal-host server adoption. Pure eval over
              # each darwin host config plus a trivial runCommand; shares the
              # aarch64 gate above (it reads self.darwinConfigurations). Forcing
              # the per-host report forces, per host, assertions each naming the
              # host and the failing property:
              #   Brandons-MacBook-Pro (server): home.deskflow enabled in the
              #     server role; Deskflow.conf carries coreMode=2 + tlsEnabled=true,
              #     port=24800, keySize=4096 and a pinned certificate path; the
              #     rendered deskflow-server.conf defines the remaining screen
              #     layout (Req 6.1/7.1/8.1/8.2/4.3).
              deskflow-host-wiring =
                let
                  # Expected role for the remaining personal host.
                  expectedRoles = {
                    "Brandons-MacBook-Pro" = "server";
                  };
                  checkHost =
                    hostName: expectedRole:
                    let
                      hm = self.darwinConfigurations.${hostName}.config.home-manager.users.brandonmcnama;
                      cfg = hm.home.deskflow;
                      settings = hm.home.file."Library/Deskflow/Deskflow.conf".text;
                      missingModalSuppressionLines = lib.filter (line: !lib.hasInfix line settings) modalSuppressionLines;
                    in
                    assert lib.assertMsg cfg.enable
                      "deskflow host-wiring: ${hostName} must have home.deskflow.enable=true (Req 6.1).";
                    assert lib.assertMsg (cfg.role == expectedRole)
                      "deskflow host-wiring: ${hostName} home.deskflow.role must be \"${expectedRole}\", got \"${toString cfg.role}\" (Req 6.1).";
                    assert lib.assertMsg (lib.hasInfix "tlsEnabled=true" settings)
                      "deskflow host-wiring: ${hostName} rendered Deskflow.conf must contain tlsEnabled=true (Req 7.1).";
                    assert lib.assertMsg (lib.hasInfix "port=24800" settings)
                      "deskflow host-wiring: ${hostName} rendered Deskflow.conf must contain port=24800 (Req 7.1).";
                    assert lib.assertMsg (missingModalSuppressionLines == [ ])
                      "deskflow host-wiring: ${hostName} Deskflow.conf must contain all modal-suppression lines; missing [ ${lib.concatStringsSep ", " missingModalSuppressionLines} ].";
                    let
                      layout = hm.home.file."Library/Deskflow/deskflow-server.conf".text;
                    in
                    assert lib.assertMsg (lib.hasInfix "coreMode=2" settings)
                      "deskflow host-wiring: ${hostName} Deskflow.conf must contain coreMode=2 (server mode, Req 7.1).";
                    assert lib.assertMsg (lib.hasInfix "keySize=4096" settings)
                      "deskflow host-wiring: ${hostName} Deskflow.conf must contain keySize=4096 (Req 8.2).";
                    assert lib.assertMsg (lib.hasInfix "certificate=" settings)
                      "deskflow host-wiring: ${hostName} Deskflow.conf must pin a certificate path (Req 8.1).";
                    assert lib.assertMsg (lib.hasInfix "Brandons-MacBook-Pro.local" layout)
                      "deskflow host-wiring: ${hostName} deskflow-server.conf must define the personal screen (Req 4.3).";
                    "${hostName}: enable=true role=\"server\"; coreMode=2, tlsEnabled=true, port=24800, keySize=4096, cert pinned; personal layout present";
                in
                pkgs.runCommand "deskflow-host-wiring"
                  {
                    hostReport = lib.concatStringsSep "\n" (lib.mapAttrsToList checkHost expectedRoles);
                  }
                  ''
                    printf '%s\n' "$hostReport" > $out
                  '';
            }
          );

          agentMemoryHostMatrix = import ./tests/agentmemory-opencode/host-matrix.nix {
            inherit pkgs self;
          };

          agentMemoryPersonalSecretValidation =
            import ./tests/agentmemory-opencode/personal-secret-validation.nix
              {
                inherit pkgs self;
              };

          agentMemorySecretActivator = pkgs.callPackage ./scripts/mcp-secrets-activate.nix { };

          agentMemoryMissingSecretActivation =
            import ./tests/agentmemory-opencode/missing-secret-activation.nix
              {
                activator = agentMemorySecretActivator;
                inherit pkgs;
              };

          agentMemoryObsidianImporter = pkgs.callPackage ./scripts/agentmemory-import-obsidian.nix {
            bearerReference = "fixture-bearer";
            restEndpoint = "http://127.0.0.1:3111";
          };

          agentMemoryChecks = pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            agentmemory-opencode-matrix =
              pkgs.runCommand "agentmemory-opencode-matrix"
                {
                  nativeBuildInputs = [
                    pkgs.git
                    pkgs.iii-engine
                    pkgs.nix
                    pkgs.nodejs
                    pkgs.nodejs_22
                    pkgs.lsof
                    pkgs.ps
                    # The AgentMemory CLI discovers the pinned iii binary via `which`.
                    pkgs.which
                  ];
                  inherit agentMemoryHostMatrix;
                  AGENTMEMORY_MISSING_SECRET_ACTIVATION_PROOF = agentMemoryMissingSecretActivation;
                  AGENTMEMORY_PERSONAL_SECRET_VALIDATION = agentMemoryPersonalSecretValidation;
                  AGENTMEMORY_OBSIDIAN_NODE_BIN = "${pkgs.nodejs_22}/bin/node";
                  AGENTMEMORY_OBSIDIAN_NODE_PATH = "${pkgs.obsidian-importer-deps}/lib/node_modules";
                  AGENTMEMORY_OBSIDIAN_IMPORTER_BIN = "${agentMemoryObsidianImporter}/bin/agentmemory-import-obsidian";
                  AGENTMEMORY_PACKAGE_PATH = agentMemoryPackage;
                  MCPPROXY_PACKAGE_PATH = pkgs.mcpproxy-go;
                }
                ''
                  export HOME=$(mktemp -d)
                  export NIX_CONFIG="experimental-features = nix-command flakes"
                  export AGENTMEMORY_MATRIX_HOSTS="$agentMemoryHostMatrix"
                  cp -R ${./.} source
                  chmod -R u+w source
                  cd source
                  node tests/agentmemory-opencode/index.js
                  touch $out
                '';
          };

          # Offline gh-stack-mcp verification (tasks 3.4 and 5). The nested host
          # evaluator disables unrelated Shopify-only skill and extension
          # sources so it does not fetch private repositories. The package
          # output remains a dependency, while the explicit vendored Go test
          # covers all packages. Node renders both hosts, exercises proxy
          # routing and failure isolation against local stdio fixtures, and
          # checks the operator runbook without contacting live GitHub
          # (Req 1.1, 1.6, 8.5-8.6, 9.7-9.9, 10.11-10.12, 11.1-11.4).
          ghStackMcpChecks = pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            gh-stack-mcp =
              pkgs.runCommand "gh-stack-mcp"
                {
                  nativeBuildInputs = [
                    pkgs.git
                    pkgs.go_1_26
                    pkgs.nix
                    pkgs.nodejs
                    pkgs.gh-stack-mcp
                    pkgs.mcpproxy-go
                  ];
                  goModules = pkgs.gh-stack-mcp.goModules;
                  GH_STACK_MCP_OFFLINE_HOST_RENDER = "1";
                  GH_STACK_MCP_PACKAGE_PATH = pkgs.gh-stack-mcp;
                  MCPPROXY_PACKAGE_PATH = pkgs.mcpproxy-go;
                }
                ''
                  export HOME="$(mktemp -d)"
                  export NIX_CONFIG="experimental-features = nix-command flakes"
                  export GOPROXY=off
                  export GOSUMDB=off
                  export GOTOOLCHAIN=local
                  cp -R ${./.} source
                  chmod -R u+w source
                  mkdir -p source/scripts/gh-stack-mcp/vendor
                  cp -R "$goModules"/. source/scripts/gh-stack-mcp/vendor/
                  chmod -R u+w source/scripts/gh-stack-mcp/vendor
                  (
                    cd source/scripts/gh-stack-mcp
                    go test -mod=vendor ./...
                  )
                  cd source
                  node --test \
                    tests/gh-stack-mcp/hm-render.test.js \
                    tests/gh-stack-mcp/proxy-contract.test.js \
                    tests/gh-stack-mcp/runbook.test.js
                  touch "$out"
                '';
          };
        in
        nixvimTests
        // hammerspoonChecks
        // deskflowChecks
        // agentMemoryChecks
        // ghStackMcpChecks
        // rec {
          formatting = treefmtEval.${system}.config.build.check self;

          subagent-context-budget-tests =
            pkgs.runCommand "subagent-context-budget-tests"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                ];
                # Keep nested Home Manager evaluation offline for private Shopify-only sources.
                GH_STACK_MCP_OFFLINE_HOST_RENDER = "1";
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

          omlx-service =
            pkgs.runCommand "omlx-service"
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
                node --test tests/omlx-service/
                touch $out
              '';

          fabro-service =
            pkgs.runCommand "fabro-service"
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
                node --test tests/fabro-service/
                touch $out
              '';

          # lima-vm module node tests (render assertions over a standalone
          # homeManagerConfiguration + personal-host wiring).
          lima-vm-service =
            pkgs.runCommand "lima-vm-service"
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
                node --test tests/lima-vm/
                touch $out
              '';

          # Schema-validate the personal host's rendered Lima YAML with the
          # same limactl the launchd service uses (`limactl validate` is
          # offline; no VM or Linux builder needed).
          lima-vm-config-validate =
            let
              limaConfigYaml =
                self.darwinConfigurations."Brandons-MacBook-Pro".config.home-manager.users.brandonmcnama.virtualisation.limaVM._configYaml;
            in
            assert pkgs.lib.assertMsg (limaConfigYaml != null)
              "lima-vm-config-validate: the personal host's virtualisation.limaVM._configYaml is null (module disabled?).";
            pkgs.runCommand "lima-vm-config-validate"
              {
                configYaml = limaConfigYaml;
                nativeBuildInputs = [ pkgs.unstable.lima ];
              }
              ''
                export HOME=$(mktemp -d)
                export USER=nix
                limactl validate "$configYaml"
                touch $out
              '';

          # Eval assertions for the fabro NixOS guest (pure eval over
          # nixosConfigurations.fabro-vm + trivial runCommand; no Linux
          # builder needed — building packages.aarch64-linux.fabro-vm-image
          # does).
          fabro-vm-guest-eval =
            let
              vm = self.nixosConfigurations.fabro-vm.config;
              guestReport =
                assert pkgs.lib.assertMsg vm.services.lima.enable
                  "fabro-vm: services.lima must be enabled (lima-init + guestagent).";
                assert pkgs.lib.assertMsg vm.services.openssh.enable
                  "fabro-vm: services.openssh must be enabled (Lima connects over SSH).";
                assert pkgs.lib.assertMsg (
                  !vm.security.sudo.wheelNeedsPassword
                ) "fabro-vm: the cidata user needs passwordless sudo for Lima provisioning.";
                assert pkgs.lib.assertMsg vm.users.mutableUsers
                  "fabro-vm: users.mutableUsers must stay true (lima-init creates the user imperatively).";
                assert pkgs.lib.assertMsg (builtins.elem "nix-command" (
                  vm.nix.settings.experimental-features or [ ]
                )) "fabro-vm: guest nix must enable the nix-command experimental feature.";
                assert pkgs.lib.assertMsg (builtins.elem "flakes" (
                  vm.nix.settings.experimental-features or [ ]
                )) "fabro-vm: guest nix must enable the flakes experimental feature.";
                assert pkgs.lib.assertMsg vm.virtualisation.docker.enable
                  "fabro-vm: virtualisation.docker must be enabled (the host's only service for now).";
                assert pkgs.lib.assertMsg (builtins.any (p: (p.pname or p.name or "") == "fabro")
                  vm.environment.systemPackages
                ) "fabro-vm: environment.systemPackages must contain the fabro package.";
                assert pkgs.lib.assertMsg (builtins.any (p: (p.pname or p.name or "") == "litellm")
                  vm.environment.systemPackages
                ) "fabro-vm: environment.systemPackages must contain the litellm package.";
                assert pkgs.lib.assertMsg (
                  (self.nixosConfigurations.fabro-vm.pkgs.fabro.pname or "") == "fabro"
                ) "fabro-vm: pkgs.fabro must resolve through the repo's fabro overlay.";
                assert pkgs.lib.assertMsg vm.services.litellm.enable
                  "fabro-vm: services.litellm must be enabled (the loopback LLM gateway).";
                assert pkgs.lib.assertMsg (
                  vm.systemd.services ? fabro
                ) "fabro-vm: systemd.services.fabro must be defined.";
                assert pkgs.lib.assertMsg (builtins.elem "litellm.service" vm.systemd.services.fabro.requires)
                  "fabro-vm: systemd.services.fabro must require litellm.service.";
                assert pkgs.lib.assertMsg (builtins.elem "docker.service" vm.systemd.services.fabro.requires)
                  "fabro-vm: systemd.services.fabro must require docker.service.";
                assert pkgs.lib.assertMsg (builtins.elem "litellm.service" vm.systemd.services.fabro.after)
                  "fabro-vm: systemd.services.fabro must start after litellm.service.";
                assert pkgs.lib.assertMsg (builtins.elem "docker.service" vm.systemd.services.fabro.after)
                  "fabro-vm: systemd.services.fabro must start after docker.service.";
                assert pkgs.lib.assertMsg (
                  vm.sops.age.keyFile == "/var/lib/sops-nix/key.txt"
                ) "fabro-vm: sops.age.keyFile must point at the guest's age key.";
                assert pkgs.lib.assertMsg
                  (
                    builtins.hasAttr "fabro-session-secret" vm.sops.secrets
                    && builtins.hasAttr "fabro-dev-token" vm.sops.secrets
                    && builtins.hasAttr "litellm-master-key" vm.sops.secrets
                    && builtins.hasAttr "github-token" vm.sops.secrets
                  )
                  "fabro-vm: sops.secrets must declare the fabro auth pair, the litellm master key, and the host GitHub PAT.";
                assert pkgs.lib.assertMsg (builtins.all (k: vm.sops.secrets ? "${k}") (
                  builtins.attrNames vm.fabro.onePasswordSecrets
                )) "fabro-vm: every fabro.onePasswordSecrets manifest key must be declared in sops.secrets.";
                assert pkgs.lib.assertMsg (
                  vm.systemd.services.fabro.serviceConfig.EnvironmentFile == vm.sops.templates."fabro-env".path
                ) "fabro-vm: the fabro service must consume the sops-rendered env file.";
                assert pkgs.lib.assertMsg (
                  !(vm.systemd.services.fabro.serviceConfig.DynamicUser or false)
                  && (vm.systemd.services.fabro.serviceConfig.User or "") == "brandonmcnama"
                ) "fabro-vm: the fabro service must run as the Lima cidata user (the state share's VZ identity).";
                assert pkgs.lib.assertMsg
                  (
                    builtins.elem "/var/lib/fabro" (vm.systemd.services.fabro.serviceConfig.ReadWritePaths or [ ])
                    && builtins.elem "/var/lib/fabro" (
                      let
                        rmf = vm.systemd.services.fabro.unitConfig.RequiresMountsFor or "";
                      in
                      if builtins.isString rmf then pkgs.lib.splitString " " rmf else rmf
                    )
                    # Render the actual unit file, so a misnested
                    # serviceConfig/unitConfig key (or any other
                    # set-coercion failure in the unit) fails the check
                    # instead of the guest at switch time.
                    && pkgs.lib.hasInfix "RequiresMountsFor=/var/lib/fabro" vm.systemd.units."fabro.service".text
                  )
                  "fabro-vm: the fabro service must get ReadWritePaths + RequiresMountsFor on /var/lib/fabro (the host state share).";
                assert pkgs.lib.assertMsg (builtins.elem "lima-init.service" (
                  vm.systemd.services.fabro.after or [ ]
                )) "fabro-vm: the fabro service must start after lima-init (which mounts the state share).";
                assert pkgs.lib.assertMsg (builtins.any (p: p.name or "" == "virtio-fs")
                  vm.boot.kernelPatches
                ) "fabro-vm: the kernel must ship the virtio-fs patch (VIRTIO_FS=m) for the state share.";
                assert pkgs.lib.assertMsg (
                  vm.systemd.services.litellm.serviceConfig.EnvironmentFile
                  == [ vm.sops.templates."litellm-env".path ]
                ) "fabro-vm: the litellm service must load LITELLM_MASTER_KEY from the sops template.";
                assert pkgs.lib.assertMsg (builtins.hasAttr "opencode-api-key" vm.sops.secrets)
                  "fabro-vm: sops.secrets must declare the opencode provider key.";
                assert pkgs.lib.assertMsg (
                  pkgs.lib.hasInfix "OPENCODE_API_KEY=" vm.sops.templates."litellm-env".content
                  && pkgs.lib.hasInfix vm.sops.placeholder."opencode-api-key" vm.sops.templates."litellm-env".content
                ) "fabro-vm: the litellm env template must export OPENCODE_API_KEY from the sops store.";
                assert pkgs.lib.assertMsg (
                  vm.sops.templates."fabro-env".restartUnits == [ "fabro.service" ]
                  && vm.sops.templates."litellm-env".restartUnits == [ "litellm.service" ]
                ) "fabro-vm: sops templates must restart their consumers when the rendered values change.";
                assert pkgs.lib.assertMsg vm.services.tailscale.enable
                  "fabro-vm: services.tailscale must be enabled (tailnet node + service host).";
                assert pkgs.lib.assertMsg (
                  builtins.hasAttr "tailscale-oauth-secret" vm.sops.secrets
                  && vm.services.tailscale.authKeyFile == vm.sops.secrets."tailscale-oauth-secret".path
                ) "fabro-vm: the tailscale auth key must come from the sops store (tailscale-oauth-secret).";
                assert pkgs.lib.assertMsg (
                  vm.services.tailscale.extraUpFlags == [ "--advertise-tags=tag:fabro" ]
                ) "fabro-vm: tailscale must register the guest as tag:fabro (the OAuth client's granted tag).";
                assert pkgs.lib.assertMsg (
                  builtins.elem "tailscaled-autoconnect.service" vm.systemd.services.tailscale-serve.after
                  && builtins.elem "tailscaled-autoconnect.service" vm.systemd.services.tailscale-serve.requires
                ) "fabro-vm: tailscale-serve must run after tailscaled registration completes.";
                assert pkgs.lib.assertMsg
                  (
                    builtins.hasAttr "ExecStart" vm.systemd.services.tailscale-serve.serviceConfig
                    && builtins.length vm.systemd.services.tailscale-serve.serviceConfig.ExecStart == 2
                    && pkgs.lib.hasInfix "--service=svc:fabro --https=443 http://127.0.0.1:32276" (
                      builtins.concatStringsSep " " vm.systemd.services.tailscale-serve.serviceConfig.ExecStart
                    )
                    && pkgs.lib.hasInfix "--service=svc:litellm --https=443 http://127.0.0.1:4000" (
                      builtins.concatStringsSep " " vm.systemd.services.tailscale-serve.serviceConfig.ExecStart
                    )
                  )
                  "fabro-vm: tailscale-serve must advertise svc:fabro and svc:litellm per the console resource defs (tcp:443 / tcp:443).";
                assert pkgs.lib.assertMsg (
                  !(vm.systemd.services ? mcpproxy)
                ) "fabro-vm: no mcpproxy unit in the guest (the gateway is deliberately not installed).";
                assert pkgs.lib.assertMsg (
                  !builtins.any (p: (p.pname or p.name or "") == "mcpproxy-go") vm.environment.systemPackages
                ) "fabro-vm: mcpproxy-go must not be in the guest systemPackages.";
                "fabro-vm (aarch64-linux): services.lima=true; openssh=true; docker=true; litellm+fabro systemd services with fabro→{litellm,docker} requires+after; sops store secrets/fabro.fabro.yaml decrypted to /run/secrets via the guest age key (six keys; fabro.onePasswordSecrets maps each to its 1Password source and drives fabro-sync-from-1password); fabro consumes sops.templates.\"fabro-env\", litellm LITELLM_MASTER_KEY via sops.templates.\"litellm-env\"; tailscale registered from the sops OAuth secret (tag:fabro, preauthorized, non-ephemeral) with svc:fabro tcp:443→127.0.0.1:32276 and svc:litellm tcp:443→127.0.0.1:4000 advertised after registration; fabro state lives on the host via the VZ virtiofs share /var/lib/fabro←~/.local/state/fabro (kernel VIRTIO_FS=m via the virtio-fs patch; service runs as the Lima cidata user with ReadWritePaths+RequiresMountsFor); sudo.wheelNeedsPassword=false; mutableUsers=true; nix experimental-features=[nix-command flakes]; systemPackages has fabro+litellm; overlays=[fabro]";
            in
            pkgs.runCommand "fabro-vm-guest-eval"
              {
                inherit guestReport;
              }
              ''
                printf '%s\n' "$guestReport" > "$out"
              '';

          litellm-service =
            pkgs.runCommand "litellm-service"
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
                node --test tests/litellm-service/
                touch $out
              '';

          sqlite-backup-tests = import ./tests/sqlite-backup {
            inherit pkgs;
            inherit (inputs) home-manager;
            realLitestream = if system == "aarch64-darwin" then pkgs.litestream else null;
          };

          local-binary-cache-render =
            let
              publisherValidatorFixture = pkgs.writeShellScriptBin "local-binary-cache-publish" ''
                exit 0
              '';
            in
            pkgs.runCommand "local-binary-cache-render"
              {
                ATTIC_CLIENT_EXECUTABLE = pkgs.lib.getExe pkgs.unstable.attic-client;
                ATTIC_CLIENT_SOURCE = pkgs.unstable.attic-client.src;
                PUBLISHER_VALIDATOR_EXECUTABLE = pkgs.lib.getExe publisherValidatorFixture;
                nativeBuildInputs = [
                  pkgs.bash
                  pkgs.nix
                  pkgs.nodejs
                  pkgs.openssl
                  pkgs.sops
                ];
                moduleTest = import ./tests/local-binary-cache/module.test.nix { inherit pkgs; };
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                test -e "$moduleTest"
                bash tests/local-binary-cache/module-errors.test.sh
                node --test \
                  tests/local-binary-cache/identity-artifacts.test.js \
                  tests/local-binary-cache/outage-evidence.test.js \
                  tests/local-binary-cache/outage-publisher-control.test.js \
                  tests/local-binary-cache/outage-restore.test.js \
                  tests/local-binary-cache/outage-runner.test.js \
                  tests/local-binary-cache/outage-smoke.test.js \
                  tests/local-binary-cache/publisher-runtime-render.test.js \
                  tests/local-binary-cache/system-render.test.js
                touch $out
              '';

          local-binary-cache-publisher =
            pkgs.runCommand "local-binary-cache-publisher"
              {
                ATTIC_CLIENT_EXECUTABLE = pkgs.lib.getExe pkgs.unstable.attic-client;
                ATTIC_CLIENT_SOURCE = pkgs.unstable.attic-client.src;
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
                node --test tests/local-binary-cache/publisher.test.js
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
                OPENCODE_NONO_HOSTS = agentMemoryHostMatrix;
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
                  pkgs.nodejs_22
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

          inherit (pkgs) github-mcp-server;

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

          git-mcp =
            pkgs.runCommand "git-mcp"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                  pkgs.go
                  pkgs.stdenv.cc
                  pkgs.apple-sdk
                  pkgs.git
                  pkgs.openssh
                  pkgs.mcpproxy-go
                  pkgs.coreutils
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                export GIT_MCP_CHECK_RUNTIME=1
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                go -C scripts/git-mcp-secure-enclave-signer test ./...
                go -C tests/git-mcp/fixtures test ./...
                # The signer suite owns a fixed real-time worker deadline, so
                # run each contract suite in a fresh Node process.
                node --test tests/git-mcp/fixtures/signing-tools.test.js
                node --test tests/git-mcp/signer-adapter.test.js
                node --test tests/git-mcp/hm-render.test.js
                node --test tests/git-mcp/admin-contract.test.js
                node --test tests/git-mcp/upstream-isolation.test.js
                node --test tests/git-mcp/acceptance-client.test.js
                touch $out
              '';

          # Renderer + syntax-gate verification for hammerspoon-keybindings
          # (Task 8.2). System-agnostic — pure `nix eval` of render.nix over
          # fixtures.nix plus `luac -p` (the exact gate checked-config.nix
          # runs), so it needs no Hammerspoon bundle or host (Req 4.4) and lives
          # here rather than the aarch64-gated `hammerspoonChecks`. The node
          # tests assert render content per action type (4.2), eval-abort on
          # malformed sets (4.3), and luac accept/reject on valid/broken Lua
          # (5.1/5.3). `pkgs.lua5_4` supplies the `luac` parser binary.
          hammerspoon-keybindings =
            pkgs.runCommand "hammerspoon-keybindings"
              {
                nativeBuildInputs = [
                  pkgs.nix
                  pkgs.nodejs
                  pkgs.lua5_4
                ];
              }
              ''
                export HOME=$(mktemp -d)
                export NIX_CONFIG="experimental-features = nix-command flakes"
                cp -R ${./.} source
                chmod -R u+w source
                cd source
                node --test tests/hammerspoon-keybindings/
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
              flake-checker = {
                enable = true;
                # flake-checker 0.2.11 (shipped by both nixpkgs 25.11 and
                # 26.05) carries a baked-in allowlist of "supported" nixpkgs
                # branches that predates 26.05, so it false-flags the
                # nixpkgs-26.05-darwin input as unsupported and fails the hook.
                # Disable ONLY that sub-check via its env toggle while keeping
                # the outdated- and owner-checks active. Drop this override once
                # a flake-checker that recognizes 26.05 lands in nixpkgs.
                entry = pkgs.lib.mkForce "${pkgs.writeShellScript "flake-checker-skip-supported" ''
                  export NIX_FLAKE_CHECKER_CHECK_SUPPORTED=false
                  exec ${pkgs.flake-checker}/bin/flake-checker -f "$@"
                ''}";
              };

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
                entry = "${pkgs.bash}/bin/bash -c '${pkgs.gnugrep}/bin/grep -rn \"builtins\\.fetchGit\\|builtins\\.fetchTarball\\|builtins\\.fetchurl\" --include=\"*.nix\" --exclude=flake.nix && exit 1 || exit 0'";
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
              pkgs.nodejs
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

      # Host configurations. `Brandons-MacBook-Pro` runs nix-darwin; the
      # fabro host is the NixOS guest of its Lima VM (branch: other top-level
      # configurations would go here for e.g. a physical fabro box).
      #
      # fabro-vm uses the flake's nixpkgs and nixos-lima's guest module.
      # aarch64-linux only: the VZ driver requires a native-architecture
      # guest and the Lima hosts here run Apple Silicon. Evaluable anywhere;
      # building packages.aarch64-linux.fabro-vm-image needs a Linux
      # builder. The fabro overlay applies so the guest gets the same
      # release-binary package the mac had.
      nixosConfigurations.fabro-vm = inputs.nixpkgs.lib.nixosSystem {
        system = "aarch64-linux";
        modules = [
          inputs.nixos-lima.nixosModules.lima
          # Encrypted store wiring: configurations/fabro-vm declares
          # `sops.secrets` from secrets/fabro.fabro.yaml (guest owns the
          # `&host_fabro` recipient; private key at
          # /var/lib/sops-nix/key.txt in the guest).
          inputs.sops-nix.nixosModules.default
          {
            nixpkgs.overlays = [ outputs.overlays.fabro ];
          }
          ./configurations/fabro-vm
        ];
        specialArgs = {
          inherit (inputs) rsync34;
        };
      };

      # qcow-efi boot image for the fabro Lima VM guest (`system.build.qcow-efi`
      # on nixosConfigurations.fabro-vm), the same format nixos-lima builds its
      # release images with. The personal host boots the pinned upstream
      # RELEASE image by default (home-manager/common/lima-vm.nix `image`
      # default); switch that module's `image.location` to this output's
      # `nixos.qcow2` store path (digest null) once the image can be built.
      packages.aarch64-linux.fabro-vm-image =
        self.nixosConfigurations.fabro-vm.config.system.build.qcow-efi;

      darwinConfigurations = {
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
