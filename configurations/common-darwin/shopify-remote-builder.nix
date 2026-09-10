{
  config,
  lib,
  pkgs,
  ...
}:
let
  inherit (lib) mkEnableOption mkOption types;

  absolutePathType = types.addCheck types.str (path: lib.hasPrefix "/" path) // {
    description = "absolute path";
  };
  runtimePathType =
    types.addCheck absolutePathType (
      path:
      let
        pathComponents = lib.drop 1 (lib.splitString "/" path);
        lowerPath = lib.toLower path;
        lowerStoreDir = lib.toLower builtins.storeDir;
      in
      builtins.getContext path == { }
      && path != "/"
      && lib.all (component: component != "" && component != "." && component != "..") pathComponents
      && lowerPath != lowerStoreDir
      && !lib.hasPrefix "${lowerStoreDir}/" lowerPath
    )
    // {
      description = "absolute runtime path without Nix store context";
    };
  safeRuntimePathType =
    types.addCheck runtimePathType (
      path: builtins.match "/[A-Za-z0-9._+,:=@%~-]+(/[A-Za-z0-9._+,:=@%~-]+)*" path != null
    )
    // {
      description = "canonical context-free absolute runtime path using safe ASCII characters";
    };
  safeIdentifierType =
    types.addCheck types.str (value: builtins.match "[A-Za-z_][A-Za-z0-9_-]*" value != null)
    // {
      description = "safe ASCII identifier";
    };
  uidType = types.addCheck types.ints.unsigned (uid: uid >= 500 && uid <= 65535) // {
    description = "non-root host UID from 500 through 65535";
  };
  portType = types.addCheck types.ints.positive (port: port <= 65535) // {
    description = "TCP port from 1 through 65535";
  };
  endpointType =
    types.addCheck types.str (
      endpoint:
      builtins.match "[A-Za-z0-9][A-Za-z0-9-]*(\\.[A-Za-z0-9][A-Za-z0-9-]*)*\\.local" endpoint != null
    )
    // {
      description = "single context-free .local hostname";
    };
  publicKeyType =
    types.addCheck types.str (
      key: builtins.match "ssh-ed25519 [A-Za-z0-9+/]{68}( [A-Za-z0-9._-]+)?" key != null
    )
    // {
      description = "single-line ssh-ed25519 public-key record";
    };
  cachePublicKeyType =
    types.addCheck types.str (
      key: builtins.match "[^:[:space:]]+:[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=" key != null
    )
    // {
      description = "Nix cache public key with a 32-byte base64-encoded Ed25519 payload";
    };
  parseBoundedInteger =
    upper: value:
    let
      parsed = builtins.tryEval (builtins.fromJSON value);
    in
    parsed.success && lib.isInt parsed.value && parsed.value >= 0 && parsed.value <= upper;
  ipv4CidrType =
    types.addCheck types.str (
      cidr:
      let
        parts = lib.splitString "/" cidr;
      in
      if builtins.length parts != 2 then
        false
      else
        let
          octets = lib.splitString "." (builtins.head parts);
        in
        builtins.length octets == 4
        && lib.all (parseBoundedInteger 255) octets
        && parseBoundedInteger 32 (builtins.elemAt parts 1)
    )
    // {
      description = "canonical IPv4 CIDR";
    };
  parsedCidr =
    cidr:
    let
      parts = lib.splitString "/" cidr;
      octets = lib.splitString "." (builtins.head parts);
    in
    {
      first = builtins.fromJSON (builtins.elemAt octets 0);
      second = builtins.fromJSON (builtins.elemAt octets 1);
      prefix = builtins.fromJSON (builtins.elemAt parts 1);
    };
  powerOfTwo = exponent: if exponent == 0 then 1 else 2 * powerOfTwo (exponent - 1);
  ipv4ToInteger =
    address:
    let
      octets = map builtins.fromJSON (lib.splitString "." address);
    in
    (((builtins.elemAt octets 0) * 256 + (builtins.elemAt octets 1)) * 256 + (builtins.elemAt octets 2))
    * 256
    + (builtins.elemAt octets 3);
  cidrBounds =
    cidr:
    let
      parsed = parsedCidr cidr;
      address = ipv4ToInteger (builtins.head (lib.splitString "/" cidr));
      blockSize = powerOfTwo (32 - parsed.prefix);
      network = blockSize * (builtins.div address blockSize);
    in
    {
      start = network;
      end = network + blockSize - 1;
    };
  rfc1918Ranges = map cidrBounds [
    "10.0.0.0/8"
    "172.16.0.0/12"
    "192.168.0.0/16"
  ];
  tailscaleCgnatRange = cidrBounds "100.64.0.0/10";
  rangeContains = inner: outer: inner.start >= outer.start && inner.end <= outer.end;
  isRfc1918Cidr = cidr: lib.any (range: rangeContains (cidrBounds cidr) range) rfc1918Ranges;
  publicCacheEndpointType =
    types.addCheck types.str (
      endpoint:
      let
        authority = lib.removePrefix "https://" endpoint;
        host = builtins.head (lib.splitString ":" authority);
      in
      builtins.match "https://[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?" endpoint != null
      && host != "localhost"
      && !lib.hasSuffix ".local" host
      && !lib.hasPrefix "10." host
      && !lib.hasPrefix "172.16." host
      && !lib.hasPrefix "172.17." host
      && !lib.hasPrefix "172.18." host
      && !lib.hasPrefix "172.19." host
      && !lib.hasPrefix "172.2" host
      && !lib.hasPrefix "172.30." host
      && !lib.hasPrefix "172.31." host
      && !lib.hasPrefix "192.168." host
      && !lib.hasPrefix "100.64." host
    )
    // {
      description = "HTTPS public-cache origin without private or local addressing";
    };
  repositoryComponentType =
    types.addCheck types.str (
      value: value != "." && value != ".." && builtins.match "[A-Za-z0-9][A-Za-z0-9._-]*" value != null
    )
    // {
      description = "exact repository component without URL or wildcard syntax";
    };

  repositoryOptions = {
    options = {
      provider = mkOption {
        type = repositoryComponentType;
        description = "Provider name for an allowlisted public repository.";
      };

      owner = mkOption {
        type = repositoryComponentType;
        description = "Exact owner or organization for an allowlisted repository.";
      };

      repository = mkOption {
        type = repositoryComponentType;
        description = "Exact repository name for an allowlisted public repository.";
      };
    };
  };

  publicCacheOptions = {
    options = {
      endpoint = mkOption {
        type = publicCacheEndpointType;
        description = "Anonymous public binary-cache endpoint used for attestations.";
      };

      trustedKeys = mkOption {
        type = types.listOf cachePublicKeyType;
        description = "Signing keys trusted for this public-cache endpoint.";
      };
    };
  };

  sshOptions = {
    options = {
      user = mkOption {
        type = safeIdentifierType;
        default = "_nixremote";
        description = "Dedicated personal-host account used by the restricted SSH service.";
      };

      uid = mkOption {
        type = uidType;
        default = 502;
        description = "Host-local UID reserved for the dedicated personal-host account.";
      };

      port = mkOption {
        type = portType;
        default = 22;
        description = "LAN SSH port for the personal remote-builder service.";
      };

      clientPublicKey = mkOption {
        type = types.nullOr publicKeyType;
        default = null;
        description = "Committed public half of the Shopify client key.";
      };

      privateKeyFile = mkOption {
        type = types.nullOr safeRuntimePathType;
        default = null;
        description = "Runtime path to the Shopify client private key.";
      };

      publicHostKey = mkOption {
        type = types.nullOr publicKeyType;
        default = null;
        description = "Pinned personal-host SSH public-key record.";
      };

      sourceCidrs = mkOption {
        type = types.listOf ipv4CidrType;
        default = [
          "10.0.0.0/8"
          "172.16.0.0/12"
          "192.168.0.0/16"
        ];
        description = "LAN source CIDRs accepted by the restricted SSH service.";
      };
    };
  };

  approvedPublicCaches = [
    {
      endpoint = "https://cache.nixos.org";
      trustedKeys = [
        "cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY="
      ];
    }
    {
      endpoint = "https://nix-community.cachix.org";
      trustedKeys = [
        "nix-community.cachix.org-1:mB9FSh9qf2dCimDSUo8Zy7bkq5CX+/rkCWyvRCYg3Fs="
      ];
    }
  ];

  validationOptions = {
    options = {
      timeoutSeconds = mkOption {
        type = types.ints.positive;
        default = 30 * 60;
        description = "Maximum duration of one eligibility validation.";
      };

      maxDerivations = mkOption {
        type = types.ints.positive;
        default = 10000;
        description = "Maximum derivations traversed by eligibility validation.";
      };

      maxInputSources = mkOption {
        type = types.ints.positive;
        default = 1000;
        description = "Maximum input sources traversed by eligibility validation.";
      };

      maxFixedOutputs = mkOption {
        type = types.ints.positive;
        default = 256;
        description = "Maximum fixed-output derivations replayed by eligibility validation.";
      };

      maxWorkspaceBytes = mkOption {
        type = types.ints.positive;
        default = 20 * 1024 * 1024 * 1024;
        description = "Maximum temporary workspace permitted for eligibility validation.";
      };

      publicInterface = mkOption {
        type = safeIdentifierType;
        default = "en0";
        description = "Declared non-VPN interface for public-source validation.";
      };

      maxRedirects = mkOption {
        type = types.ints.unsigned;
        default = 5;
        description = "Maximum HTTPS redirects followed during public-source validation.";
      };

      stateDirectory = mkOption {
        type = safeRuntimePathType;
        default = "/var/db/shopify-remote-builder/requests";
        description = "Personal-only runtime directory for invocation lease state.";
      };

      leaseIdleTtlSeconds = mkOption {
        type = types.ints.positive;
        default = 60 * 60;
        description = "Inactivity period before an unheld invocation lease expires.";
      };

      heartbeatSeconds = mkOption {
        type = types.ints.positive;
        default = 30;
        description = "Interval between active lease keeper heartbeats.";
      };

      publicCaches = mkOption {
        type = types.listOf (types.submodule publicCacheOptions);
        default = approvedPublicCaches;
        description = "Approved anonymous public caches for dependency-closure attestations.";
      };
    };
  };

  packageOptions = {
    options = {
      validator = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected personal-host eligibility validator package.";
      };

      lease = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected personal-host invocation lease package.";
      };

      dispatcher = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected personal-host restricted dispatcher package.";
      };

      guardedBuild = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected Shopify guarded-build package.";
      };

      diagnostics = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected remote-builder diagnostics package.";
      };

      policyProxy = mkOption {
        type = types.nullOr types.package;
        default = null;
        description = "Injected personal-host source-policy proxy package.";
      };
    };
  };

  cfg = config.services.shopifyRemoteBuilder;
  nixConfig = config.nix or { };
  nixSettings = nixConfig.settings or { };
  nixPackage = nixConfig.package or null;
  packageIdentity =
    package:
    let
      canonicalDrvAttrs = package.drvAttrs or { };
      canonical = builtins.tryEval (builtins.derivation canonicalDrvAttrs);
    in
    if !canonical.success then
      null
    else
      let
        canonicalPackage = canonical.value;
        drvPath = builtins.unsafeDiscardStringContext (toString (package.drvPath or ""));
        outPath = builtins.unsafeDiscardStringContext (toString package);
        canonicalDrvPath = builtins.unsafeDiscardStringContext (toString canonicalPackage.drvPath);
        canonicalOutPath = builtins.unsafeDiscardStringContext (toString canonicalPackage);
      in
      {
        inherit drvPath outPath;
        version = canonicalDrvAttrs.version or "";
        selfConsistent = drvPath == canonicalDrvPath && outPath == canonicalOutPath;
      };
  packageIdentityMatches =
    package: recognizedPackages:
    let
      identity = if package == null then null else packageIdentity package;
    in
    identity != null
    && identity.selfConsistent
    && lib.any (
      recognized:
      let
        recognizedIdentity = packageIdentity recognized;
      in
      recognizedIdentity != null && recognizedIdentity.selfConsistent && identity == recognizedIdentity
    ) recognizedPackages;
  trustedNixPackages = [
    pkgs.nix
  ]
  ++ lib.optional (
    builtins.hasAttr "nixVersions" pkgs && builtins.hasAttr "nix_2_34" pkgs.nixVersions
  ) pkgs.nixVersions.nix_2_34
  ++ lib.optional (builtins.hasAttr "tecnix" pkgs) pkgs.tecnix;
  trustedLixPackage = pkgs.lixPackageSets.latest.lix;
  trustedPersonalLixPackage = trustedLixPackage.overrideAttrs (old: {
    preCheck = (old.preCheck or "") + ''
      export GTEST_FILTER='-FileTransfer.*'
    '';
    doInstallCheck = false;
  });
  trustedLixPackages = [
    trustedLixPackage
    pkgs.lixPackageSets.stable.lix
    trustedPersonalLixPackage
  ];
  cacheConfig = config.services.localBinaryCache or { };
  cachePublisher = cacheConfig.publisher or { };
  cachePublisherReady =
    (cacheConfig.enable or false)
    && (cacheConfig.hostRole or null) == cfg.role
    && (cachePublisher.enable or false)
    && (cachePublisher.package or null) != null;
  listOrEmpty = value: if builtins.isList value then value else [ value ];
  globalBuilderEntries =
    (listOrEmpty (nixConfig.buildMachines or [ ])) ++ (listOrEmpty (nixSettings.builders or [ ]));
  globalPersonalBuilderConfigured = lib.any (
    builder:
    let
      rendered = if builtins.isString builder then builder else builtins.toJSON builder;
    in
    lib.hasInfix (lib.toLower cfg.endpoint) (lib.toLower rendered)
  ) globalBuilderEntries;
  isApprovedPublicCache =
    cache:
    lib.any (
      approved: cache.endpoint == approved.endpoint && cache.trustedKeys == approved.trustedKeys
    ) approvedPublicCaches;
  publicCachesValid =
    cfg.validation.publicCaches != [ ]
    && lib.all (cache: builtins.length cache.trustedKeys > 0) cfg.validation.publicCaches
    && lib.all isApprovedPublicCache cfg.validation.publicCaches;
  isTailscaleCidr = cidr: rangeContains (cidrBounds cidr) tailscaleCgnatRange;
  sourceCidrsValid =
    cfg.ssh.sourceCidrs != [ ]
    && lib.all (cidr: isRfc1918Cidr cidr && !isTailscaleCidr cidr) cfg.ssh.sourceCidrs;
  nixPackageIdentity = if nixPackage == null then null else packageIdentity nixPackage;
  nixPackageVersion = if nixPackageIdentity == null then "" else nixPackageIdentity.version;
  personalPackageIdentityValid =
    nixPackage != null && packageIdentityMatches nixPackage trustedLixPackages;
  personalVersionValid = nixPackage != null && lib.versionAtLeast nixPackageVersion "2.95.2";
  shopifyPackageIdentityValid =
    nixPackage != null && packageIdentityMatches nixPackage trustedNixPackages;
  shopifyVersionValid =
    nixPackage != null && (nixPackageVersion == "2.34" || lib.hasPrefix "2.34." nixPackageVersion);
  personalKeyContractValid = cfg.ssh.clientPublicKey != null && cfg.ssh.privateKeyFile == null;
  shopifyKeyContractValid = cfg.ssh.privateKeyFile != null && cfg.ssh.publicHostKey != null;
