# Pinned-input check for the sandbox image (nix-built-container-for-default-
# fabro-environmen spec, task 7.1; design "Repository Checks → Implementation
# Notes"; requirements 2.2, 2.3, 6.1, 6.2).
#
# The sandbox image is only reproducible if its build inputs are pinned. The
# `nix-snapshotter` flake input is the image builder, so this check reads
# `flake.lock` and fails evaluation unless the `nix-snapshotter` node carries
# both a locked `rev` and a locked `narHash`. A missing node or an unpinned
# (path / git-without-lock) entry aborts with a named message rather than
# letting an unpinned image build.
#
# `lockFile` is a parameter (defaulting to this repository's `flake.lock`) so
# the same function can be evaluated against fixture locks; see
# tests/fabro-sandbox/pinned.test.js.
{
  pkgs,
  lockFile ? ../../flake.lock,
}:
let
  inherit (pkgs) lib;

  lock = builtins.fromJSON (builtins.readFile lockFile);
  node = lock.nodes."nix-snapshotter" or null;
  locked = if node == null then null else node.locked or null;
  rev = if locked == null then null else locked.rev or null;
  narHash = if locked == null then null else locked.narHash or null;
in
assert lib.assertMsg (node != null)
  "fabro-sandbox-pinned: flake.lock has no 'nix-snapshotter' node; the pinned sandbox image input is missing.";
assert lib.assertMsg (rev != null && narHash != null)
  "fabro-sandbox-pinned: the 'nix-snapshotter' flake.lock node is unpinned (missing locked.rev and/or locked.narHash); the sandbox image would not be reproducible.";
pkgs.runCommand "fabro-sandbox-pinned"
  {
    inherit rev narHash;
  }
  ''
    printf 'nix-snapshotter pinned: rev=%s narHash=%s\n' "$rev" "$narHash" > "$out"
  ''
