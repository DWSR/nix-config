{
  home-manager,
  pkgs,
}:
let
  inherit (pkgs) lib;
  testHome = {
    home = {
      username = "timezone-test";
      homeDirectory = "/home/timezone-test";
      stateVersion = "25.11";
    };
  };
  modules = [
    ../../home-manager/common/hammerspoon-keybindings/default.nix
    ../../home-manager/common/hammerspoon-timezone-menubar/default.nix
    testHome
  ];
  homeManagerPath = home-manager.outPath;
  homeManagerLib = import (homeManagerPath + "/modules/lib/stdlib-extended.nix") pkgs.lib;
  homeManagerModules = import (homeManagerPath + "/modules/modules.nix") {
    inherit pkgs;
    lib = homeManagerLib;
  };
  mkConfiguration =
    moduleConfig:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = modules ++ [ moduleConfig ];
    };
  mkUncheckedConfiguration =
    moduleConfig:
    homeManagerLib.evalModules {
      modules = [
        {
          imports = modules ++ [ moduleConfig ];
          nixpkgs = {
            config = lib.mkDefault pkgs.config;
            inherit (pkgs) overlays;
          };
        }
      ]
      ++ homeManagerModules;
      class = "homeManager";
      specialArgs.modulesPath = homeManagerPath + "/modules";
    };
  timezone = label: timeZone: { inherit label timeZone; };
  disabled = mkConfiguration { };
  enabled = mkConfiguration {
    home.hammerspoon = {
      enable = true;
      timezoneMenubar = {
        enable = true;
        timezones = [
          (timezone "Toronto" "America/Toronto")
          (timezone "UTC" "Etc/UTC")
        ];
      };
    };
  };
  missingHammerspoon = mkUncheckedConfiguration {
    home.hammerspoon.timezoneMenubar = {
      enable = true;
      timezones = [ (timezone "UTC" "Etc/UTC") ];
    };
  };
  empty = mkUncheckedConfiguration {
    home.hammerspoon = {
      enable = true;
      timezoneMenubar.enable = true;
    };
  };
  duplicateLabels = mkUncheckedConfiguration {
    home.hammerspoon = {
      enable = true;
      timezoneMenubar = {
        enable = true;
        timezones = [
          (timezone "Office" "America/Toronto")
          (timezone "Office" "America/Vancouver")
        ];
      };
    };
  };
  assertionFailures =
    configuration:
    map (entry: entry.message) (
      builtins.filter (entry: !entry.assertion) configuration.config.assertions
    );
in
assert disabled.config.home.hammerspoon.timezoneMenubar.enable == false;
assert disabled.config.home.hammerspoon.timezoneMenubar.timezones == [ ];
assert disabled.config.home.hammerspoon.extraConfig == "";
assert assertionFailures enabled == [ ];
assert lib.hasInfix ''label = "Toronto", timeZone = "America/Toronto"''
  enabled.config.home.hammerspoon.extraConfig;
assert
  assertionFailures missingHammerspoon == [
    "home.hammerspoon.timezoneMenubar.enable requires home.hammerspoon.enable."
  ];
assert
  assertionFailures empty == [
    "home.hammerspoon.timezoneMenubar.timezones must contain at least one timezone."
  ];
assert
  assertionFailures duplicateLabels == [
    "home.hammerspoon.timezoneMenubar.timezones labels must be unique."
  ];
pkgs.runCommand "hammerspoon-timezone-menubar-module-test" { } ''
  touch "$out"
''
