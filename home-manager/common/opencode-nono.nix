/*
  home-manager/common/opencode-nono.nix — the `programs.opencode-nono`
  Home Manager module (opencode-nono-sandbox spec, Tasks 3.1 + 3.2;
  Requirements 1.1, 2.1, 2.2, 2.3, 2.5, 3.1, 4.1, 4.3, 4.5, 5.3, 7.1,
  7.2, 7.3).

  Task 3.1 scope is the option surface, package selection with operator
  override, rollout-state controls, and the peer assertion. Task 3.2 adds
  the typed profile catalog model and the renderer that emits three base
  profiles (`opencode-managed`, `opencode-audit`, `opencode-review`) as
  JSON to `~/.config/nono/profiles/` via `xdg.configFile`. The rendered
  metadata + operator guide (Task 3.3), the outer launcher, and the
  validate/smoke-test scripts are later tasks; this module declares only
  what 3.1 + 3.2 own and does not reference constructs that do not exist
  yet.

  Design references: "Boundary Commitments → This Spec Owns", the
  "Rollout Controls" and "Package Provision" component sections, the
  "State Resolver / Outer Launcher → State Management" states
  (`disabled | audit | enforced`), and the "Profile Catalog Renderer"
  component (incl. the `NonoProfileModel` interface, per-profile deltas,
  and Implementation Notes) plus "Data Models" (profile file paths).

  Peer dependency: asserts at HM-evaluation time that
  `programs.opencode.enable` is true on the same host (mirrors
  `opencode-rtk.nix` / `opencode-nono-audit.nix`). Without the managed
  OpenCode wrapper there is no OpenCode launch for nono to sandbox.

  Profile catalog (Task 3.2): nono 0.61.1 has NO built-in `opencode`
  profile (removed; only `default` + dev profiles remain), so each base
  profile `extends ["default"]` and reconstructs the opencode grant set
  empirically derived in Tasks 2.1/2.2:
    - `groups.include = [node_runtime nix_runtime user_caches_macos]` —
      all exist on 0.61.1; `nix_runtime` supplies `/nix/store` exec
      coverage. `git_config` is deliberately NOT included: agents perform
      git through the `git-mcp` base server (mcpproxy, outside the
      sandbox), so direct git config access is denied here. Each profile
      also denies `~/.config/git` via `filesystem.deny`.
    - `filesystem.allow` for the seven opencode data paths (rendered as
      `$HOME`/`$TMPDIR` literals; nono expands them at runtime, confirmed
      by Task 2.2's scratch profile and by `nono profile validate` on
      0.61.1).
  Per-profile deltas mirror the design's Profile Catalog Renderer.

  Secret-free invariant (R2.5, R4.5): NO secret literals, NO
  `env_credentials`, NO provider keys/tokens anywhere. `allow_vars` lists
  environment variable NAMES only — the launcher exports the values at
  runtime; values are never serialized. NO Keychain / `/usr/bin/security`
  / `/usr/bin/curl` grants (D1 credential model).

  `extends` form: empirically tested on 0.61.1 — both the bare string
  `"default"` and the array `["default"]` pass `nono profile validate`.
  This module uses the design's array form `["default"]`.
*/
{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-nono;

  # The runtime paths granted under `filesystem.allow` (managed + audit) and
  # `filesystem.read` (review). The OpenCode paths and `$TMPDIR` are the
  # empirically-derived startup grant set (Task 2.2). `$HOME/.local/share/
  # cavemem` is cavemem's capture database directory: the OpenCode cavemem
  # plugin (home-manager/common/opencode-plugins/cavemem.js) spawns
  # `cavemem hook run <event>` INSIDE this sandbox, and that child writes
  # the SQLite DB at `home.cavemem.dataDir` (default
  # `$HOME/.local/share/cavemem`). Without this grant the write is
  # Seatbelt-denied and the plugin swallows the error, silently dropping all
  # ambient capture. The `$HOME`-relative literal tracks the cavemem dataDir
  # default; update it if `home.cavemem.dataDir` is overridden. The
  # CAVEMEM_DATA_DIR env that points the hook at this dir is exported by
  # cavemem.nix's wrapperCommands and admitted via `launcherAllowVars` below.
  # Rendered as `$HOME`/`$TMPDIR` literals (no absolute home-directory
  # hardcoding); nono expands them at runtime.
  opencodeDataPaths = [
    "$HOME/.config/opencode"
    "$HOME/.cache/opencode"
    "$HOME/.local/share/opencode"
    "$HOME/.local/state/opencode"
    "$HOME/.opencode"
    "$HOME/.local/share/opentui"
    "$HOME/.local/share/cavemem"
    "$HOME/.local/logs"
    "$TMPDIR"
  ];

  # The confirmed groups (Task 2.1) that all exist on nono 0.61.1.
  # `git_config` is intentionally excluded: agents run git through the
  # `git-mcp` base server (mcpproxy, outside the sandbox), so the sandbox
  # grants no direct git config access. Paired with the `gitConfigDenyPaths`
  # deny below for defense in depth.
  opencodeGroups = [
    "node_runtime"
    "nix_runtime"
    "user_caches_macos"
  ];

  # Filesystem paths denied on every profile so direct git config access is
  # blocked even where a broad parent (e.g. the Shopify audit profile's
  # `$HOME/.config` allow) would otherwise reach it. nono's deny list is
  # checked before any allow/group/workdir grant (Seatbelt deny precedence on
  # macOS), so this carves `~/.config/git` out regardless. git identity,
  # signing, and `[include]` directives are served by the git-mcp server,
  # which runs outside the sandbox with full git config.
  gitConfigDenyPaths = [
    "$HOME/.config/git"
  ];

  # Environment variable NAMES (not values) the launcher exports and the
  # managed/audit profiles admit via `allow_vars` (R4.1, R4.5). NAMES
  # ONLY — values are exported at runtime by the launcher, never
  # serialized into the profile. `OPENCODE_*` is a glob admitting all
  # launcher-exported opencode env. Provider base-URL/token NAME vars
  # (e.g. ANTHROPIC_BASE_URL, DEFAULT_PROXY_BASE) are listed so the
  # launcher-exported values pass through; the values themselves are
  # never embedded here.
  launcherAllowVars = [
    "PATH"
    "HOME"
    "TERM"
    "LANG"
    "LC_ALL"
    "TMPDIR"
    "SHELL"
    "USER"
    "OPENCODE_*"
    "ANTHROPIC_BASE_URL"
    "ANTHROPIC_AUTH_TOKEN"
    "DEFAULT_PROXY_BASE"
    "XDG_CONFIG_HOME"
    "XDG_CACHE_HOME"
    "XDG_DATA_HOME"
    "XDG_STATE_HOME"
    # cavemem capture: the opencode cavemem plugin's `cavemem hook run`
    # child must inherit CAVEMEM_DATA_DIR (exported host-side by
    # cavemem.nix's wrapperCommands) so it writes the same SQLite DB the
    # mcpproxy-launched cavemem MCP server reads. nono 0.61.1 env is
    # default-deny, so the NAME must be admitted here or it is stripped at
    # the sandbox boundary.
    "CAVEMEM_DATA_DIR"
  ];

  # Render one profile model to the 0.61.1 authoring schema as a plain
  # attrset, dropping empty optional sections so the emitted JSON stays
  # minimal and secret-free. `extends` uses the design's array form
  # (`["default"]`), validated on 0.61.1.
  renderProfile =
    p:
    let
      meta = {
        inherit (p.meta) name version description;
      }
      // lib.optionalAttrs (p.meta.author != null) { inherit (p.meta) author; };

      groups = {
        inherit (p.groups) include;
      }
      // lib.optionalAttrs (p.groups.exclude != [ ]) { inherit (p.groups) exclude; };

      filesystem =
        lib.optionalAttrs (p.filesystem.allow != [ ]) { inherit (p.filesystem) allow; }
        // lib.optionalAttrs (p.filesystem.read != [ ]) { inherit (p.filesystem) read; }
        // lib.optionalAttrs (p.filesystem.write != [ ]) { inherit (p.filesystem) write; }
        // lib.optionalAttrs (p.filesystem.allowFile != [ ]) { allow_file = p.filesystem.allowFile; }
        // lib.optionalAttrs (p.filesystem.readFile != [ ]) { read_file = p.filesystem.readFile; }
        // lib.optionalAttrs (p.filesystem.writeFile != [ ]) { write_file = p.filesystem.writeFile; }
        // lib.optionalAttrs (p.filesystem.deny != [ ]) { inherit (p.filesystem) deny; };

      network = {
        inherit (p.network) block;
      }
      // lib.optionalAttrs (p.network.networkProfile != null) {
        network_profile = p.network.networkProfile;
      }
      // lib.optionalAttrs (p.network.allowDomain != [ ]) { allow_domain = p.network.allowDomain; }
      // lib.optionalAttrs (p.network.openPort != [ ]) { open_port = p.network.openPort; }
      // lib.optionalAttrs (p.network.listenPort != [ ]) { listen_port = p.network.listenPort; };

      environment =
        lib.optionalAttrs (p.environment.allowVars != [ ]) { allow_vars = p.environment.allowVars; }
        // lib.optionalAttrs (p.environment.denyVars != [ ]) { deny_vars = p.environment.denyVars; };
    in
    {
      inherit meta groups;
      inherit (p) extends;
      workdir = {
        inherit (p.workdir) access;
      };
    }
    // lib.optionalAttrs (filesystem != { }) { inherit filesystem; }
    // lib.optionalAttrs (environment != { }) { inherit environment; }
    // {
      inherit network;
    };

  # XDG-relative path the rendered metadata is written to. The shipped
  # sibling audit CLI (scripts/opencode-nono-audit.js `resolveMetadataPath`)
  # reads it at `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode-nono/
  # metadata.json`; this path is relative to ~/.config (xdg.configFile).
  metadataPath = "opencode/opencode-nono/metadata.json";
  operatorGuidePath = "opencode/opencode-nono/README.md";

  # The active managed profile's version is the single canonical
  # `profileVersion` field the audit's `readProfileVersion` and the R3.5
  # freshness check compare against; it MUST be a string. Read it from the
  # rendered managed profile rather than hardcoding (default "0.1.0").
  profileVersion = cfg.profiles.${cfg.managedProfile}.meta.version;

  # Resolved nono version (R7.4), read from the provisioned package so an
  # operator override of `programs.opencode-nono.package` flows through
  # (Task 7.1 asserts this); do NOT hardcode "0.61.1".
  nonoVersion = cfg.package.version;

  # The `OPENCODE_NONO_*` env-var contract (R5.4, R6.5) per design's Env
  # Contract table. NAMES ONLY — no secret values are ever serialized
  # (R2.5, R4.5).
  envContract = {
    inputs = {
      state = "OPENCODE_NONO";
      profile = "OPENCODE_NONO_PROFILE";
    };
    outputs = {
      effective = "OPENCODE_NONO_EFFECTIVE";
      profileEffective = "OPENCODE_NONO_PROFILE_EFFECTIVE";
      disableReason = "OPENCODE_NONO_DISABLE_REASON";
      usageTag = "OPENCODE_NONO_USAGE_TAG";
    };
  };

  # Local metadata identifying the active profile version, resolved nono
  # version, host default state, rendered profiles, and the env contract
  # (R6.5, R7.4). `profiles` is a deterministic, lexically-sorted list via
  # lib.mapAttrsToList over the profile attrset. builtins.toJSON mirrors the
  # repo convention (opencode-rtk.nix).
  nonoMetadata = {
    feature = "opencode-nono";
    inherit profileVersion nonoVersion;
    inherit (cfg) defaultState;
    profiles = lib.mapAttrsToList (_: p: {
      inherit (p.meta) name version;
    }) cfg.profiles;
    inherit envContract;
  };

  # Operator guide (R6.3, R5.4). Mirrors opencode-rtk.nix's `operatorGuide`
  # multiline string; renders host defaults into a "Rendered host defaults"
  # section. NO secret literals anywhere (R2.5, R4.5).
  operatorGuide = ''
    # OpenCode nono sandbox operator guide

    This integration launches managed OpenCode under the `nono` sandbox. It
    renders a profile catalog to `~/.config/nono/profiles/`, this metadata
    and guide, and (in later tasks) an outer launcher that resolves the
    sandbox state per launch.

    ## Profile selection

    Three base profiles are rendered, each reconstructing the opencode grant
    set on top of nono's `default` profile (nono 0.61.1 has no built-in
    `opencode` profile):

    - `${cfg.managedProfile}` (enforced): the enforced profile selected when
      the effective state is `enforced`. `workdir.access = readwrite`.
    - `${cfg.auditProfile}` (compatibility-audit): the permissive first
      rollout state, selected when the effective state is `audit`, so
      OpenCode and its plugins start cleanly and any sandbox-induced failure
      surfaces as a real error rather than a silent no-op.
    - `${cfg.reviewProfile}` (read-only): a read-only review profile;
      `workdir.access = read` with no filesystem write grants.

    `OPENCODE_NONO` selects the state (`disabled | audit | enforced`), which
    in turn selects the profile. `OPENCODE_NONO_PROFILE` overrides the
    resolved profile name directly for one launch.

    ## Noninteractive launch behavior

    When the effective state is `audit` or `enforced`, the launcher execs:

        NONO_NO_SAVE_PROMPT=1 nono run --profile <effective-profile> --allow-cwd -- opencode

    `--allow-cwd` is required (Phase 0). The mcpproxy preflight runs host-side
    OUTSIDE nono, before nono is entered, so its token mint and env exports
    are not subject to the sandbox. `NONO_NO_SAVE_PROMPT=1` prevents nono from
    opening its profile-save selector after OpenCode exits; diagnostics and
    audit recording remain enabled.

    ## Runtime overrides

    Override the host default for one launch without a rebuild:

    - `OPENCODE_NONO=disabled` launches OpenCode without nono.
    - `OPENCODE_NONO=audit` launches under `${cfg.auditProfile}`.
    - `OPENCODE_NONO=enforced` launches under `${cfg.managedProfile}`.
    - `OPENCODE_NONO_PROFILE=<name>` selects an explicit rendered profile by
      name for one launch.

    The launcher exports these effective-state values before OpenCode starts:

    - `OPENCODE_NONO_EFFECTIVE`: `disabled | audit | enforced` after host
      default and `OPENCODE_NONO` resolution.
    - `OPENCODE_NONO_PROFILE_EFFECTIVE`: the resolved profile name (empty when
      disabled).
    - `OPENCODE_NONO_DISABLE_REASON`: reason text when the launcher disables
      the sandbox, or empty.
    - `OPENCODE_NONO_USAGE_TAG`: `nono:<effective-state>` for optional usage
      attribution.

    ## Rollback

    Use the smallest rollback that matches the situation:

    - For one launch, start OpenCode with `OPENCODE_NONO=disabled`.
    - For a host default rollback, set
      `programs.opencode-nono.defaultState = "disabled"` and rebuild the host.
    - For full removal, set `programs.opencode-nono.enable = false` in
      repository-managed configuration and rebuild the host.

    ## Combined RTK + nono visibility

    The RTK integration's `OPENCODE_RTK_*` exports happen in the SAME preflight
    as the `OPENCODE_NONO_*` exports, so both effective states are observable
    together in a single launch's environment (R5.4). Inspect both
    `OPENCODE_NONO_EFFECTIVE` / `OPENCODE_NONO_PROFILE_EFFECTIVE` and
    `OPENCODE_RTK_EFFECTIVE` to see the combined sandbox + RTK posture.

    ## Rendered host defaults

    - Host default state: `${cfg.defaultState}`
    - Active managed profile version (`profileVersion`): `${profileVersion}`
    - Resolved nono version (`nonoVersion`): `${nonoVersion}`
    - Metadata path: `${metadataPath}`
  '';
