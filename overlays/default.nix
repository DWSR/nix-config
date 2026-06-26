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
    };
  };

  custom-packages =
    final: prev:
    (mcpServers final prev)
    // (zellijPlugins final prev)
    // (misc final prev)
    // (litestream final prev);
}
