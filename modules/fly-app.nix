{
  config,
  lib,
  pkgs,
  ...
}:

let
  imageSourceType = lib.types.submodule {
    options = {
      existingImage = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "An existing container image reference.";
      };

      derivation = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = null;
        description = "A derivation that produces a container image.";
      };
    };
  };

  containerType = lib.types.submodule {
    options = {
      config = lib.mkOption {
        type = lib.types.json;
        default = { };
        description = "Open JSON-compatible container configuration.";
      };

      image = lib.mkOption {
        type = imageSourceType;
        default = { };
        description = "The image source for this container.";
      };
    };
  };

  machineType = lib.types.submodule {
    options = {
      config = lib.mkOption {
        type = lib.types.json;
        default = { };
        description = "Open JSON-compatible Fly Machine configuration.";
      };

      image = lib.mkOption {
        type = imageSourceType;
        default = { };
        description = "The image source for a single-container Machine.";
      };

      containers = lib.mkOption {
        type = lib.types.attrsOf containerType;
        default = { };
        description = "Containers keyed by stable logical container name.";
      };

      deployContainer = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        description = "The named container whose image is used for app deployment.";
      };
    };
  };

  hasExactlyOneImageSource =
    source:
    (source.existingImage != null) != (source.derivation != null)
    && (source.existingImage == null || source.existingImage != "");

  serializeImageSource =
    source:
    if source.existingImage != null then
      { inherit (source) existingImage; }
    else
      { derivation = toString source.derivation; };

  serializeMachine =
    name: machine:
    let
      containerNames = builtins.attrNames machine.containers;
      hasContainers = containerNames != [ ];
      deployContainerIsValid =
        if machine.deployContainer == null then
          builtins.length containerNames <= 1
        else
          hasContainers
          && builtins.hasAttr machine.deployContainer machine.containers
          && machine.deployContainer != ""
          && hasExactlyOneImageSource machine.containers.${machine.deployContainer}.image;
      serializedContainers = builtins.mapAttrs (_: container: {
        inherit (container) config;
        image = serializeImageSource container.image;
      }) machine.containers;
      serializedImage = serializeImageSource machine.image;
    in
    assert lib.asserts.assertMsg
      (
        if hasContainers then
          !hasExactlyOneImageSource machine.image
          && machine.image.existingImage == null
          && machine.image.derivation == null
          && lib.all (container: hasExactlyOneImageSource container.image) (
            builtins.attrValues machine.containers
          )
        else
          hasExactlyOneImageSource machine.image
      )
      "Fly Machine '${name}' must use exactly one image source for each required image, and cannot mix Machine and container image declarations.";
    assert lib.asserts.assertMsg deployContainerIsValid
      "Fly Machine '${name}' must select an existing deployContainer when it has multiple containers.";
    {
      inherit (machine) config;
      containers = serializedContainers;
    }
    // (if hasContainers then { } else { image = serializedImage; })
    // (if machine.deployContainer == null then { } else { inherit (machine) deployContainer; });

  spec = {
    name = config.flyApp.name;
    settings = config.flyApp.settings;
    machines = builtins.mapAttrs serializeMachine config.flyApp.machines;
  };
in
{
  options.flyApp = {
    name = lib.mkOption {
      type = lib.types.str;
      description = "Identity of the existing Fly app to configure.";
    };

    settings = lib.mkOption {
      type = lib.types.json;
      default = { };
      description = "Open JSON-compatible Fly app settings.";
    };

    machines = lib.mkOption {
      type = lib.types.attrsOf machineType;
      default = { };
      description = "Machines keyed by stable logical identity.";
    };

    spec = lib.mkOption {
      type = lib.types.path;
      readOnly = true;
      description = "Store-safe, secret-free JSON specification for the declared app.";
    };
  };

  config.flyApp.spec = pkgs.writeText "fly-app-spec.json" (builtins.toJSON spec + "\n");
}