in
{
  options.services.shopifyRemoteBuilder = {
    enable = mkEnableOption "explicit guarded public remote builds";

    role = mkOption {
      type = types.enum [
        "personal"
        "shopify"
      ];
      default = "personal";
      description = "The single host role represented by this configuration.";
    };

    endpoint = mkOption {
      type = endpointType;
      default = "Brandons-MacBook-Pro.local";
      description = "Declared LAN hostname of the personal remote-builder endpoint.";
    };

    system = mkOption {
      type = types.str;
      default = "aarch64-darwin";
      description = "Nix system supported by the remote-builder workflow.";
    };

    allowedRepositories = mkOption {
      type = types.listOf (types.submodule repositoryOptions);
      default = [
        {
          provider = "github";
          owner = "NixOS";
          repository = "nixpkgs";
        }
      ];
      description = "Exact public repository triples eligible for guarded evaluation.";
    };

    ssh = mkOption {
      type = types.submodule sshOptions;
      default = { };
      description = "Restricted SSH identity, host trust, and source-network contract.";
    };

    validation = mkOption {
      type = types.submodule validationOptions;
      default = { };
      description = "Bounded public-source validation and invocation-lease settings.";
    };

    packages = mkOption {
      type = types.submodule packageOptions;
      default = { };
      description = "Dependency-injected remote-builder packages used by host roles and tests.";
    };
  };

  config.assertions = [
    {
      assertion = !cfg.enable || nixPackage != null;
      message = "services.shopifyRemoteBuilder requires nix.package when enable is true.";
    }
    {
      assertion =
        !cfg.enable || cfg.role != "personal" || (personalPackageIdentityValid && personalVersionValid);
      message = "services.shopifyRemoteBuilder.personal role requires Lix 2.95.2 or newer.";
    }
    {
      assertion =
        !cfg.enable || cfg.role != "shopify" || (shopifyPackageIdentityValid && shopifyVersionValid);
      message = "services.shopifyRemoteBuilder.shopify role requires Nix/Tecnix 2.34.";
    }
    {
      assertion = !cfg.enable || cachePublisherReady;
      message = "services.shopifyRemoteBuilder requires a matching enabled local-binary-cache publisher.";
    }
    {
      assertion = !cfg.enable || !(nixConfig.distributedBuilds or false);
      message = "services.shopifyRemoteBuilder requires nix.distributedBuilds = false.";
    }
    {
      assertion = !cfg.enable || !globalPersonalBuilderConfigured;
      message = "services.shopifyRemoteBuilder must not configure a global personal builder.";
    }
    {
      assertion = !cfg.enable || publicCachesValid;
      message = "services.shopifyRemoteBuilder.validation.publicCaches must contain only approved signed public caches.";
    }
    {
      assertion = !cfg.enable || sourceCidrsValid;
      message = "services.shopifyRemoteBuilder.ssh.sourceCidrs must contain only approved RFC1918 IPv4 LAN CIDRs and exclude Tailscale CGNAT.";
    }
    {
      assertion = !cfg.enable || cfg.role != "personal" || personalKeyContractValid;
      message = "services.shopifyRemoteBuilder.personal role requires a client public key and no private key.";
    }
    {
      assertion = !cfg.enable || cfg.role != "shopify" || shopifyKeyContractValid;
      message = "services.shopifyRemoteBuilder.shopify role requires a private key path and pinned public host key.";
    }
  ];
}
