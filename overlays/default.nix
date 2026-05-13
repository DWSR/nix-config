{ inputs, ... }:
let
  mcpServers = import ./mcp-servers.nix { inherit inputs; };
  zellijPlugins = import ./zellij-plugins.nix { inherit inputs; };
  misc = import ./misc.nix { inherit inputs; };
  litestream = import ./litestream.nix;
in
{
  fixed-packages = final: _prev: {
    # https://github.com/NixOS/nixpkgs/issues/507531
    direnv = _prev.direnv.overrideAttrs (_: {
      doCheck = false;
    });

    inherit ((import inputs.nixpkgs-unstable { inherit (final.stdenv.hostPlatform) system; })) mas;
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
