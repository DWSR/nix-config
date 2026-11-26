# Manifest derivation for the fabro sandbox flake-input prewarm (issue
# #374). One derivation whose output references every locked flake input
# source, so `system.extraDependencies` pulls the whole set into the guest's
# system closure (a GC root) without installing anything on PATH.
# `passthru.sources` exposes the exact set for tests/fabro-sandbox; the output
# file records the count and apparent size so an operator can audit the added
# closure (`nix path-info -rS`).
#
# `sources` is parameterised so tests/fabro-sandbox/prewarm.test.js can
# evaluate the manifest with fixture sources instead of forcing the real flake
# input closure inside the test build.
{
  pkgs,
  lib,
  sources,
}:
pkgs.runCommand "fabro-sandbox-flake-inputs"
  {
    passthru.sources = sources;
  }
  ''
    {
      echo "fabro-sandbox flake inputs: ${toString (lib.length sources)} locked sources rooted in the guest store"
      for source in ${lib.escapeShellArgs sources}; do
        echo "$source"
      done
      echo "total apparent bytes: $(du -sbc ${lib.escapeShellArgs sources} | tail -n 1 | cut -f 1)"
    } > "$out"
  ''
