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
# `inputs.sops-nix.darwinModules.default`. Owning the import keeps
# sops-nix's option declarations (`sops.*`) on the merged-config
# graph before this module's `config = { sops = ...; }` block reads
# them, which is the half of the ordering story handled by import
# placement.
#
# Activation-script ordering, however, is NOT solved by import
# placement on nix-darwin. nix-darwin renders activation as a fixed
# script with a hardcoded list of named entries
# (preActivation, ..., postActivation) — see
# nix-darwin/modules/system/activation-scripts.nix:114–138 — and the
# `system.activationScripts.<name>` submodule (modules/lib/write-text.nix)
# exposes only `enable`/`text`/`target`/`source`, with NO `deps`
# field, NO DAG, and NO ordering between custom names. Custom named
# entries like `system.activationScripts.mcpSecretsBridge` are simply
# never invoked. The only ordering primitive available is the merge
# priority of `text` definitions inside one of the known names
# (here, `postActivation.text` whose type is `lib.types.lines`).
#
# sops-nix's nix-darwin module appends its `installScript`
# (which runs `sops-install-secrets` and populates `/run/secrets/*`)
# via `system.activationScripts.postActivation.text = lib.mkAfter
# installScript;` (priority 1500 — see sops-nix
# modules/nix-darwin/default.nix:389–391). Both modules using
# `mkAfter` at equal priority leaves relative order undefined; in
# practice on this nix-darwin/module-system version the bridge's
# fragment was concatenated FIRST, so `mcp-secrets-activate` ran
# BEFORE `sops-install-secrets` and the defensive `[ -e
# /run/secrets/<name> ]` guard exited 1 every switch (R1.1, R6.1
# regression).
#
# Fix: use `lib.mkOrder 9999` for our fragment so it sorts strictly
# AFTER sops-nix's `mkAfter` (1500) within the merged
# `postActivation.text`. Verify with:
#   nix eval --raw --extra-experimental-features dynamic-derivations \
#     '.#darwinConfigurations.<host>.config.system.activationScripts.postActivation.text' \
#     | grep -nE '(mcp-secrets-activate|sops-install-secrets)'
# `sops-install-secrets` MUST appear above `mcp-secrets-activate`.
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

  # Bridge-owned MCP secrets that are NOT derived from home-manager's
  # `home.mcp.keychainSecrets` (which is keyed by upstream MCP server
  # name). These secrets support mcpproxy itself rather than any
  # specific upstream — `mcpproxy-api-key` gates mcpproxy's HTTP
  # admin API (`/api/v1/*`) and is consumed by mcpproxy's own
  # `${keyring:mcpproxy-api-key}` placeholder at daemon start time,
  # not spawned-process env-var injection. The bridge still flows
  # them through the same SOPS → `/run/secrets/<name>` → Keychain
  # pipeline as the HM-declared secrets, so downstream consumers
  # (the activation script, the verify script, the operator's
  # rotation runbook) treat them uniformly.
  bridgeOwnedKeychainSecrets = [ "mcpproxy-api-key" ];

  allKeychainSecretNames = builtins.attrNames hmMcp.keychainSecrets ++ bridgeOwnedKeychainSecrets;

  # Optional Nix GitHub access-token wiring. When a host sets
  # `home.mcp.nixAccessTokenSecret`, the named secret is materialized
  # into `/etc/nix/nix.conf.d/github-access-token.conf` by the activation
  # script (see below) and `!include`d from `nix.extraOptions`. The name
  # MUST be a declared `keychainSecrets` key so sops decrypts it to
  # `/run/secrets/<name>` (and the activation guard already covers it);
  # fail the build early and loudly otherwise rather than producing a
  # host whose activation aborts at the `/run/secrets` guard.
  nixAccessTokenSecret =
    let
      name = hmMcp.nixAccessTokenSecret;
    in
    if name == null then
      null
    else if builtins.hasAttr name hmMcp.keychainSecrets then
      name
    else
      throw ''
        home.mcp.nixAccessTokenSecret = "${name}" must be a key of
        home.mcp.keychainSecrets so the sops bridge decrypts it to
        /run/secrets/${name}. Add it to keychainSecrets (with its
        1Password URI) or set nixAccessTokenSecret to null.
      '';

  # Manifest enumerating the secret slots this activation should sync.
  # Rendered into the Nix store at build time so any change to the
  # declared secret list re-renders the manifest path, keeping the
  # activation script in lockstep with `sops.secrets.*` declarations.
  manifest = pkgs.writeText "mcp-secrets-manifest.json" (
    builtins.toJSON {
      keychainSecrets = allKeychainSecretNames;
      ghAuthToken = hmMcp.ghAuthToken != null;
      # null disables the nix-token leg; a string names the /run/secrets
      # entry the activation script reads to render the nix.conf.d file.
      inherit nixAccessTokenSecret;
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

      # Disable the GPG-via-SSH probe path. sops-nix has a SEPARATE
      # `sops.gnupg.sshKeyPaths` config (default
      # `["/etc/ssh/ssh_host_rsa_key"]`) used for the gpg-from-ssh-host-
      # key derivation. We don't use GPG decryption at all (only age),
      # but `sops-install-secrets` still probes the GPG path at every
      # activation and emits a "Cannot read ssh key … no such file or
      # directory" warning when the RSA host key is absent — which is
      # the macOS default unless sshd is explicitly enabled with RSA.
      # Setting this to `[]` silences the warning without affecting
      # any decryption capability.
      gnupg.sshKeyPaths = [ ];

      # Derive sops.secrets declarations from the HM-declared secret
      # set plus the bridge-owned set defined above. Each name becomes
      # a `/run/secrets/<name>` file decrypted from the host's
      # `sops.defaultSopsFile` (set per-host). The gh-token slot is
      # conditional on ghAuthToken being non-null.
      secrets = lib.mkMerge [
        (lib.mapAttrs (_name: _opUri: {
          sopsFile = config.sops.defaultSopsFile;
        }) hmMcp.keychainSecrets)
        (lib.listToAttrs (
          map (
            name:
            lib.nameValuePair name {
              sopsFile = config.sops.defaultSopsFile;
            }
          ) bridgeOwnedKeychainSecrets
        ))
        (lib.mkIf (hmMcp.ghAuthToken != null) {
          "gh-token" = {
            sopsFile = config.sops.defaultSopsFile;
          };
        })
      ];
    };

    # `lib.mkOrder 9999` (vs sops-nix's `lib.mkAfter` = `lib.mkOrder
    # 1500`) places this fragment strictly later in the merged
    # `postActivation.text`. See the long-form rationale in the
    # module-level comment above; the short version is that two
    # `mkAfter` blocks at the same priority don't have guaranteed
    # ordering, and on this nix-darwin/module-system version that
    # gap let `mcp-secrets-activate` run BEFORE
    # `sops-install-secrets` had created `/run/secrets/<name>`,
    # causing the activation guard to exit 1 every switch.
    # The activation script's defensive guard still asserts every
    # expected `/run/secrets/<name>` exists before mutating any
    # Keychain state — it now correctly defends against future
    # ordering regressions instead of being load-bearing for
    # steady-state behaviour.
    system.activationScripts.postActivation.text = lib.mkOrder 9999 ''
      ${mcp-secrets-activate}/bin/mcp-secrets-activate ${username} ${manifest}
    '';

    # Make `nix` / `darwin-rebuild` read the activation-rendered GitHub
    # access token. `!include` (with the leading bang) is the OPTIONAL
    # form: nix.conf parsing silently skips the file when it does not yet
    # exist, so a host evaluates cleanly on its very first switch (before
    # the activation script — or the bootstrap helper — has written it).
    # The token is never placed in `nix.settings.access-tokens`, which
    # would serialize it into the world-readable Nix store; it only ever
    # lives in the root-managed, user-readable nix.conf.d file. The path
    # is absolute to match the file the activation script writes.
    nix.extraOptions = lib.mkIf (nixAccessTokenSecret != null) ''
      !include /etc/nix/nix.conf.d/github-access-token.conf
    '';
  };
}
