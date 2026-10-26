{
  pkgs,
  ...
}:

{
  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;

  nix.enable = true;
  nix.settings.trusted-users = [ "nix-builder" ];
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  nix.gc.automatic = true;
  nix.gc.interval = {
    Weekday = 0;
    Hour = 3;
    Minute = 15;
  };
  nix.gc.options = "--delete-older-than 7d";

  nix.optimise.automatic = true;

  services.openssh.enable = true;
  services.openssh.extraConfig = ''
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitRootLogin no
  '';

  environment.systemPackages = with pkgs; [
    git
    curl
    cacert
    coreutils
    bash
    gzip
    xz
    zstd
  ];

  system.stateVersion = 7;
}
