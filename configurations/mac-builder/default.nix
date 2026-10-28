{
  pkgs,
  lib,
  inputs,
  ...
}:

{
  imports = [ inputs.sops-nix.darwinModules.default ];

  nixpkgs.hostPlatform = "aarch64-darwin";
  nixpkgs.config.allowUnfree = true;

  nix.enable = true;
  nix.settings.trusted-users = [ "nix-builder" ];
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  security.pam.services.sudo_local.enable = false;

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

  users.users.nix-builder = {
    uid = 502;
    gid = 20;
    isHidden = true;
    home = "/Users/nix-builder";
    createHome = true;
    shell = "/bin/zsh";
  };

  sops.age.keyFile = "/var/lib/sops-nix/key.txt";
  sops.age.sshKeyPaths = [ ];
  sops.gnupg.sshKeyPaths = [ ];
  sops.defaultSopsFile = ../../secrets/remote-builder.mac-builder.yaml;

  sops.secrets."builder-authorized-keys" = {
    mode = "0644";
    owner = "root";
    group = "wheel";
  };

  system.activationScripts.postActivation.text = lib.mkOrder 9999 ''
    set -euo pipefail
    secret_file="/run/secrets/builder-authorized-keys"
    ssh_dir="/Users/nix-builder/.ssh"
    authorized_keys="$ssh_dir/authorized_keys"

    if [ ! -s "$secret_file" ]; then
      echo "mac-builder: required sops secret builder-authorized-keys is missing or empty at $secret_file" >&2
      exit 1
    fi

    install -d -m 0700 -o nix-builder -g staff "$ssh_dir"
    install -m 0600 -o nix-builder -g staff "$secret_file" "$authorized_keys"
  '';

  system.stateVersion = 7;
}
