/*
  home-manager/common/opencode-nono.nix — the `programs.opencode-nono`
  Home Manager module (opencode-nono-sandbox spec, Task 3.1; Requirements
  1.1, 3.1, 7.1, 7.2, 7.3).

  Task 3.1 scope is the option surface, package selection with operator
  override, rollout-state controls, and the peer assertion. The profile
  catalog model + rendering (Task 3.2), rendered metadata, the outer
  launcher, and the validate/smoke-test scripts are later tasks; this
  module declares only what 3.1 owns and does not reference constructs
  that do not exist yet.

  Design references: "Boundary Commitments → This Spec Owns", the
  "Rollout Controls" and "Package Provision" component sections, and the
  "State Resolver / Outer Launcher → State Management" states
  (`disabled | audit | enforced`).

  Peer dependency: asserts at HM-evaluation time that
  `programs.opencode.enable` is true on the same host (mirrors
  `opencode-rtk.nix` / `opencode-nono-audit.nix`). Without the managed
  OpenCode wrapper there is no OpenCode launch for nono to sandbox.
*/
{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.opencode-nono;
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
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

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
