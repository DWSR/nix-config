# The repo-owned sandbox image for the fabro-vm guest's `default` Fabro
# environment (spec `nix-built-container-for-default-fabro-environmen`).
#
# `fabro.sandboxImage.archive` is the OCI archive built with the pinned
# `nix-snapshotter` input (the overlay applied in flake.nix supplies
# `pkgs.nix-snapshotter`). The archive is a store-path *manifest*: its layers
# hold empty `/nix/store/<path>` mountpoints plus rootfs symlinks, and the
# real content is supplied by the host `/nix/store` bind mount declared in
# ./sandbox.nix. It is `aarch64-linux` and therefore built on the guest; the
# darwin host evaluates but cannot build it, mirroring
# `packages.aarch64-linux.fabro-vm-image`.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.fabro.sandboxImage;
in
{
  options.fabro.sandboxImage = {
    enable = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether the repo-owned sandbox image is the guest's Fabro
        `default` environment image source.
      '';
    };

    name = lib.mkOption {
      type = lib.types.str;
      default = "localhost/fabro-sandbox";
      description = ''
        OCI image name. Fabro references the image by
        `<name>@<digest>`; the name is also the archive derivation's
        `nix-image-<baseName>.tar` stem.
      '';
    };

    tag = lib.mkOption {
      type = lib.types.str;
      default = "latest";
      description = ''
        Local tag retained for the loaded image (storage only — Fabro
        resolves the immutable digest, not the tag).
      '';
    };

    contents = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        bashInteractive
        git
        coreutils
        nix
      ];
      defaultText = lib.literalExpression ''
        with pkgs; [ bashInteractive git coreutils nix ]
      '';
      description = ''
        Packages whose `/bin` entries the image exposes on its default
        command path (bash, git, coreutils, and nix).
      '';
    };

    imageConfig = lib.mkOption {
      type = lib.types.attrs;
      default = {
        Env = [
          "PATH=/bin"
          "NIX_REMOTE=daemon"
        ];
        Cmd = [ "/bin/bash" ];
        WorkingDir = "/";
      };
      description = ''
        OCI image configuration. `Env` must carry `PATH=/bin` (the Fabro
        Docker provider runs a non-login shell, so the path cannot come
        from a profile) and `NIX_REMOTE=daemon` (the host daemon socket
        bind-mounted by ./sandbox.nix).
      '';
    };

    copyToRoot = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = pkgs.buildEnv {
        name = "fabro-sandbox-root";
        paths = cfg.contents;
        pathsToLink = [ "/bin" ];
      };
      description = ''
        Read-only root filesystem derivation: the `contents` packages
        linked into `/bin`, with their store-path prefix stripped and
        placed at the image root by `buildImage`.
      '';
    };

    archive = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default = pkgs.nix-snapshotter.buildImage {
        inherit (cfg) name tag copyToRoot;
        config = cfg.imageConfig;
      };
      description = ''
        Read-only OCI archive (`nix-image-<baseName>.tar`) built with the
        pinned `nix-snapshotter`. Its layers hold empty store-path
        mountpoints; the host `/nix/store` bind mount supplies the content.
      '';
    };

    digest = lib.mkOption {
      type = lib.types.package;
      readOnly = true;
      default =
        pkgs.runCommand "fabro-sandbox-image-digest"
          {
            nativeBuildInputs = [
              pkgs.jq
              pkgs.coreutils
            ];
          }
          ''
            set -euo pipefail

            # Extract the OCI image-layout index from the archive and read the
            # manifest digest. `tar` comes from the stdenv base path; a missing
            # index.json aborts here via `set -e`.
            tar -xOf ${cfg.archive} index.json > index.json
            digest="$(jq -r '.manifests[0].digest' index.json)"

            # Fabro references the image by content digest, so the value must be
            # a single `sha256:<64 lowercase hex>` line. Anything else (a missing
            # digest renders as the literal `null`) fails the build instead of
            # yielding a bogus image reference.
            if ! printf '%s' "$digest" | grep -Eqx 'sha256:[0-9a-f]{64}'; then
              echo "fabro-sandbox-image-digest: ${cfg.archive}: index.json manifest digest is not a single sha256:<64 hex> value: '$digest'" >&2
              exit 1
            fi

            printf '%s\n' "$digest" > "$out"
          '';
      description = ''
        Read-only text file holding the OCI manifest digest
        (`sha256:<hex>`) extracted from the archive's `index.json`. Fabro
        references the image as `<name>@<digest>`. The digest is a build
        artifact consumed at run time (embedded in the loader unit's
        `ExecStart`); it is never read during evaluation, so no import-from-
        derivation is triggered.
      '';
    };
  };
}
