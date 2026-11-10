{
  lib,
  pkgs,
  appModules,
  deployProgram,
}:
let
  appNames = builtins.attrNames appModules;
  validAppName = name: builtins.match "[a-zA-Z0-9][a-zA-Z0-9_-]*" name != null;
  evaluatedApps = builtins.mapAttrs (
    _: appModule:
    (lib.evalModules {
      modules = [
        ../modules/fly-app.nix
        appModule
      ];
      specialArgs = { inherit pkgs; };
    }).config.flyApp
  ) appModules;
  appTargets = builtins.mapAttrs (_: app: app.name) evaluatedApps;
  targetNames = builtins.attrValues appTargets;
  duplicateTargets = lib.unique (
    lib.filter (
      name: builtins.length (builtins.filter (target: target == name) targetNames) > 1
    ) targetNames
  );
  assertValidNames =
    assert lib.assertMsg pkgs.stdenv.hostPlatform.isLinux
      "fly-apps: deploy commands must be generated with a Linux package set.";
    assert lib.assertMsg (lib.all validAppName appNames)
      "fly-apps: app names must start with a letter or digit and contain only letters, digits, '_' or '-'.";
    assert lib.assertMsg (duplicateTargets == [ ])
      "fly-apps: multiple named apps target the same Fly app: ${lib.concatStringsSep ", " duplicateTargets}.";
    true;
  appOutputs = builtins.listToAttrs (
    lib.mapAttrsToList (
      name: app:
      let
        program = "${pkgs.writeShellScript "deploy-${name}" ''
          exec "${deployProgram}/bin/fly-app-deploy" --spec "${app.spec}"
        ''}";
      in
      {
        name = "deploy-${name}";
        value = {
          type = "app";
          inherit program;
        };
      }
    ) evaluatedApps
  );
in
assert assertValidNames;
appOutputs
