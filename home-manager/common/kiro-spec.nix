{
  config,
  lib,
  pkgs,
  ...
}:
{
  options.programs.kiro-spec.package = lib.mkOption {
    type = lib.types.package;
    default = pkgs.kiro-spec;
    description = "The kiro-spec CLI package to install on PATH.";
  };

  config.home.packages = [ config.programs.kiro-spec.package ];
}
