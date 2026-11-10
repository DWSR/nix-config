{ lib, ... }:

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
  };
}
