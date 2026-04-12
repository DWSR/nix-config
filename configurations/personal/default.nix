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
