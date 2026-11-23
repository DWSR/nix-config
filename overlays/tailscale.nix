# Pin Tailscale ahead of the stable nixpkgs channel. REMOVE once
# nixpkgs-26.05-darwin packages 1.104.7 (the pinned revision still ships
# 1.104.5): apply this overlay to every host, then drop it from
# overlays/default.nix and the mac-builder/linux-builder module lists.
final: prev:
let
  # Tailscale 1.104.7's go.mod requires Go >= 1.27.4 while the stable pin
  # ships 1.27.3, so build only this package with the upstream 1.27.4
  # toolchain.
  go_1_27_4 = prev.go_1_27.overrideAttrs (_old: {
    version = "1.27.4";

    src = final.fetchurl {
      url = "https://go.dev/dl/go1.27.4.src.tar.gz";
      hash = "sha256-c8+4VxrsDAEXdofbhxY9Rqog6XeWcncokaoXZU2aYJk=";
    };
  });
in
{
  tailscale =
    (prev.tailscale.override {
      buildGo127Module = prev.buildGo127Module.override { go = go_1_27_4; };
    }).overrideAttrs
      (_old: {
        version = "1.104.7";

        src = final.fetchFromGitHub {
          owner = "tailscale";
          repo = "tailscale";
          tag = "v1.104.7";
          hash = "sha256-6bCZpWZY4IYF5Vz/a65naqAa83IIPvmk2yuqet317n8=";
        };

        vendorHash = "sha256-IJ0m56UP0RyMBE5eQeQ082EMJZfvrgE37lfPHE2ujCA=";
      });
}
