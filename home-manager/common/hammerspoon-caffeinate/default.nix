# Caffeinate consumer of the `home.hammerspoon` framework: a menu-bar-only
# toggle delivered via the framework's `extraConfig` escape hatch, with NO
# keybinding (`keybindings` defaults to `[]`).
#
# The framework renderer emits `extraConfig` into init.lua at load/reload; the
# caffeinate chunk in ./caffeinate.lua is self-contained (its menu-bar item,
# state, and helpers are all chunk-local, defining no global). `enable` is set
# once in ../default.nix; module-merge concatenates this `extraConfig` with the
# mic-mute consumer's into the framework config.
_: {
  home.hammerspoon.extraConfig = builtins.readFile ./caffeinate.lua;
}
