{
  config,
  lib,
  pkgs,
  username,
  ...
}:
let
  cacheBootstrapDirectory = "/var/db/local-binary-cache/bootstrap";
  cachePublicKey = lib.removeSuffix "\n" (
    builtins.readFile ../../certificates/local-binary-cache/cache-public-key.txt
  );
  cacheSecretsFile = ../../secrets/local-binary-cache.personal.yaml;
  pressure = config.services.localBinaryCache.gcPolicy;
in
{
  imports = [
    ../common-darwin
    ../common-darwin/mcp-sops-bridge.nix
  ];

  nix-config.repoPath = "/Users/${username}/repos/github.com/DWSR/nix-config";

  sops = {
    defaultSopsFile = ../../secrets/mcp.personal.yaml;
    # Skip build-time validation that every declared `sops.secrets.<name>`
    # key exists in `defaultSopsFile`. Until Task 4.4 runs
    # `mcp-sync-from-1password` to produce the real encrypted yaml, the
    # file at this path is a one-line placeholder (committed so the path
    # expression resolves and the flake's git-tree visibility check
    # passes) that does not contain the declared keys. Activation
    # (Task 4.5) is operator-gated and is the point at which decryption
    # actually runs; validating sopsFile contents at build time only
    # blocks `nix build` here without adding safety, since activation
    # would catch the same problem.
    validateSopsFiles = false; # TODO: remove once Task 4.4 produces the real encrypted yaml

    # Deskflow server TLS identity (cert + private key, PEM). Decrypted to an
    # owner-only path under /run/secrets and referenced by path from the
    # personal host's home.deskflow.tls.certificateFile -- the key never enters
    # the Nix store. sops-nix's HM module is broken on darwin, so the secret is
    # declared at the system level here. See secrets/deskflow-cert.personal.yaml
    # and home-manager/deskflow.nix.
    secrets."deskflow-cert" = {
      sopsFile = ../../secrets/deskflow-cert.personal.yaml;
      # The cert PEM is stored as the `data` key of a sops YAML envelope (the
      # generator uses `sops --input-type binary --output-type yaml`). Decrypt it
      # as YAML and extract that key. NOTE: do NOT use `format = "binary"` here --
      # sops-nix's binary path uses sops's binary store, which expects a JSON
      # envelope and fails on the YAML one ("cannot parse json ... invalid
      # character 'd'" from the leading `data:`).
      format = "yaml";
      key = "data";
      owner = username;
      mode = "0400";
    };

    secrets."local-binary-cache-tls-key" = {
      sopsFile = cacheSecretsFile;
      key = "local-binary-cache-tls-key";
      owner = username;
      mode = "0400";
    };

    secrets."local-binary-cache-jwt-private-key" = {
      sopsFile = cacheSecretsFile;
      key = "local-binary-cache-jwt-private-key";
      owner = "root";
      mode = "0400";
    };

    secrets."local-binary-cache-personal-token" = {
      sopsFile = cacheSecretsFile;
      key = "local-binary-cache-personal-token";
      owner = "root";
      mode = "0400";
    };
  };

  services.localBinaryCache = {
    enable = true;
    hostRole = "personal";
    bootstrapMode = false;
    inherit cachePublicKey;
    caCertificate = ../../certificates/local-binary-cache/ca.pem;

    consumer.enable = true;
    publisher = {
      enable = true;
      package = pkgs.unstable.attic-client;
      tokenFile = config.sops.secrets."local-binary-cache-personal-token".path;
      stateDirectory = "/var/db/local-binary-cache/publisher";
    };

    bootstrap = {
      jwtPrivateKey = config.sops.secrets."local-binary-cache-jwt-private-key".path;
      cachePublicKeyOutput = "${cacheBootstrapDirectory}/cache-public-key.txt";
      personalTokenOutput = "${cacheBootstrapDirectory}/personal-token";
    };

    server = {
      enable = true;
      package = pkgs.unstable.attic-server;
      proxyPackage = pkgs.unstable.caddy;
      stateDirectory = "/var/db/local-binary-cache/attic";
      jwtPublicKey = ../../certificates/local-binary-cache/jwt-public.pem;
      tlsCertificate = ../../certificates/local-binary-cache/server.pem;
      tlsKeyFile = config.sops.secrets."local-binary-cache-tls-key".path;
    };
  };

  # No recent Lix is cached on cache.nixos.org for aarch64-darwin (both 2.94
  # and 2.95 narinfos 404), so this host always builds Lix from source and runs
  # its build-time test suites. Two suites need facilities the macOS Nix build
  # sandbox lacks, so we trim them:
  #
  #   * check (unit): libstore's `FileTransfer.*` tests spin up a local HTTP
  #     server on the IPv6 loopback (`http://[::1]:PORT`). That does not work in
  #     the sandbox, and `exceptionAbortsRead` has no timeout, so the read
  #     blocks until the UBSan trap (`-fsanitize-undefined-trap-on-error`, a
  #     `brk` on aarch64) kills the build with SIGTRAP after ~19 min. Upstream
  #     already disables three of these on darwin (the `NOT_ON_DARWIN` macro in
  #     tests/unit/libstore/filetransfer.cc) but left the rest active; skip the
  #     whole networked group via gtest's env filter. The remaining unit tests
  #     (~2s, environment-independent) still run.
  #
  #   * installcheck (functional): fetchurl, nar-access,
  #     mtls-substituter-ssl-client-cert, and functional2 hang to the 300s meson
  #     timeout (they need a fully networked daemon / local servers). meson has
  #     no clean per-test deselect for these, so the functional suite is off.
  #
  # See lix issues fj#564 (IPv6 loopback) and fj#364.
  nix.package = pkgs.lixPackageSets.latest.lix.overrideAttrs (old: {
    preCheck = (old.preCheck or "") + ''
      export GTEST_FILTER='-FileTransfer.*'
    '';
    doInstallCheck = false;
  });

  nix.gc.interval = lib.mkForce {
    Hour = 3;
    Minute = 15;
  };

  nix.settings = lib.mkIf (pressure.minFree != null && pressure.maxFree != null) {
    min-free = pressure.minFree;
    max-free = pressure.maxFree;
  };

  home-manager.users.${username} = import ./home-manager;

  homebrew = {
    masApps = {
      "1Password for Safari" = 1569813296;
      "Apple Configurator" = 1037126344;
      "Balance Lock" = 1019371109;
      "CrystalFetch" = 6454431289;
      "Discovery" = 1381004916;
      "HazeOver" = 430798174;
      "Hidden Bar" = 1452453066;
      "Kagi for Safari" = 1622835804;
      "Keynote" = 409183694;
      "Mini Motorways" = 1456188526;
      "Numbers" = 361304891;
      "Pages" = 409201541;
      "Refined GitHub" = 1519867270;
      "SponsorBlock" = 1573461917;
      "Tailscale" = 1475387142;
      "uBlock Origin Lite" = 6745342698;
      "Xcode" = 497799835;
    };

    casks = [
      "ungoogled-chromium"
      "orbstack"
      "oversight"
      "orion"
      "balenaetcher"
      "homerow"
      "obs"
    ];
  };
}
