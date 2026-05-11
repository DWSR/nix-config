{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.cc-sdd;

  # Each subdirectory of cc-sdd-skills/skills/ is a kiro-* skill. Read at
  # eval time so a cc-sdd version bump that adds or removes a skill picks
  # up automatically without touching this file.
  skillNames = builtins.attrNames (builtins.readDir "${pkgs.cc-sdd-skills}/skills");
in
{
  options.programs.cc-sdd = {
    enable = lib.mkEnableOption ''
      cc-sdd Kiro-style spec-driven development tooling for OpenCode.

      When enabled this module installs:
        - the cc-sdd CLI on PATH (for advanced/manual use and as the
          backing implementation for the cc-sdd-init helper)
        - all 17 kiro-* skills under ~/.config/opencode/skills/, sourced
          from the Nix-managed cc-sdd-skills derivation. They are loaded
          by every OpenCode session on this host without per-project
          bootstrap.

      Per-project Kiro template overrides (.kiro/settings/templates/) are
      materialised by `cc-sdd-init` (see scripts/cc-sdd-init.nix) which
      copies from the same cc-sdd-skills source tree.
    '';

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.cc-sdd;
      description = "The cc-sdd CLI package to install on PATH.";
    };

    skillsPackage = lib.mkOption {
      type = lib.types.package;
      default = pkgs.cc-sdd-skills;
      description = ''
        Derivation containing the materialised cc-sdd skill+template tree.
        Must expose `skills/`, `kiro-settings/`, and `agents-md` under its
        output path. Override only when testing a fork.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];

    # Symlink each kiro-* skill directory individually rather than the
    # parent skills/ tree so that other modules (or the user) can drop
    # additional skills into ~/.config/opencode/skills/ alongside ours
    # without conflicting with home-manager's exclusive ownership of a
    # single xdg.configFile target.
    xdg.configFile = lib.listToAttrs (
      map (
        name:
        lib.nameValuePair "opencode/skills/${name}" {
          source = "${cfg.skillsPackage}/skills/${name}";
        }
      ) skillNames
    );
  };
}
