# Builder Cache Policy: public caches only and `aarch64-darwin` only
# (mac-builder-for-fabro-nix-darwin-builds, task 3; design "Component Contracts
# → Builder Host → Builder Cache Policy"; requirements 5.3, 5.4, 7.1, 7.2, 7.3,
# 7.4, 7.7).
#
# The builder is a remote builder for one system, drawing its inputs from the
# two public caches the repository already trusts and never touching the
# private binary cache or Attic. `substituters` and `trusted-public-keys` are
# declared exactly — not appended through `extra-*` — so the evaluated host
# carries one deliberate pair of lists. nix-darwin's own module also appends
# `https://cache.nixos.org/` with `mkAfter`, so the evaluated list may repeat
# that public entry; the assertions below pin the set, not the repetition, and
# fail as soon as any cache outside the pair appears. There is no cache
# credential file and no `post-build-hook`, so the builder never publishes an
# output.
#
# `assertions` keep the policy honest for any later module: an `extra-platforms`
# entry, a second host platform, a private-cache URL or key, a cache credential,
# or a publication hook all fail evaluation with a message naming the offending
# value. nix-darwin forces `assertions` when it builds `system.build.toplevel`.
{
  config,
  lib,
  ...
}:
let
  publicSubstituters = [
    "https://cache.nixos.org/"
    "https://nix-community.cachix.org"
  ];

  # The trusted keys of exactly those two caches (see `research.md`, "Public
  # caches"). A future nixpkgs default change is caught by the exact-set
  # repository check, which forces a deliberate update here.
  publicTrustedPublicKeys = [
    "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
    "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
  ];

  settings = config.nix.settings;

  extraPlatforms = settings.extra-platforms or [ ];
  extraSubstituters = settings.extra-substituters or [ ];
  extraTrustedPublicKeys = settings.extra-trusted-public-keys or [ ];
  offendingSubstituters = lib.filter (url: !(lib.elem url publicSubstituters)) (
    (settings.substituters or [ ]) ++ extraSubstituters
  );
  offendingTrustedPublicKeys = lib.filter (key: !(lib.elem key publicTrustedPublicKeys)) (
    (settings.trusted-public-keys or [ ]) ++ extraTrustedPublicKeys
  );

  # `netrc-file` and `secret-key-files` are the two ways a Nix host holds a
  # cache credential. Neither public cache needs one, so any credential file on
  # this host would serve a private cache.
  cacheCredentialFiles = lib.filter (value: value != null && value != "") (
    lib.optional (settings ? netrc-file) (
      if settings.netrc-file == null then null else toString settings.netrc-file
    )
    ++ map toString (settings.secret-key-files or [ ])
  );

  postBuildHook =
    if settings ? post-build-hook && settings.post-build-hook != null then
      toString settings.post-build-hook
    else
      null;

  marker = "mac-builder cache policy";
in
{
  nix.settings = {
    substituters = publicSubstituters;
    trusted-public-keys = publicTrustedPublicKeys;
  };

  assertions = [
    {
      assertion = extraPlatforms == [ ];
      message = "${marker}: extra-platforms must stay unset so the builder serves aarch64-darwin only, got: ${builtins.toJSON extraPlatforms}";
    }
    {
      assertion = config.nixpkgs.hostPlatform.system == "aarch64-darwin";
      message = "${marker}: nixpkgs.hostPlatform must stay aarch64-darwin, got: ${config.nixpkgs.hostPlatform.system}";
    }
    {
      assertion = offendingSubstituters == [ ];
      message = "${marker}: every substituter must be one of the public caches, got: ${builtins.toJSON offendingSubstituters}";
    }
    {
      assertion = offendingTrustedPublicKeys == [ ];
      message = "${marker}: every trusted public key must belong to a public cache, got: ${builtins.toJSON offendingTrustedPublicKeys}";
    }
    {
      assertion = cacheCredentialFiles == [ ];
      message = "${marker}: the builder must not hold a private cache credential, got: ${builtins.toJSON cacheCredentialFiles}";
    }
    {
      assertion = postBuildHook == null;
      message = "${marker}: the builder must not publish build outputs to any cache, got post-build-hook = ${builtins.toJSON postBuildHook}";
    }
  ];
}
