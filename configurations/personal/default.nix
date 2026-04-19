{
  pkgs,
  username,
  ...
}:
{
  imports = [
    ../common-darwin
  ];

  nix-config.repoPath = "/Users/${username}/repos/github.com/DWSR/nix-config";

  nix.package = pkgs.lixPackageSets.latest.lix;

  home-manager.users.${username} = import ./home-manager;

  homebrew = {
    masApps = {
      "1Password for Safari" = 1569813296;
      "Apple Configurator" = 1037126344;
      "Balance Lock" = 1019371109;
      "CrystalFetch" = 6454431289;
      "Discovery" = 1381004916;
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
      "domzilla-caffeine"
      "ungoogled-chromium"
      "moom"
      "orbstack"
      "oversight"
      "orion"
      # "pocket-casts"
      "homerow"
      "obs"
      "audio-hijack"
    ];
  };
}
