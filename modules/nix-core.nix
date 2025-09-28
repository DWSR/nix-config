{pkgs, lib, ... }: {
  # Enable flakes globally
  nix.settings.experimental-features = ["nix-command" "flakes"];

  # Enable unfree (e.g. 1Password) packages
  nixpkgs.config.allowUnfree = true;

  # Set Git commit hash for darwin-version.
  # system.configurationRevision = self.rev or self.dirtyRev or null;

  # Used for backwards compatibility, please read the changelog before changing.
  # $ darwin-rebuild changelog
  system.stateVersion = 5;

  # The platform the configuration will be used on.
  nixpkgs.hostPlatform = "aarch64-darwin";

  # do garbage collection weekly to keep disk usage low
  # nix.gc = {
  #   automatic = lib.mkDefault true;
  #   options = lib.mkDefault "--delete-older-than 7d";
  # };

  # Optimize the Nix store. This instead of nix.settings.auto-optimise-store because:
  # https://github.com/NixOS/nix/issues/7273
  # nix.optimise.automatic = true;
}
