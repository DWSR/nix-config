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
# a publication hook, or any directive in `nix.extraOptions` all fail evaluation
# with a message naming the offending value. nix-darwin forces `assertions` when
# it builds `system.build.toplevel`.
#
# `nix.extraOptions` needs its own guard: nix-darwin appends it verbatim after
# the generated settings in `/etc/nix/nix.conf`, so a later module could restate
# `substituters` or `trusted-public-keys` there (or `!include` a file that does)
# and silently win while every `nix.settings` assertion still passes. Nix also
# exposes legacy aliases such as `binary-caches`, so a directive blocklist
# would be a moving target. The builder therefore declares no directive at all;
# blank lines and `#` comments remain allowed.
#
# The same aliases work in `nix.settings`, which nix-darwin writes into
# `/etc/nix/nix.conf` verbatim. `binary-caches` is `substituters`,
# `binary-cache-public-keys` is `trusted-public-keys`, and
# `extra-binary-caches` is appended after the modern key, so the builder rejects
# every legacy cache alias and re-reads the generated `nix.conf` before it
# accepts the policy.
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

  # Every line of `nix.extraOptions` that is neither blank nor a `#` comment is
  # a directive appended after the generated settings.
  extraOptionDirectives = lib.filter (line: builtins.match "[[:space:]]*(#.*)?" line == null) (
    lib.splitString "\n" config.nix.extraOptions
  );

  # Nix still honours the pre-2.0 dash aliases for the cache settings, and
  # nix-darwin writes every `nix.settings` key into `/etc/nix/nix.conf` as-is.
  # `extra-binary-caches` is the sharpest case: nix-darwin emits it after the
  # modern `substituters`, so Nix appends it to the effective cache list even
  # while the modern keys stay exact. The policy declares the modern keys only,
  # so any legacy alias is a bypass attempt.
  legacyCacheAliases = [
    "binary-caches"
    "extra-binary-caches"
    "binary-cache-public-keys"
    "trusted-binary-caches"
    "extra-trusted-binary-caches"
  ];

  declaredLegacyCacheAliases = lib.filter (name: builtins.hasAttr name settings) legacyCacheAliases;

  # Defense in depth: parse the file Nix actually loads, so a cache that slips
  # in through a directive the option checks above do not know about still
  # fails evaluation.
  nixConfText = config.environment.etc."nix/nix.conf".source.text;
  nixConfEntries = lib.filter (entry: entry != null) (
    map (
      line:
      let
        trimmed = lib.trim line;
        pair = builtins.match "([^=]+)=(.*)" trimmed;
      in
      if trimmed == "" || lib.hasPrefix "#" trimmed then
        null
      else if lib.hasPrefix "!" trimmed || lib.hasPrefix "include " trimmed then
        {
          key = "include";
          value = trimmed;
        }
      else if pair == null then
        {
          key = trimmed;
          value = "";
        }
      else
        {
          key = lib.trim (builtins.elemAt pair 0);
          value = lib.trim (builtins.elemAt pair 1);
        }
    ) (lib.splitString "\n" nixConfText)
  );

  confTokens = lib.concatMap (
    entry: lib.filter (token: token != "") (lib.splitString " " entry.value)
  );

  confEntriesWithKey = keys: lib.filter (entry: lib.elem entry.key keys) nixConfEntries;

  confSubstituters = confTokens (confEntriesWithKey [
    "substituters"
    "extra-substituters"
    "binary-caches"
    "extra-binary-caches"
  ]);
  confTrustedPublicKeys = confTokens (confEntriesWithKey [
    "trusted-public-keys"
    "extra-trusted-public-keys"
    "binary-cache-public-keys"
  ]);

  offendingConfSubstituters = lib.filter (url: !(lib.elem url publicSubstituters)) confSubstituters;
  offendingConfTrustedPublicKeys = lib.filter (
    key: !(lib.elem key publicTrustedPublicKeys)
  ) confTrustedPublicKeys;

  confAliases = lib.filter (entry: lib.elem entry.key legacyCacheAliases) nixConfEntries;
  offendingConfAliases = map (entry: entry.key) confAliases;

  confForbiddenEntries = lib.filter (
    entry:
    entry.key == "include"
    || (
      lib.elem entry.key [
        "netrc-file"
        "secret-key-files"
        "post-build-hook"
        "extra-platforms"
      ]
      && entry.value != ""
    )
  ) nixConfEntries;

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
    {
      assertion = extraOptionDirectives == [ ];
      message = "${marker}: nix.extraOptions must stay empty because nix-darwin appends it after the generated settings, where it could override the public cache policy, got: ${builtins.toJSON extraOptionDirectives}";
    }
    {
      assertion = declaredLegacyCacheAliases == [ ];
      message = "${marker}: nix.settings must not use legacy cache aliases because Nix still honours them, got: ${builtins.toJSON declaredLegacyCacheAliases}";
    }
    {
      assertion =
        offendingConfAliases == [ ]
        && offendingConfSubstituters == [ ]
        && offendingConfTrustedPublicKeys == [ ]
        && confForbiddenEntries == [ ];
      message = "${marker}: nix.settings must not use legacy cache aliases and the generated nix.conf must carry only the public cache policy, got: ${
        builtins.toJSON {
          aliases = offendingConfAliases;
          substituters = offendingConfSubstituters;
          trusted-public-keys = offendingConfTrustedPublicKeys;
          forbidden = confForbiddenEntries;
        }
      }";
    }
  ];
}
