{ inputs, ... }:
let
  mcpServers = import ./mcp-servers.nix { inherit inputs; };
  zellijPlugins = import ./zellij-plugins.nix { inherit inputs; };
  misc = import ./misc.nix { inherit inputs; };
in
{
  unstable-packages = final: _prev: {
    unstable = import inputs.nixpkgs-unstable {
      inherit (final.stdenv.hostPlatform) system;
      config.allowUnfree = true;
    };
  };

  custom-packages =
    final: prev: (mcpServers final prev) // (zellijPlugins final prev) // (misc final prev);

  shopify-packages = final: _prev: {
    opencode-shopify = final.symlinkJoin {
      name = "opencode-shopify";
      paths = [ final.unstable.opencode ];
      nativeBuildInputs = [ final.makeWrapper ];
      postBuild = ''
        wrapProgram $out/bin/opencode \
          --run '
            OPENCODE_API_KEY="$(devx llm-gateway print-token --key 2>/dev/null)" || {
              echo "Error: Failed to get OPENCODE_API_KEY from devx llm-gateway print-token --key" >&2
              exit 1
            }
            export OPENCODE_API_KEY

            DEFAULT_PROXY_BASE="$(devx llm-gateway print-token --base 2>/dev/null)" || {
              echo "Error: Failed to get DEFAULT_PROXY_BASE from devx llm-gateway print-token --base" >&2
              exit 1
            }
            export DEFAULT_PROXY_BASE

            export OPENCODE_SESSION_ID="$(uuidgen)"
          '
      '';
    };
  };
}
