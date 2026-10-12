# qcow-efi image builder for the fabro-vm NixOS guest.
#
# Replicates nix-community/nixos-generators' `qcow-efi` format module
# (which upstreamed into `nixos-rebuild build-image` in NixOS 25.05 and is
# now deprecated there) without the extra flake input: gpt with an ESP on
# vda1 (label ESP, 256M) and an ext4 root on vda2 (label nixos), converted
# to qcow2 with `qemu-img`. `boot.growPartition` + the root filesystem's
# automatic expansion grow into whatever size Lima assigns to the disk at
# instance create time (the module's Lima `disk` setting). Building the
# image needs a Linux builder; the personal host boots the upstream
# nixos-lima release image until one exists.
{
  config,
  lib,
  modulesPath,
  pkgs,
  ...
}:
{
  boot.growPartition = true;

  system.build.qcow-efi = import "${modulesPath}/../lib/make-disk-image.nix" {
    inherit lib config pkgs;
    format = "qcow2";
    partitionTableType = "efi";
    installBootLoader = true;
    copyChannel = false;
  };
}
