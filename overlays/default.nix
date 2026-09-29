{ inputs, ... }:
let
  mcpServers = import ./mcp-servers.nix { inherit inputs; };
  zellijPlugins = import ./zellij-plugins.nix { inherit inputs; };
  misc = import ./misc.nix { inherit inputs; };
  litestream = import ./litestream.nix;
  iiiEngine = import ./agentmemory.nix { };
  agentmemoryFlake = final: _prev: {
    agentmemory =
      inputs.agentmemory.packages.${final.stdenv.hostPlatform.system}.agentmemory.overrideAttrs
        (old: {
          patches = (old.patches or [ ]) ++ [
            ./agentmemory-patches/opencode-capture.patch
            ./agentmemory-patches/opencode-cache-stability.patch
            ./agentmemory-patches/bm25-index-cap.patch
            ./agentmemory-patches/disable-otel.patch
          ];
          postPatch = (old.postPatch or "") + ''
            cp ${./agentmemory-deps/package.json} package.json
            cp ${./agentmemory-deps/package-lock.json} package-lock.json
          '';
          npmDeps = final.importNpmLock { npmRoot = ./agentmemory-deps; };
          npmConfigHook = final.importNpmLock.npmConfigHook;
          nativeBuildInputs =
            builtins.filter (input: (input.name or "") != "npm-config-hook") (old.nativeBuildInputs or [ ])
            ++ [ final.importNpmLock.npmConfigHook ];
          passthru = (old.passthru or { }) // {
            sourceRevision = "0d9306db408b1243a5b27dfa0d0c3c2790d9f6a6";
            iiiVersion = "0.11.5";
            iiiRevision = "iii/v0.11.5";
          };
        });
  };
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
        mcp = pyprev.mcp.overridePythonAttrs (
          old:
          {
            disabledTests = (old.disabledTests or [ ]) ++ [ "test_stdio_client_bad_path" ];
          }
          // final.lib.optionalAttrs final.stdenv.hostPlatform.isDarwin {
            # Individual server tests pass in isolation, but the full upstream
            # suite accumulates process-cleanup failures until later localhost
            # servers miss their fixed startup deadlines.
            doCheck = false;
          }
        );
        # These timing tests expect exactly two pings; Kqueue can schedule three
        # while still delivering the complete five-event stream.
        sse-starlette = pyprev.sse-starlette.overridePythonAttrs (old: {
          disabledTests = (old.disabledTests or [ ]) ++ [
            "test_response_send_whenValidInput_thenGeneratesExpectedOutput"
            "test_eventSourceResponse_whenUsingMemoryChannel_thenHandlesAsyncQueueCorrectly"
          ];
        });
      })
    ];
  };

  unstable-packages = final: _prev: {
    unstable = import inputs.nixpkgs-unstable {
      inherit (final.stdenv.hostPlatform) system;
      config.allowUnfree = true;
      overlays = [
        (_ufinal: uprev: {
          attic-client = uprev.attic-client.overrideAttrs (old: {
            patches = (old.patches or [ ]) ++ [ ./patches/attic-client-ca-cert.patch ];
          });
          attic-server = uprev.attic-server.override {
            inherit (uprev) attic-client;
          };
        })

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
    // (litestream final prev)
    // (iiiEngine final prev)
    // (agentmemoryFlake final prev);
}
