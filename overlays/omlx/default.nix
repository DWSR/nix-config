{
  inputs,
  ...
}:
final: _prev:
let
  inherit (final) lib;

  # oMLX does not commit a uv.lock upstream, so a lock generated against the
  # pinned source revision is vendored next to this file and handed to uv2nix
  # explicitly. `workspaceRoot` stays the read-only flake input; only the lock
  # is overridden.
  workspace = inputs.uv2nix.lib.workspace.loadWorkspace {
    workspaceRoot = inputs.omlx;
    uvLock = lib.importTOML ./uv.lock;
  };

  # `requires-python` is ">=3.11,<3.14"; python312 keeps a matching mlx wheel
  # available for every supported interpreter while staying on the pinned
  # nixpkgs channel's default minor version.
  python = final.python312;

  pythonBase = final.callPackage inputs.pyproject-nix.build.packages {
    inherit python;
  };

  # Prefer the PyPI wheels MLX publishes; only the git-sourced packages fall
  # back to source builds. mlx 0.32.3 ships no sdist at all, so `wheel` is
  # mandatory here, not merely an optimisation.
  generatedOverlay = workspace.mkPyprojectOverlay {
    sourcePreference = "wheel";
  };

  # uv does not lock build systems (astral-sh/uv#5190), so uv2nix resolves
  # them from pyproject-build-systems for local projects but not for packages
  # built from source. mlx-lm/mlx-vlm/mlx-audio/mlx-embeddings/dflash-mlx are
  # pinned to git revisions, so their setuptools build systems are supplied
  # here. mlx-lm derives its version from setuptools-scm, which needs a git
  # checkout it does not have; pin the version the lock resolved instead.
  sourceOverrides = _final: prev: {
    # The macOS `mlx` wheel ships `mlx/core.cpython-*.so` with LC_RPATH
    # `@loader_path/lib`, but `libmlx.dylib` is actually provided by the
    # sibling `mlx-metal` wheel, which the virtualenv materialises at a
    # different store path. dyld resolves the symlinked module to its real
    # store path, so `@loader_path/lib` cannot see mlx-metal and importing
    # mlx fails. Mirror mlx-metal's runtime libraries into mlx's own lib/
    # so the wheel's own rpath resolves.
    mlx = prev.mlx.overrideAttrs (old: {
      postFixup = (old.postFixup or "") + ''
        mlxLib="$out/${python.sitePackages}/mlx/lib"
        metalLib="${prev.mlx-metal}/${python.sitePackages}/mlx/lib"
        mkdir -p "$mlxLib"
        for f in "$metalLib"/*.dylib "$metalLib"/*.metallib; do
          ln -sf "$f" "$mlxLib/$(basename "$f")"
        done
      '';
    });

    mlx-lm = prev.mlx-lm.overrideAttrs (old: {
      nativeBuildInputs =
        (old.nativeBuildInputs or [ ])
        ++ prev.resolveBuildSystem {
          setuptools = [ ];
          setuptools-scm = [ ];
          wheel = [ ];
        };
      SETUPTOOLS_SCM_PRETEND_VERSION = "0.31.4.dev132+g94cdcae13";
    });

    mlx-vlm = prev.mlx-vlm.overrideAttrs (old: {
      nativeBuildInputs =
        (old.nativeBuildInputs or [ ])
        ++ prev.resolveBuildSystem {
          setuptools = [ ];
          wheel = [ ];
        };
    });

    mlx-audio = prev.mlx-audio.overrideAttrs (old: {
      nativeBuildInputs =
        (old.nativeBuildInputs or [ ])
        ++ prev.resolveBuildSystem {
          setuptools = [ ];
          wheel = [ ];
        };
    });

    mlx-embeddings = prev.mlx-embeddings.overrideAttrs (old: {
      nativeBuildInputs =
        (old.nativeBuildInputs or [ ])
        ++ prev.resolveBuildSystem {
          setuptools = [ ];
          wheel = [ ];
        };
    });

    dflash-mlx = prev.dflash-mlx.overrideAttrs (old: {
      nativeBuildInputs =
        (old.nativeBuildInputs or [ ])
        ++ prev.resolveBuildSystem {
          setuptools = [ ];
          wheel = [ ];
        };
    });
  };

  pythonSet = pythonBase.overrideScope (
    lib.composeManyExtensions [
      inputs.pyproject-build-systems.overlays.wheel
      generatedOverlay
      sourceOverrides
    ]
  );

  # Install oMLX with its `mcp` extra (the Homebrew formula installed the
  # `mcp` SDK into its libexec venv at activation time; the extra is the
  # declarative equivalent). The heavy `grammar` extra is intentionally not
  # enabled.
  venv = pythonSet.mkVirtualEnv "omlx-env" {
    omlx = [ "mcp" ];
  };

  inherit (final.callPackages inputs.pyproject-nix.build.util { }) mkApplication;
in
{
  omlx = mkApplication {
    inherit venv;
    package = pythonSet.omlx;
  };
}
