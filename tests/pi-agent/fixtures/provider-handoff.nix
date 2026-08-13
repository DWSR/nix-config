{
  fixture,
  repoRoot,
}:
let
  flake = builtins.getFlake (builtins.unsafeDiscardStringContext (toString repoRoot));
  pkgs = flake.darwinConfigurations.ShopifyLaptop.pkgs;
  managedFixture =
    name:
    import (repoRoot + "/tests/pi-agent/fixtures/managed-config.nix") {
      fixture = name;
      inherit repoRoot;
    };
  credentialPackages = import (repoRoot + "/tests/pi-agent/fixtures/credential-resolver.nix") {
    fixture = "executor-packages";
    inherit repoRoot;
  };
  managedConfig = managedFixture "shopify-managed-config";
  projectionFactory = managedFixture "shopify-projection-factory";
  handoff = managedFixture "shopify-provider-handoff";
  personalState = pkgs.writeText "pi-agent-personal-provider-handoff-state.json" (
    builtins.toJSON {
      isNull = managedFixture "personal-provider-handoff-is-null";
    }
  );
  tamperedCatalogConfig =
    pkgs.runCommand "pi-agent-tampered-provider-catalog.json"
      {
        nativeBuildInputs = [ pkgs.jq ];
      }
      ''
        jq '.providerCatalog.shopify[0].route.suffix = "/task-5-3-tampered-catalog"' \
          ${managedConfig} > "$out"
      '';
  tamperedSelectionConfig =
    pkgs.runCommand "pi-agent-tampered-provider-selection.json"
      {
        nativeBuildInputs = [ pkgs.jq ];
      }
      ''
        jq '.providerSelection.enabledRoles = ["openai"]' ${managedConfig} > "$out"
      '';
  tamperedFactory = pkgs.writeTextFile {
    name = "pi-agent-tampered-provider-projection-factory";
    destination = "/bin/pi-agent-provider-projection";
    executable = true;
    text = ''
      #!${pkgs.nodejs}/bin/node
      process.stdout.write('{"task-5-3-tampered-factory":true}\n');
    '';
  };
  mkTamperedHandoff =
    managedConfigPath: factoryPath:
    import (repoRoot + "/scripts/pi-agent-shopify-provider-handoff.nix") {
      inherit pkgs;
      inherit (handoff) managedConfigDigest projectionFactoryDigest;
      managedConfig = managedConfigPath;
      projectionFactory = factoryPath;
      reconcilerModule = repoRoot + "/scripts/pi-agent-reconcile.mjs";
    };
  fixtures = {
    packages = pkgs.linkFarm "pi-agent-provider-handoff-fixtures" [
      {
        name = "handoff";
        path = handoff;
      }
      {
        name = "credential-packages";
        path = credentialPackages;
      }
      {
        name = "managed-config.json";
        path = managedConfig;
      }
      {
        name = "projection-factory";
        path = projectionFactory;
      }
      {
        name = "reconciler.mjs";
        path = repoRoot + "/scripts/pi-agent-reconcile.mjs";
      }
      {
        name = "personal-state.json";
        path = personalState;
      }
      {
        name = "statix";
        path = pkgs.statix;
      }
      {
        name = "deadnix";
        path = pkgs.deadnix;
      }
      {
        name = "tampered-catalog-handoff";
        path = mkTamperedHandoff tamperedCatalogConfig projectionFactory;
      }
      {
        name = "tampered-selection-handoff";
        path = mkTamperedHandoff tamperedSelectionConfig projectionFactory;
      }
      {
        name = "tampered-factory-handoff";
        path = mkTamperedHandoff managedConfig tamperedFactory;
      }
    ];
  };
in
fixtures.${fixture} or (throw "unknown pi-agent provider handoff fixture: ${fixture}")
