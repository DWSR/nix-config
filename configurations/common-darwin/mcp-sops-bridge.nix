{
  pkgs,
  lib,
  config,
  inputs,
  username,
  ...
}:
# mcp-sops-bridge: nix-darwin SYSTEM module that wires sops-nix into
# the host and orchestrates the activation-time bridge from sops's
# decrypted `/run/secrets/<name>` files to the macOS Keychain + gh CLI.
#
# This module OWNS the sops-nix import. Per design D3, per-host
# `configurations/{shopify,personal}/default.nix` files import ONLY
# this bridge module — they MUST NOT separately import
# `inputs.sops-nix.darwinModules.default`. Doing so via this module
# guarantees that sops-nix's options + its `installScript` activation
# hook are merged before the bridge's `mkAfter` block runs, so the
# activation-script invocation below is text-concatenated AFTER
# sops-nix has populated `/run/secrets/<name>`.
#
# The bridge is read-only against home-manager config: it reads
# `config.home-manager.users.${username}.home.mcp.{keychainSecrets,
# ghAuthToken}` to derive which sops secrets to declare, but never
# redefines those HM options (which would cause module-merge errors).
#
# `sops.defaultSopsFile` is intentionally NOT set here — each per-host
# `default.nix` owns the choice of which encrypted yaml to use
# (`secrets/mcp.shopify.yaml` vs `secrets/mcp.personal.yaml`).
let
  hmMcp = config.home-manager.users.${username}.home.mcp;

  mcp-secrets-activate = import ../../scripts/mcp-secrets-activate.nix { inherit pkgs; };

  # Manifest enumerating the secret slots this activation should sync.
  # Rendered into the Nix store at build time so any change to the
  # declared secret list re-renders the manifest path, keeping the
  # activation script in lockstep with `sops.secrets.*` declarations.
  manifest = pkgs.writeText "mcp-secrets-manifest.json" (
    builtins.toJSON {
      keychainSecrets = builtins.attrNames hmMcp.keychainSecrets;
      ghAuthToken = hmMcp.ghAuthToken != null;
    }
  );
in
{
  imports = [ inputs.sops-nix.darwinModules.default ];

  config = {
    sops = {
      age = {
        # Absolute, system-readable path. sops-nix passes this to
        # `sops-install-secrets` via the activation manifest. The host
        # operator places the per-host age private key here once at
        # bootstrap; subsequent switches need no 1Password access.
        keyFile = "/var/lib/sops-nix/key.txt";
        # Disable the SSH-host-key-derivation path. sops-nix's Darwin
        # default is `["/etc/ssh/ssh_host_ed25519_key"]`, which assumes
        # sshd is enabled and the host key file exists. ShopifyLaptop
        # (and likely the personal MBP) doesn't run sshd, so the
        # default path doesn't exist and would surface a confusing
        # warning. The age keyFile above is the only key source we
        # want this pipeline to use.
        sshKeyPaths = [ ];
      };

      # Derive sops.secrets declarations from the HM-declared secret
      # set. Each name becomes a `/run/secrets/<name>` file decrypted
      # from the host's `sops.defaultSopsFile` (set per-host). The
      # gh-token slot is conditional on ghAuthToken being non-null.
      secrets = lib.mkMerge [
        (lib.mapAttrs (_name: _opUri: {
          sopsFile = config.sops.defaultSopsFile;
        }) hmMcp.keychainSecrets)
        (lib.mkIf (hmMcp.ghAuthToken != null) {
          "gh-token" = {
            sopsFile = config.sops.defaultSopsFile;
          };
        })
      ];
    };

    # `mkAfter` ensures this fragment is concatenated after sops-nix's
    # own `installScript` text (which is added at default priority
    # within the same `system.activationScripts.postActivation.text`
    # attribute). The activation script's defensive guard then
    # asserts every expected `/run/secrets/<name>` exists before
    # mutating any Keychain state.
    system.activationScripts.postActivation.text = lib.mkAfter ''
      ${mcp-secrets-activate}/bin/mcp-secrets-activate ${username} ${manifest}
    '';
  };
}
