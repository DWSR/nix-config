{
  home-manager,
  pkgs,
}:
let
  inherit (pkgs) lib;

  modulePath = ../../home-manager/common/hammerspoon-deskflow-watchdog/default.nix;
  snapshotHelper =
    pkgs.callPackage ../../home-manager/common/hammerspoon-deskflow-watchdog/process-snapshot.nix
      { };
  snapshotCommand = "${snapshotHelper}/bin/deskflow-process-snapshot";
  snapshotLiteral = builtins.toJSON (builtins.unsafeDiscardStringContext snapshotCommand);
  sentinel = "-- deskflow-hammerspoon-watchdog:render-v1";
  homeManagerPath = home-manager.outPath;
  homeManagerLib = import (homeManagerPath + "/modules/lib/stdlib-extended.nix") pkgs.lib;
  homeManagerModules = import (homeManagerPath + "/modules/modules.nix") {
    inherit pkgs;
    lib = homeManagerLib;
  };

  testHome = {
    home = {
      username = "watchdog-test";
      homeDirectory = "/home/watchdog-test";
      stateVersion = "25.11";
    };
  };
  testModules = [
    ../../home-manager/common/hammerspoon-keybindings/default.nix
    ../../home-manager/common/deskflow/default.nix
    modulePath
    testHome
  ];
  prerequisiteOptions = { lib, ... }: {
    options.home = {
      hammerspoon = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };
        extraConfig = lib.mkOption {
          type = lib.types.lines;
          default = "";
        };
      };
      deskflow = {
        enable = lib.mkOption {
          type = lib.types.bool;
          default = false;
        };
        role = lib.mkOption {
          type = lib.types.nullOr (
            lib.types.enum [
              "client"
              "server"
            ]
          );
          default = null;
        };
      };
    };
  };
  prerequisiteTestModules = [
    prerequisiteOptions
    modulePath
    testHome
  ];

  mkConfiguration =
    moduleConfig:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = testModules ++ [ moduleConfig ];
    };

  mkUncheckedConfiguration =
    moduleConfig:
    homeManagerLib.evalModules {
      modules = [
        {
          imports = prerequisiteTestModules ++ [ moduleConfig ];
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

  enabled =
    role:
    mkConfiguration {
      home = {
        hammerspoon = {
          enable = true;
          deskflowWatchdog.enable = true;
        };
        deskflow = {
          enable = true;
          inherit role;
        }
        // lib.optionalAttrs (role == "server") {
          server.screens = [ { name = "watchdog-test"; } ];
        };
      };
    };

  disabled = mkConfiguration { };
  client = enabled "client";
  server = enabled "server";
  missingHammerspoon = mkUncheckedConfiguration {
    home = {
      hammerspoon.deskflowWatchdog.enable = true;
      deskflow = {
        enable = true;
        role = "client";
      };
    };
  };
  missingDeskflow = mkUncheckedConfiguration {
    home = {
      hammerspoon = {
        enable = true;
        deskflowWatchdog.enable = true;
      };
      deskflow.role = "client";
    };
  };
  missingRole = mkUncheckedConfiguration {
    home = {
      hammerspoon = {
        enable = true;
        deskflowWatchdog.enable = true;
      };
      deskflow.enable = true;
    };
  };

  watchdogOptions = builtins.attrNames disabled.options.home.hammerspoon.deskflowWatchdog;
  optionDescription = disabled.options.home.hammerspoon.deskflowWatchdog.enable.description;
  disabledLua = disabled.config.home.hammerspoon.extraConfig;
  clientLua = client.config.home.hammerspoon.extraConfig;
  serverLua = server.config.home.hammerspoon.extraConfig;

  count = needle: text: builtins.length (lib.splitString needle text) - 1;
  watchdogAssertionPrefix = "home.hammerspoon.deskflowWatchdog.enable requires ";
  watchdogAssertions =
    configuration:
    builtins.filter (
      entry: lib.hasPrefix watchdogAssertionPrefix entry.message
    ) configuration.config.assertions;
  failedAssertions =
    configuration: builtins.filter (entry: !entry.assertion) (watchdogAssertions configuration);
  hasOnlyFailure =
    expectedMessage: configuration:
    let
      failures = failedAssertions configuration;
    in
    builtins.length failures == 1 && (builtins.head failures).message == expectedMessage;
in
assert watchdogOptions == [ "enable" ];
assert disabled.config.home.hammerspoon.deskflowWatchdog.enable == false;
assert disabledLua == "";
assert builtins.getContext disabledLua == { };
assert failedAssertions disabled == [ ];
assert lib.hasInfix "separate macOS Accessibility grants" optionDescription;
assert lib.hasInfix "Hammerspoon" optionDescription;
assert lib.hasInfix "Deskflow" optionDescription;
assert failedAssertions client == [ ];
assert failedAssertions server == [ ];
assert count sentinel clientLua == 1;
assert count sentinel serverLua == 1;
assert count ''local role = "client"'' clientLua == 1;
assert count ''local role = "server"'' serverLua == 1;
assert count "local snapshotCommand = ${snapshotLiteral}" clientLua == 1;
assert count "local snapshotCommand = ${snapshotLiteral}" serverLua == 1;
assert builtins.getContext clientLua == builtins.getContext snapshotCommand;
assert builtins.getContext serverLua == builtins.getContext snapshotCommand;
assert hasOnlyFailure "home.hammerspoon.deskflowWatchdog.enable requires home.hammerspoon.enable."
  missingHammerspoon;
assert hasOnlyFailure "home.hammerspoon.deskflowWatchdog.enable requires home.deskflow.enable."
  missingDeskflow;
assert hasOnlyFailure
  "home.hammerspoon.deskflowWatchdog.enable requires home.deskflow.role to be client or server."
  missingRole;
pkgs.runCommand "hammerspoon-deskflow-watchdog-module-test" { } ''
  touch "$out"
''
