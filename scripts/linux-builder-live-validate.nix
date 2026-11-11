{ pkgs }:
pkgs.writeShellApplication {
  name = "linux-builder-live-validate";
  runtimeInputs = [
    pkgs.coreutils
    pkgs.gawk
    pkgs.gnugrep
    pkgs.gnused
    pkgs.jq
    pkgs.nix
    pkgs.openssh
  ];
  text = builtins.readFile ./linux-builder-live-validate.sh;
}
