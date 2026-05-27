{
  pkgs,
  lib,
  config,
  ...
}:
let
  cfg = config.programs.git-clone-isolation;

  basePackage = pkgs.callPackage ../../scripts/git-clone-isolation.nix { };

  wrappedPackage = pkgs.writeShellApplication {
    name = "git-clone-isolation";
    text = ''
      export GIT_CLONE_ISOLATION_CACHE_ROOT="${cfg.cacheRoot}"
      export GIT_CLONE_ISOLATION_CLONE_ROOT="${cfg.cloneRoot}"
      export GIT_CLONE_ISOLATION_DEFAULT_BRANCH="${cfg.defaultBranch}"
      exec ${lib.getExe cfg.package} "$@"
    '';
  };
in
{
  options.programs.git-clone-isolation = {
    enable = lib.mkEnableOption "git-clone-isolation CLI wrapper";

    package = lib.mkOption {
      type = lib.types.package;
      default = basePackage;
      description = ''
        Base git-clone-isolation CLI package delegated to by the Home Manager wrapper.
      '';
    };

    cacheRoot = lib.mkOption {
      type = lib.types.str;
      default = "${config.xdg.stateHome}/git-clone-isolation";
      description = ''
        Cache state root exported to git-clone-isolation by the wrapper.
      '';
    };

    cloneRoot = lib.mkOption {
      type = lib.types.str;
      default = "${config.home.homeDirectory}/scratch";
      description = ''
        Root directory for generated isolated clones exported by the wrapper.
      '';
    };

    defaultBranch = lib.mkOption {
      type = lib.types.str;
      default = "main";
      description = ''
        Default base branch exported to git-clone-isolation by the wrapper.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ wrappedPackage ];
  };
}
