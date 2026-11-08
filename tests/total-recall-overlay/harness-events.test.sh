#!/usr/bin/env bash
set -euo pipefail

linux='.#nixosConfigurations.fabro-vm.pkgs.total-recall-harness-events'
darwin='.#darwinConfigurations.Brandons-MacBook-Pro.pkgs.total-recall-harness-events'

for package in "$linux" "$darwin"; do
  main_program=$(nix eval --raw "$package.meta.mainProgram")
  test "$main_program" = harness-events
  drv=$(nix eval --raw "$package.drvPath")
  test -n "$drv"
  test -n "$(nix eval --raw "$package.cargoDeps.drvPath")"
  test "$(nix eval --json "$package.doCheck")" = false
  test "$(nix eval --raw --apply 'xs: if builtins.any (x: (x.pname or "") == "protobuf") xs then "yes" else "no"' "$package.nativeBuildInputs")" = yes
  test "$(nix eval --raw --apply 'xs: builtins.concatStringsSep " " xs' "$package.cargoBuildFlags")" = "--package harness-events-cli"
done
