# NixOS guest configuration for the fabro Lima VM
# (flake output `nixosConfigurations.fabro-vm`, image
# `packages.aarch64-linux.fabro-vm-image`).
#
# Mirrors upstream nixos-lima's lima.nix base (qcow-efi layout, lima-init +
# guestagent, passwordless-sudo wheel user created from Lima's cidata) with
# the repo's flake nixpkgs instead of the upstream release pin. The VM the
# personal host boots today is the pinned upstream RELEASE image
# (home-manager/common/lima-vm.nix `image` default); this configuration
# matters once a Linux builder exists to build a custom image (then switch
# the module's `image.location` to the store path) or for remote deployment
# into the running instance (`nixos-rebuild --target`). Fabro is not
# configured here yet.
{
  modulesPath,
  pkgs,
  lib,
  ...
}:
{
  imports = [
    (modulesPath + "/profiles/qemu-guest.nix")
    # `system.build.qcow-efi` for packages.aarch64-linux.fabro-vm-image
    # (grows the root partition into the Lima-assigned disk size).
    ./image.nix
  ];

  # lima-init reconfigures the system from Lima's cidata userdata at boot
  # (user, SSH keys, mounts) and runs the lima-guestagent daemon as a
  # systemd service.
  services.lima.enable = true;

  # Guest hostname, matching home-manager/common/lima-vm.nix's
  # `hostname` provision (which covers the upstream release image until
  # this configuration can be built into a custom image / deployed).
  networking.hostName = "fabro";

  # ssh
  services.openssh.enable = true;

  # Lima provisioning scripts run as the cidata user via passwordless sudo.
  security.sudo.wheelNeedsPassword = false;

  # lima-init imperatively adds the user at startup; `users.mutableUsers`
  # must stay true or a `nixos-rebuild` would overwrite that user and break
  # login (upstream documents the same requirement).
  users.mutableUsers = true;

  # Remote deployment into the instance's nix store.
  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    trusted-users = [ "@wheel" ];
  };

  # qcow-efi disk layout: ESP on vda1, root labeled nixos, grown to the
  # Lima `disk` size by autoResize on first boot.
  boot = {
    kernelParams = [ "console=tty0" ];
    kernelPackages = pkgs.linuxPackages_latest;
    loader.grub = {
      device = "nodev";
      efiSupport = true;
      efiInstallAsRemovable = true;
    };
  };
  fileSystems."/boot" = {
    device = lib.mkForce "/dev/vda1"; # /dev/disk/by-label/ESP
    fsType = "vfat";
  };
  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    autoResize = true;
    fsType = "ext4";
    options = [
      "noatime"
      "nodiratime"
      "discard"
    ];
  };

  environment.systemPackages = with pkgs; [
    nextvi # small version of vi
    gitMinimal # minimal version of git
  ];

  system.stateVersion = "26.05";
}
