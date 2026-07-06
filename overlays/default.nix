{ inputs, ... }:
let
  mcpServers = import ./mcp-servers.nix { inherit inputs; };
  zellijPlugins = import ./zellij-plugins.nix { inherit inputs; };
  misc = import ./misc.nix { inherit inputs; };
  litestream = import ./litestream.nix;
in
{
  fixed-packages = final: prev: {
    # https://github.com/NixOS/nixpkgs/issues/507531
    direnv = prev.direnv.overrideAttrs (_: {
      doCheck = false;
    });

    inherit ((import inputs.nixpkgs-unstable { inherit (final.stdenv.hostPlatform) system; })) mas;

    # The `mcp` Python SDK (1.26.0, pulled in by the mcp-server-time and
    # ast-grep-mcp overlay packages) has a flaky stdio test that fails under the
    # Nix sandbox + xdist parallelism: `test_stdio_client_bad_path` races the
    # intentionally-broken subprocess's immediate exit and raises
    # BrokenResourceError out of the task group instead of handling it. nixpkgs
    # already disables ~13 sibling stdio/process-lifecycle tests for this package
    # (test_basic_child_process_cleanup, test_early_parent_exit,
    # test_stdin_close_triggers_cleanup, ...); this is the same class of flake.
    # pythonPackagesExtensions applies the override to every python3XPackages set
    # (python312 → mcp-server-time, python313 → ast-grep-mcp).
    pythonPackagesExtensions = (prev.pythonPackagesExtensions or [ ]) ++ [
      (_pyfinal: pyprev: {
        mcp = pyprev.mcp.overridePythonAttrs (old: {
          disabledTests = (old.disabledTests or [ ]) ++ [ "test_stdio_client_bad_path" ];
        });
      })
    ];
  };

  unstable-packages = final: _prev: {
    unstable = import inputs.nixpkgs-unstable {
      inherit (final.stdenv.hostPlatform) system;
      config.allowUnfree = true;
      overlays = [
        # nixpkgs-unstable's graphite-cli 1.8.6 fails to build on
        # aarch64-darwin, and because it is `unfree` Hydra never caches it, so
        # the failure only surfaces on a local build. Two upstream bugs:
        #   1. postInstall generates shell completions by running
        #      `gt completion`/`gt fish`, but the vercel/pkg `gt` binary exits
        #      non-zero with empty output when run offline (HOME=/homeless-shelter)
        #      in the Nix sandbox, so installShellCompletion aborts on the
        #      resulting zero-size file.
        #   2. the Darwin fixupPhase runs `strip`, which shifts the vercel/pkg
        #      virtual-filesystem byte offsets and corrupts the binary
        #      ("Pkg: Error reading from file."); upstream only sets `dontFixup`
        #      on Linux (dontFixup = isLinux).
        # gt-mcp only needs `gt` on PATH, so drop the completions and skip fixup.
        (_ufinal: uprev: {
          graphite-cli = uprev.graphite-cli.overrideAttrs (_: {
            dontFixup = true;
            postInstall = "";
          });
        })
      ];
    };
  };

  custom-packages =
    final: prev:
    (mcpServers final prev)
    // (zellijPlugins final prev)
    // (misc final prev)
    // (litestream final prev);
}
