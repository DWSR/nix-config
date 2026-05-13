# Lift `pkgs.litestream` from the unstable channel.
#
# The sqlite-backup pipeline depends on Litestream's LTX file backend, which
# requires v0.5.7+ (upstream is v0.5.11 as of 2026-05). nixpkgs-25.11 ships
# v0.3.13, which is affected by benbjohnson/litestream#1037 (silent stall) and
# does not support the LTX format this pipeline relies on. This overlay
# composes after `unstable-packages` (which exposes `pkgs.unstable`), so
# `prev.unstable.litestream` resolves to the unstable-channel build.
_final: prev: {
  inherit (prev.unstable) litestream;
}
