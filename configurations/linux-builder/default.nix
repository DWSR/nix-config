{
  config,
  lib,
  pkgs,
  ...
}:
let
  secretStore = ../../secrets/remote-builder.linux-builder.yaml;
  evaluationOnlyStore = pkgs.writeText "linux-builder-unprovisioned-secrets.yaml" "";
in
{
  nixpkgs.hostPlatform = "aarch64-linux";
  networking.hostName = "linux-builder";

  boot.loader.grub = {
    enable = true;
    device = "nodev";
    efiSupport = true;
    efiInstallAsRemovable = true;
  };
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  nix.enable = true;
  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    extra-platforms = [ ];
    max-jobs = 4;
    build-users-group = "nixbld";
    trusted-users = lib.mkForce [ "builder" ];
  };

  users.groups.builder = { };
  users.users.builder = {
    isNormalUser = true;
    group = "builder";
    home = "/home/builder";
    createHome = true;
  };

  services.openssh = {
    enable = true;
    openFirewall = false;
    hostKeys = [
      {
        path = "/var/lib/ssh/ssh_host_ed25519_key";
        type = "ed25519";
      }
    ];
    settings = {
      AllowUsers = [ "builder" ];
      KbdInteractiveAuthentication = false;
      PasswordAuthentication = false;
      PermitRootLogin = "no";
    };
  };

  sops.useSystemdActivation = true;
  sops.age = {
    keyFile = "/var/lib/sops-nix/key.txt";
    sshKeyPaths = [ ];
  };
  sops.gnupg.sshKeyPaths = [ ];
  # The encrypted builder store is operator-provisioned by task 5.1. The
  # evaluation-only empty file keeps the portable host evaluable in advance;
  # actual activation still requires the provisioned store and age key.
  sops.defaultSopsFile = builtins.toString (
    if builtins.pathExists secretStore then secretStore else evaluationOnlyStore
  );
  sops.secrets = {
    "builder-authorized-keys" = {
      path = "/run/secrets/builder-authorized-keys";
      mode = "0400";
      owner = "root";
    };
    "builder-tailscale-oauth-secret" = {
      path = "/run/secrets/builder-tailscale-oauth-secret";
      mode = "0400";
      owner = "root";
    };
  };

  systemd.services.sops-install-secrets.preStart = ''
    if [ ! -f ${lib.escapeShellArg (toString secretStore)} ] || [ ! -s ${lib.escapeShellArg (toString secretStore)} ]; then
      echo "linux-builder: required encrypted SOPS store is missing or empty at ${toString secretStore}; provision it before activation" >&2
      exit 1
    fi
    if [ ! -s ${lib.escapeShellArg config.sops.age.keyFile} ]; then
      echo "linux-builder: required SOPS age key is missing at ${config.sops.age.keyFile}; provision it before activation" >&2
      exit 1
    fi
  '';

  systemd.services.builder-authorized-keys = {
    description = "Install the SOPS-managed builder SSH authorized keys";
    wantedBy = [ "multi-user.target" ];
    requires = [ "sops-install-secrets.service" ];
    after = [ "sops-install-secrets.service" ];
    before = [ "sshd.service" ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
    };
    script = ''
      set -eu
      secret_file="${config.sops.secrets."builder-authorized-keys".path}"
      ssh_dir="/home/builder/.ssh"

      if [ ! -s "$secret_file" ]; then
        echo "linux-builder: required builder-authorized-keys secret is missing or empty at $secret_file" >&2
        exit 1
      fi

      install -d -m 0700 -o builder -g builder "$ssh_dir"
      install -m 0600 -o builder -g builder "$secret_file" "$ssh_dir/authorized_keys"
    '';
  };

  systemd.services.sshd = {
    requires = [ "builder-authorized-keys.service" ];
    after = [ "builder-authorized-keys.service" ];
  };

  services.tailscale = {
    enable = true;
    openFirewall = true;
  };

  systemd.services.builder-tailscale-auth = {
    description = "Join the linux-builder node to its tailnet using its OAuth credential";
    wantedBy = [ "multi-user.target" ];
    requires = [
      "sops-install-secrets.service"
      "tailscaled.service"
    ];
    after = [
      "sops-install-secrets.service"
      "tailscaled.service"
    ];
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      TimeoutStartSec = "0";
    };
    script = ''
      set -eu
      credential_file=${lib.escapeShellArg config.sops.secrets."builder-tailscale-oauth-secret".path}
      if [ ! -s "$credential_file" ]; then
        echo "linux-builder: required Tailscale OAuth credential is missing or empty at $credential_file" >&2
        exit 1
      fi

      until ${config.services.tailscale.package}/bin/tailscale up \
        --auth-key="$(cat "$credential_file")?ephemeral=false&preauthorized=true" \
        --hostname=linux-builder \
        --advertise-tags=tag:linux-nix-remote-builder \
        --accept-dns=false; do
        echo "linux-builder: Tailscale enrollment failed; retrying in 30 seconds" >&2
        ${pkgs.coreutils}/bin/sleep 30
      done
    '';
  };

  nix.gc = {
    automatic = true;
    dates = "daily";
    options = "--delete-older-than 7d";
  };
  nix.optimise = {
    automatic = true;
    dates = [ "daily" ];
  };

  system.stateVersion = "26.05";
}
