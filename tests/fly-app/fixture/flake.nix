{
  inputs = {
    repo = {
      url = "path:../../..";
      flake = false;
    };
    nixpkgs.url = "github:NixOS/nixpkgs/57f1c8965649ce5bcac5118a0d2e41f1fbdc56e5";
  };

  outputs =
    { nixpkgs, repo, ... }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };
      inherit (nixpkgs) lib;
      inherit (pkgs) writeShellScript;
      deployScript = writeShellScript "fly-app-deploy-fixture" ''
        if [ "$#" -ne 2 ] || [ "$1" != "--spec" ]; then
          echo "expected fixed --spec argument" >&2
          exit 64
        fi
        ${pkgs.python3}/bin/python3 - "$2" <<'PY'
        import json
        import sys

        with open(sys.argv[1], encoding="utf-8") as spec_file:
            print(json.load(spec_file)["name"])
        PY
      '';
      deployProgram = pkgs.runCommand "fly-app-deploy-fixture" { } ''
        mkdir -p "$out/bin"
        ln -s "${deployScript}" "$out/bin/fly-app-deploy"
      '';
      mkApps =
        appModules:
        import "${repo}/lib/fly-apps.nix" {
          inherit
            lib
            pkgs
            appModules
            deployProgram
            ;
        };
      appModules = {
        alpha = {
          flyApp.name = "fly-alpha";
          flyApp.settings = {
            primary_region = "ord";
          };
        };
        beta = {
          flyApp.name = "fly-beta";
          flyApp.settings = {
            primary_region = "sjc";
          };
        };
      };
      apps = mkApps appModules;
      collisionResult = builtins.tryEval (
        builtins.deepSeq (builtins.attrNames (mkApps {
          alpha.flyApp.name = "same-target";
          beta.flyApp.name = "same-target";
        })) true
      );
      invalidNameResult = builtins.tryEval (
        builtins.deepSeq (builtins.attrNames (mkApps {
          "bad/name".flyApp.name = "bad-name";
        })) true
      );
    in
    {
      apps.${system} = apps;
      checks.${system}.fly-app-generator =
        assert
          builtins.attrNames apps == [
            "deploy-alpha"
            "deploy-beta"
          ];
        assert apps.deploy-alpha.program != apps.deploy-beta.program;
        assert apps.deploy-alpha.type == "app" && apps.deploy-beta.type == "app";
        assert !collisionResult.success;
        assert !invalidNameResult.success;
        pkgs.runCommand "fly-app-generator" { } ''
          alpha_target=$(${apps.deploy-alpha.program})
          beta_target=$(${apps.deploy-beta.program})
          test "$alpha_target" = fly-alpha
          test "$beta_target" = fly-beta
          touch "$out"
        '';
    };
}
