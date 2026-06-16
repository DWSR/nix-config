{
  pkgs,
  username,
  ...
}:
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
  };

  nix.package = pkgs.lixPackageSets.latest.lix;

  home-manager.users.${username} = import ./home-manager;

  homebrew = {
    masApps = {
      "1Password for Safari" = 1569813296;
      "Apple Configurator" = 1037126344;
      "Balance Lock" = 1019371109;
      "Clocker" = 1056643111;
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
    };

    casks = [
      "ungoogled-chromium"
      "moom"
      "orbstack"
      "oversight"
      "orion"
      "balenaetcher"
      "homerow"
      "obs"
    ];
  };
}
