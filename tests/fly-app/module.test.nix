{ pkgs }:
let
  modulePath = ../../modules/fly-app.nix;
  evaluate =
    declaration:
    pkgs.lib.evalModules {
      specialArgs = { inherit pkgs; };
      modules = [
        modulePath
        declaration
      ];
    };
  readSpec =
    declaration:
    builtins.fromJSON (
      builtins.unsafeDiscardStringContext (builtins.readFile (evaluate declaration).config.flyApp.spec)
    );
  rejects =
    declaration:
    let
      result = builtins.tryEval (builtins.deepSeq (readSpec declaration) true);
    in
    !result.success;

  single = {
    flyApp = {
      name = "demo";
      settings = {
        primary_region = "ord";
        unusual_setting = {
          enabled = true;
        };
      };
      machines.api = {
        config = {
          guest = {
            cpu_kind = "shared";
            cpus = 1;
            memory_mb = 256;
          };
          arbitrary_api_field = [
            "preserved"
            7
            true
          ];
        };
        image.existingImage = "registry.fly.io/demo:v1";
      };
    };
  };
  singleSpec = readSpec single;

  multi = {
    flyApp = {
      name = "multi-demo";
      machines.worker = {
        config = {
          metadata = {
            owner = "module";
          };
        };
        containers = {
          api = {
            config = {
              command = [ "serve" ];
              arbitrary = {
                keep = true;
              };
            };
            image.existingImage = "registry.fly.io/api:v1";
          };
          sidecar = {
            config = {
              entrypoint = [ "watch" ];
            };
            image.derivation = pkgs.hello;
          };
        };
        deployContainer = "api";
      };
    };
  };
  multiSpec = readSpec multi;
  multiText = builtins.readFile (evaluate multi).config.flyApp.spec;
  appToken = {
    flyApp = {
      name = "demo";
      token = "test-only-fly-token";
      machines.api.image.existingImage = "registry.fly.io/demo:v1";
    };
  };
in
assert singleSpec.name == "demo";
assert singleSpec.settings.unusual_setting.enabled;
assert
  singleSpec.machines.api.config.arbitrary_api_field == [
    "preserved"
    7
    true
  ];
assert singleSpec.machines.api.image.existingImage == "registry.fly.io/demo:v1";
assert multiSpec.machines.worker.containers.api.config.arbitrary.keep;
assert multiSpec.machines.worker.containers.sidecar.image.derivation == toString pkgs.hello;
assert multiSpec.machines.worker.deployContainer == "api";
assert builtins.match "/nix/store/.*" (toString (evaluate multi).config.flyApp.spec) != null;
assert !(pkgs.lib.hasInfix "test-only-fly-token" multiText);
assert !(builtins.hasAttr "token" singleSpec);
assert rejects {
  flyApp.name = "no-machine-image";
  flyApp.machines.api.config = { };
};
assert rejects {
  flyApp.name = "no-container-image";
  flyApp.machines.api = {
    containers.sidecar.config = {
      command = [ "sidecar" ];
    };
    deployContainer = "sidecar";
  };
};
assert rejects {
  flyApp.name = "empty-image";
  flyApp.machines.api.image.existingImage = "";
};
assert rejects {
  flyApp.name = "two-images";
  flyApp.machines.api.image = {
    existingImage = "registry.fly.io/demo:v1";
    derivation = pkgs.hello;
  };
};
assert rejects {
  flyApp.name = "mixed-machine-and-container-images";
  flyApp.machines.api = {
    image.existingImage = "registry.fly.io/demo:v1";
    containers.sidecar.image.existingImage = "registry.fly.io/sidecar:v1";
  };
};
assert rejects {
  flyApp.name = "missing-container-image";
  flyApp.machines.api = {
    containers.api.image.existingImage = "registry.fly.io/api:v1";
    containers.sidecar.config = {
      command = [ "sidecar" ];
    };
    deployContainer = "api";
  };
};
assert rejects {
  flyApp.name = "two-container-images";
  flyApp.machines.api = {
    containers.api.image = {
      existingImage = "registry.fly.io/api:v1";
      derivation = pkgs.hello;
    };
    deployContainer = "api";
  };
};
assert rejects {
  flyApp.name = "missing-deploy-container";
  flyApp.machines.api = {
    containers.api.image.existingImage = "registry.fly.io/api:v1";
    containers.sidecar.image.existingImage = "registry.fly.io/sidecar:v1";
  };
};
assert rejects {
  flyApp.name = "unknown-deploy-container";
  flyApp.machines.api = {
    containers.api.image.existingImage = "registry.fly.io/api:v1";
    deployContainer = "not-declared";
  };
};
assert rejects appToken;
true
