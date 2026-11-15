{
  inputs = {
    repo = {
      url = "path:../../..";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixpkgs.url = "github:NixOS/nixpkgs/57f1c8965649ce5bcac5118a0d2e41f1fbdc56e5";
  };

  outputs =
    {
      nixpkgs,
      repo,
      ...
    }:
    let
      system = "aarch64-linux";
      pkgs = import nixpkgs { inherit system; };
      inherit (nixpkgs) lib;
      inherit (pkgs) writeShellScript;
      # The stub keeps the generator's selected-spec success path callable
      # without Fly credentials or network access.
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
      deployPackage = repo.packages.${system}.fly-app-deploy;
      # The consumer-facing module and generator come from the repository
      # flake's public outputs, not from direct source imports.
      mkApps =
        deployProgram: appModules:
        repo.lib.mkFlyApps {
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
      # The consumer outputs wrap the public deploy package; `stubApps` uses
      # the same generator with a no-Fly stub to observe successful targeting.
      apps = mkApps deployPackage appModules;
      stubApps = mkApps deployProgram appModules;
      moduleEvaluation = lib.evalModules {
        modules = [
          repo.lib.flyAppModule
          { flyApp.name = "fly-module-fixture"; }
        ];
        specialArgs = { inherit pkgs; };
      };
      moduleApp = moduleEvaluation.config.flyApp;
      collisionResult = builtins.tryEval (
        builtins.deepSeq (builtins.attrNames (
          mkApps deployProgram {
            alpha.flyApp.name = "same-target";
            beta.flyApp.name = "same-target";
          }
        )) true
      );
      invalidNameResult = builtins.tryEval (
        builtins.deepSeq (builtins.attrNames (
          mkApps deployProgram {
            "bad/name".flyApp.name = "bad-name";
          }
        )) true
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
        assert moduleApp.name == "fly-module-fixture";
        assert builtins.isFunction repo.lib.mkFlyAppImage;
        assert builtins.isAttrs deployPackage;
        pkgs.runCommand "fly-app-generator" { } ''
          alpha_target=$(${stubApps.deploy-alpha.program})
          beta_target=$(${stubApps.deploy-beta.program})
          test "$alpha_target" = fly-alpha
          test "$beta_target" = fly-beta

          for program in ${apps.deploy-alpha.program} ${apps.deploy-beta.program}; do
            if grep -Eq '(^|[[:space:]])(ssh|nixos-rebuild|nixos-enter)([[:space:]]|$)' "$program"; then
              echo "generated app must not use SSH or NixOS activation: $program" >&2
              exit 1
            fi
          done

          alpha_spec=$(sed -n 's/^exec .*--spec "\([^"]*\)"$/\1/p' ${apps.deploy-alpha.program})
          beta_spec=$(sed -n 's/^exec .*--spec "\([^"]*\)"$/\1/p' ${apps.deploy-beta.program})
          test -n "$alpha_spec"
          test -n "$beta_spec"
          test "$alpha_spec" != "$beta_spec"

          ${pkgs.python3}/bin/python3 - "$alpha_spec" "$beta_spec" <<'PY'
          import json
          import sys

          alpha = json.load(open(sys.argv[1], encoding="utf-8"))
          beta = json.load(open(sys.argv[2], encoding="utf-8"))
          assert alpha["name"] == "fly-alpha", alpha
          assert beta["name"] == "fly-beta", beta
          assert alpha["settings"]["primary_region"] == "ord", alpha
          assert beta["settings"]["primary_region"] == "sjc", beta
          PY

          for program in ${apps.deploy-alpha.program} ${apps.deploy-beta.program}; do
            deploy_status=0
            if env -u FLY_API_TOKEN "$program" >deploy.stdout 2>deploy.stderr; then
              deploy_status=0
            else
              deploy_status=$?
            fi
            test "$deploy_status" -eq 1
            grep -q "FLY_API_TOKEN is required" deploy.stderr
          done
          touch "$out"
        '';
    };
}