in
{
  options.programs.opencode-nono = {
    enable = lib.mkEnableOption ''
      nono sandbox integration for managed OpenCode launches.

      When enabled, the integration makes `nono` available to managed
      OpenCode launches (Requirement 1.1) and, in later tasks, launches
      OpenCode under a repo-managed nono profile.

      Requires programs.opencode.enable = true on the same host; the
      assertion below enforces this at Home Manager evaluation time.
    '';

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.nono;
      defaultText = lib.literalExpression "pkgs.nono";
      description = ''
        The nono package made available to the OpenCode integration. The
        repository overlay (overlays/misc.nix) provides the latest
        upstream-published nono (0.61.1) because nixpkgs does not package
        that version (Requirements 7.1, 7.2). Override this option to pin
        or supply a different nono version (Requirement 7.3).
      '';
    };

    defaultState = lib.mkOption {
      type = lib.types.enum [
        "disabled"
        "audit"
        "enforced"
      ];
      default = "disabled";
      description = ''
        Host default sandbox state for managed OpenCode launches
        (Requirement 3.1):

        - `disabled`: launch OpenCode without nono.
        - `audit`: launch OpenCode under the compatibility-audit profile.
        - `enforced`: launch OpenCode under the enforced profile.

        The v1 default is `disabled`. Later runtime wiring resolves this
        host default with the per-launch `OPENCODE_NONO` override.
      '';
    };

    managedProfile = lib.mkOption {
      type = lib.types.str;
      default = "opencode-managed";
      description = ''
        Name of the rendered profile selected when the effective sandbox
        state is `enforced`. The profile catalog that defines this profile
        is rendered by a later task.
      '';
    };

    auditProfile = lib.mkOption {
      type = lib.types.str;
      default = "opencode-audit";
      description = ''
        Name of the rendered profile selected when the effective sandbox
        state is `audit`. The profile catalog that defines this profile is
        rendered by a later task.
      '';
    };

    reviewProfile = lib.mkOption {
      type = lib.types.str;
      default = "opencode-review";
      description = ''
        Name of the rendered read-only review profile. The profile catalog
        that defines this profile is rendered by a later task.
      '';
    };

    profiles = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.submodule {
          options = {
            meta = {
              name = lib.mkOption {
                type = lib.types.str;
                description = "Profile name (`meta.name`); must be unique.";
              };
              version = lib.mkOption {
                type = lib.types.str;
                default = "0.1.0";
                description = "Profile version (`meta.version`, R2.2).";
              };
              description = lib.mkOption {
                type = lib.types.str;
                description = ''
                  Profile description (`meta.description`). nono 0.61.1
                  `meta` has no `intendedUse` field, so the intended-use
                  statement is folded into this description (R2.2). Hosts
                  may append a host-specific access label here (R2.3).

                  Must contain no secret literals (R2.5, R4.5).
                '';
              };
              author = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Optional profile author (`meta.author`).";
              };
            };

            extends = lib.mkOption {
              type = lib.types.listOf lib.types.str;
              default = [ "default" ];
              description = ''
                Profiles this profile inherits (`extends`). Defaults to
                `["default"]`: nono 0.61.1 removed the built-in `opencode`
                profile, so the opencode grant set is reconstructed on top
                of `default`. The array form validates on 0.61.1.
              '';
            };

            groups = {
              include = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Groups to include (`groups.include`).";
              };
              exclude = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Groups to exclude (`groups.exclude`).";
              };
            };

            workdir.access = lib.mkOption {
              type = lib.types.enum [
                "none"
                "read"
                "write"
                "readwrite"
              ];
              default = "read";
              description = "Working-directory access (`workdir.access`).";
            };

            filesystem = {
              allow = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = ''
                  Read/write DIRECTORY allowances (`filesystem.allow`,
                  recursive). Directories only — nono rejects a single-file
                  path here at `nono run` parse time ("is not a directory");
                  use `allowFile` for a regular file.
                '';
              };
              read = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = ''
                  Read-only DIRECTORY allowances (`filesystem.read`,
                  recursive). Directories only — use `readFile` for a regular
                  file.
                '';
              };
              write = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = ''
                  Write-only DIRECTORY allowances (`filesystem.write`,
                  recursive). Directories only — use `writeFile` for a regular
                  file.
                '';
              };
              allowFile = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = ''
                  Single FILES with read+write access (`filesystem.allow_file`).
                  Use this — not `allow` — for a path that is a regular file.
                '';
              };
              readFile = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Single FILES with read-only access (`filesystem.read_file`).";
              };
              writeFile = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Single FILES with write-only access (`filesystem.write_file`).";
              };
              deny = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Filesystem denials (`filesystem.deny`).";
              };
            };

            network = {
              block = lib.mkOption {
                type = lib.types.bool;
                default = false;
                description = "Block all network (`network.block`).";
              };
              networkProfile = lib.mkOption {
                type = lib.types.nullOr lib.types.str;
                default = null;
                description = "Named network profile (`network.network_profile`).";
              };
              allowDomain = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Allowed domains (`network.allow_domain`).";
              };
              openPort = lib.mkOption {
                type = lib.types.listOf lib.types.int;
                default = [ ];
                description = ''
                  Outbound loopback ports the sandbox may reach
                  (`network.open_port`). `8080` reaches mcpproxy on
                  loopback.
                '';
              };
              listenPort = lib.mkOption {
                type = lib.types.listOf lib.types.int;
                default = [ ];
                description = "Ports the sandbox may listen on (`network.listen_port`).";
              };
            };

            environment = {
              allowVars = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = ''
                  Environment variable NAMES admitted into the sandbox
                  (`environment.allow_vars`, R4.1). NAMES ONLY — values
                  are exported by the launcher at runtime and never
                  serialized (R2.5, R4.5).
                '';
              };
              denyVars = lib.mkOption {
                type = lib.types.listOf lib.types.str;
                default = [ ];
                description = "Environment variable names denied (`environment.deny_vars`).";
              };
            };
          };
        }
      );

      default = { };
      description = ''
        Typed catalog of nono profiles (the design's `NonoProfileModel`).
        Each entry is rendered to `~/.config/nono/profiles/<name>.json`
        against the pinned nono version's authoring schema (0.61.1).

        The `config` block below seeds the three base profiles
        (`opencode-managed`, `opencode-audit`, `opencode-review`). Hosts
        may add host-specific profiles or extend descriptions with
        host-specific access labels (R2.3); host wiring is Task 6.3.

        Invariants: secrets are never serialized; no Keychain,
        `/usr/bin/security`, or `/usr/bin/curl` grants (R2.5, R4.5).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Override the launcher seam (home-manager/common/opencode.nix) with the
    # outer preflight launcher. When this module is disabled the seam keeps its
    # `default` (the `opencode-wrapped` symlinkJoin that runs preflight INSIDE
    # the wrapper); enabling it swaps in the launcher that runs preflight
    # host-side and execs nono / bare opencode per the resolved state.
    #
    # No circular reference: the launcher depends only on the seam's read-only
    # internals (`basePackage`/`preflightScript`/`lspPath`) plus this module's
    # `cfg.package` (nono) and rollout-state options — NEVER on `finalPackage`
    # itself. The seam's `default` (which builds the symlinkJoin) is lazy and
    # goes unused once this override is set, so there is no eval-time recursion.
    home.opencode.finalPackage = pkgs.callPackage ../../scripts/opencode-nono-launcher.nix {
      inherit (config.home.opencode) basePackage preflightScript lspPath;
      nono = cfg.package;
      inherit (cfg) defaultState managedProfile auditProfile;
    };

    # Three base profiles seeded with the empirically-derived opencode
    # grant set (Tasks 2.1/2.2) + the design's per-profile deltas. Hosts
    # extend or override these via `programs.opencode-nono.profiles`.
    # Each leaf carries lib.mkDefault (per-leaf, NOT a whole-attrset
    # default) so a host can override a single leaf — e.g.
    # `meta.description` — while every un-restated leaf keeps its base
    # value. A whole-attrset mkDefault would let any partial host override
    # win the entire attrset and discard the rest (R2.1, R2.3).
    programs.opencode-nono.profiles = {
      # opencode-managed (enforced): readwrite workdir, mcpproxy
      # loopback port, launcher env admitted. Provider
      # allow_domain/network_profile tightening is POST-AUDIT; v1 leaves
      # network permissive (R4.3 — posture documented in Task 3.3 guide).
      ${cfg.managedProfile} = {
        meta.name = lib.mkDefault cfg.managedProfile;
        meta.description = lib.mkDefault (
          "Enforced sandbox profile for managed OpenCode launches. "
          + "Intended use: normal coding sessions under nono enforcement, "
          + "reconstructing the opencode grant set on top of nono's default "
          + "profile (no built-in opencode profile on 0.61.1)."
        );
        groups.include = lib.mkDefault opencodeGroups;
        workdir.access = lib.mkDefault "readwrite";
        filesystem.allow = lib.mkDefault opencodeDataPaths;
        filesystem.deny = lib.mkDefault gitConfigDenyPaths;
        network.openPort = lib.mkDefault [ 8080 ];
        environment.allowVars = lib.mkDefault launcherAllowVars;
      };

      # opencode-audit (compatibility-audit): permissive so opencode +
      # plugins start cleanly and failures surface as real errors (R5.3),
      # not silent disables. First state operators flip to.
      ${cfg.auditProfile} = {
        meta.name = lib.mkDefault cfg.auditProfile;
        meta.description = lib.mkDefault (
          "Compatibility-audit sandbox profile for managed OpenCode. "
          + "Intended use: the first rollout state — permissive enough that "
          + "OpenCode and its plugins start cleanly so any sandbox-induced "
          + "failure surfaces as a real error rather than a silent no-op "
          + "(R5.3). nono audit recording is on by default."
        );
        groups.include = lib.mkDefault opencodeGroups;
        workdir.access = lib.mkDefault "readwrite";
        filesystem.allow = lib.mkDefault opencodeDataPaths;
        filesystem.deny = lib.mkDefault gitConfigDenyPaths;
        network.block = lib.mkDefault false;
        network.openPort = lib.mkDefault [ 8080 ];
        environment.allowVars = lib.mkDefault launcherAllowVars;
      };

      # opencode-review (read-only): read workdir, no write grants.
      ${cfg.reviewProfile} = {
        meta.name = lib.mkDefault cfg.reviewProfile;
        meta.description = lib.mkDefault (
          "Read-only review sandbox profile for managed OpenCode. "
          + "Intended use: inspecting a workspace under nono with no write "
          + "access — workdir.access is read and there are no filesystem "
          + "write grants."
        );
        groups.include = lib.mkDefault opencodeGroups;
        workdir.access = lib.mkDefault "read";
        filesystem.read = lib.mkDefault opencodeDataPaths;
        filesystem.deny = lib.mkDefault gitConfigDenyPaths;
        network.openPort = lib.mkDefault [ 8080 ];
        environment.allowVars = lib.mkDefault launcherAllowVars;
      };
    };

    # Render each profile to ~/.config/nono/profiles/<name>.json (R2.1).
    # Paths are relative to ~/.config (xdg.configFile). builtins.toJSON
    # mirrors the repo convention (subagent-context-budget.nix).
    xdg.configFile =
      lib.mapAttrs' (
        _: p:
        lib.nameValuePair "nono/profiles/${p.meta.name}.json" { text = builtins.toJSON (renderProfile p); }
      ) cfg.profiles
      // {
        # Local metadata (R6.5, R7.4) consumed by the shipped sibling audit
        # CLI at this exact XDG-relative path; builtins.toJSON per repo
        # convention.
        ${metadataPath}.text = builtins.toJSON nonoMetadata;
        # Operator guide (R6.3, R5.4).
        ${operatorGuidePath}.text = operatorGuide;
      };

    assertions = [
      {
        assertion = config.programs.opencode.enable;
        message = ''
          programs.opencode-nono.enable requires programs.opencode.enable.

          The OpenCode nono integration sandboxes managed OpenCode
          launches. Without programs.opencode.enable = true, there is no
          Home Manager managed OpenCode wrapper for nono to sandbox.

          To fix: set programs.opencode.enable = true; alongside
          programs.opencode-nono.enable = true; in the same home-manager
          configuration.
        '';
      }
    ];
  };
}
