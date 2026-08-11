{
  config,
  lib,
  pkgs,
  ...
}:
let
  binksReview = pkgs.callPackage ../../../scripts/binks-review.nix {
    homeDirectory = config.home.homeDirectory;
  };
  inherit (config.programs.opencode-nono) auditProfile managedProfile;
  binksStatePath = "$HOME/.local/share/binks-review";
  binksCachePath = "$HOME/.cache/binks-review";
  uvConfigPath = "$HOME/.config/uv";
in
{
  home.packages = [ binksReview ];

  home.activation.createBinksReviewState = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ${pkgs.coreutils}/bin/install -d -m 0700 "${config.home.homeDirectory}/.local/share/binks-review"
  '';

  programs.opencode.commands.binks-review = ./commands/binks-review.md;

  xdg.configFile."opencode/skills/binks-pr-review".source = ./skills/binks-pr-review;

  # OpenCode can execute the host-installed environment but cannot mutate it.
  # Match the existing per-leaf mkDefault priority so these lists concatenate
  # with, rather than replace, the base OpenCode data-path grants.
  programs.opencode-nono.profiles = {
    ${auditProfile}.filesystem = {
      read = lib.mkDefault [ binksStatePath ];
      deny = lib.mkDefault [
        binksCachePath
        uvConfigPath
      ];
    };
    ${managedProfile}.filesystem = {
      read = lib.mkDefault [ binksStatePath ];
      deny = lib.mkDefault [
        binksCachePath
        uvConfigPath
      ];
    };
  };
}
