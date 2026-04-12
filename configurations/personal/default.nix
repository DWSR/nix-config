{
  pkgs,
  username,
  ...
}:
{
  imports = [
    ../common-darwin
  ];

  nix.package = pkgs.lixPackageSets.latest.lix;

  home-manager.users.${username} = import ./home-manager;

  homebrew = {
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
